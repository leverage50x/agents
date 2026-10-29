import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { createHub } from '../src/hub.mjs';
import { createAgent } from '../src/agent.mjs';
import { createCredentialStore } from '../src/credentials.mjs';

const threadIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

async function pilot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leverage-pilot-test-'));
  const registry = path.join(root, 'agents.json');
  const store = createCredentialStore({ file: registry });
  const operator = randomBytes(32).toString('hex');
  const devices = [store.enroll('Laptop'), store.enroll('Laptop')].map((credentials, index) => {
    const workspace = path.join(root, 'workspace-' + (index + 1));
    const home = path.join(root, 'codex-' + (index + 1));
    fs.mkdirSync(workspace); fs.mkdirSync(home);
    return { credentials, workspace, home, index };
  });
  let time = Date.now();
  const server = createHub({ token: operator, credentialStore: store, now: () => time,
    localControl: { deviceId: devices[0].credentials.deviceId, workspace: devices[0].workspace } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const agents = [];
  t.after(async () => {
    await Promise.all(agents.map(agent => agent.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function call(endpoint, { token = operator, method = 'GET', body } = {}) {
    const response = await fetch(url + endpoint, { method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(3000), redirect: 'error' });
    return { status: response.status, body: await response.json() };
  }
  function connect(device) {
    const seen = { run: 0, claims: 0, account: 0, sessions: 0 };
    const env = { LEVERAGE_AGENT_ID: device.credentials.deviceId, LEVERAGE_AGENT_TOKEN: device.credentials.token,
      LEVERAGE_DEVICE: device.credentials.name, LEVERAGE_WORKSPACE: device.workspace, LEVERAGE_CODEX_HOME: device.home,
      LEVERAGE_URL: url, LEVERAGE_SESSION_SOURCE: 'app-server', LEVERAGE_CODEX_METADATA: '1',
      LEVERAGE_LOCAL_READONLY: device.index === 0 ? '1' : '0' };
    const agent = createAgent({ env, now: () => time,
      fetchImpl: (input, options) => {
        if (new URL(input).pathname === '/api/agent/local/task') seen.claims++;
        return fetch(input, options);
      },
      controlFactory: options => {
        assert.equal(options.workspace, device.workspace);
        assert.equal(options.home, device.home);
        return {
          accountStatus: async () => { seen.account++; return { status: 'authenticated' }; },
          listSessions: async () => {
            seen.sessions++;
            return { status: 'available', source: 'app-server', truncated: false,
              sessions: [{ id: threadIds[device.index], source: 'app-server', modified: '2026-10-29T01:00:00Z',
                lastActivity: '2026-10-29T01:00:00Z', project: path.basename(device.workspace),
                title: 'Synthetic laptop ' + (device.index + 1), eligibility: 'discovered' }] };
          },
          run: async () => { seen.run++; throw new Error('Inventory pilot must not execute.'); },
          close: async () => {}
        };
      } });
    agents.push(agent);
    return { agent, seen, env };
  }
  return { root, registry, store, devices, connect, call, operator, advance: milliseconds => { time += milliseconds; } };
}

test('pilot uses two isolated agent identities, Codex metadata and workspace/session inventories over real HTTP', async t => {
  const f = await pilot(t);
  const first = f.connect(f.devices[0]), second = f.connect(f.devices[1]);
  await Promise.all([first.agent.tick(), second.agent.tick()]);
  const state = (await f.call('/api/state')).body;
  assert.equal(state.devices.length, 2);
  for (const device of f.devices) {
    const row = state.devices.find(item => item.id === device.credentials.deviceId);
    assert.equal(row.online, true);
    assert.equal(row.name, 'Laptop');
    assert.equal(row.codexAuth, 'authenticated');
    assert.deepEqual(row.sessions.map(item => item.id), [threadIds[device.index]]);
    assert.deepEqual(row.workspaces, [{ id: 'project', label: path.basename(device.workspace) }]);
    const self = await f.call('/api/agent/status', { token: device.credentials.token });
    assert.equal(self.status, 200);
    assert.equal(self.body.deviceId, device.credentials.deviceId);
    assert.equal(self.body.online, true);
    assert.equal(self.body.codexAuth, 'authenticated');
    assert.deepEqual(self.body.workspaces, row.workspaces);
    assert.equal(self.body.sessionInventory.status, 'available');
    assert.equal(Object.hasOwn(self.body, 'agents'), false);
    assert.equal(Object.hasOwn(self.body, 'devices'), false);
    assert.equal(Object.hasOwn(self.body, 'workspaceBinding'), false);
  }
  assert.equal(state.devices.find(item => item.id === f.devices[1].credentials.deviceId).localControl, false);
  assert.equal(state.devices.find(item => item.id === f.devices[1].credentials.deviceId).executionMode, 'inventory-only');
  assert.equal(first.seen.run + second.seen.run, 0);
  assert.equal(second.seen.claims, 0);
  assert.ok(second.seen.account > 0 && second.seen.sessions > 0);
  for (const secret of [f.operator, ...f.devices.map(device => device.credentials.token), ...f.devices.map(device => device.workspace)]) {
    assert.equal(JSON.stringify(state).includes(secret), false);
  }
  f.advance(15000);
  assert.equal((await f.call('/api/state')).body.devices.every(item => !item.online), true);
  assert.equal((await f.call('/api/agent/status', { token: f.devices[1].credentials.token })).body.online, false);
  await first.agent.close();
  const reconnected = f.connect(f.devices[0]);
  await reconnected.agent.tick();
  const reconnect = (await f.call('/api/state')).body;
  assert.equal(reconnected.agent.deviceId, first.agent.deviceId);
  assert.equal(reconnect.devices.find(item => item.id === first.agent.deviceId).online, true);
  assert.equal(reconnect.devices.find(item => item.id === second.agent.deviceId).online, false);
  await second.agent.tick();
  assert.equal((await f.call('/api/state')).body.devices.every(item => item.online), true);
});

test('pilot agent credentials cannot read another device, administer Hub or self-authorize remote execution', async t => {
  const f = await pilot(t);
  const first = f.connect(f.devices[0]), second = f.connect(f.devices[1]);
  await Promise.all([first.agent.tick(), second.agent.tick()]);
  const [primary, secondary] = f.devices;
  const token = secondary.credentials.token;
  assert.equal((await f.call('/api/agent/status', { token: 'invalid-synthetic-credential' })).status, 401);
  assert.equal((await f.call('/api/agent/status')).status, 403);
  assert.equal((await f.call('/api/agent/status?deviceId=' + primary.credentials.deviceId, { token })).status, 403);
  for (const endpoint of ['/api/state', '/api/admin/agents', '/api/admin/agents/revoke', '/api/local/task']) {
    assert.equal((await f.call(endpoint, { token, method: endpoint === '/api/state' ? 'GET' : 'POST',
      ...(endpoint === '/api/state' ? {} : { body: {} }) })).status, 403, endpoint);
  }
  const forged = { deviceId: secondary.credentials.deviceId, name: 'Laptop', platform: 'linux',
    localControl: true, codexMetadata: true, codexAuth: 'authenticated', workspaceReady: true,
    workspaceBinding: createHash('sha256').update(fs.realpathSync(primary.workspace)).digest('hex'),
    workspaces: [{ id: 'project', label: path.basename(primary.workspace), path: primary.workspace }],
    sessions: [{ id: threadIds[0], modified: '2026-10-29T01:00:00Z', source: 'app-server' }] };
  assert.equal((await f.call('/api/agent/heartbeat', { token, method: 'POST', body: { ...forged, deviceId: primary.credentials.deviceId } })).status, 403);
  const reported = await f.call('/api/agent/heartbeat', { token, method: 'POST', body: forged });
  assert.equal(reported.status, 200);
  const remote = (await f.call('/api/state')).body.devices.find(item => item.id === secondary.credentials.deviceId);
  assert.equal(remote.localControl, false);
  assert.equal(remote.executionMode, 'inventory-only');
  assert.equal(JSON.stringify(remote).includes(primary.workspace), false);
  assert.deepEqual(remote.workspaces, [{ id: 'project', label: path.basename(primary.workspace) }]);
  assert.equal(Object.hasOwn(remote, 'workspaceBinding'), false);
  for (const workspaces of [[{ id: 'project', label: '/synthetic/private' }],
    [{ id: 'other', label: 'other' }], [{ id: 'project', label: 'one' }, { id: 'project', label: 'two' }]]) {
    assert.equal((await f.call('/api/agent/heartbeat', { token, method: 'POST', body: { ...forged, workspaces } })).status, 400);
  }
  assert.equal((await f.call('/api/local/task', { method: 'POST', body: {
    deviceId: secondary.credentials.deviceId, confirmed: true, mode: 'new', workspaceId: 'project', prompt: 'Synthetic analysis.'
  } })).status, 400);
  for (const deviceId of [primary.credentials.deviceId, secondary.credentials.deviceId]) {
    assert.equal((await f.call('/api/agent/local/task?deviceId=' + deviceId, { token })).status, 403);
  }
  assert.equal((await f.call('/api/agent/local/update', { token, method: 'POST', body: {
    deviceId: primary.credentials.deviceId, status: 'completed', output: 'Synthetic unsolicited result.'
  } })).status, 403);
  assert.deepEqual((await f.call('/api/state')).body.readonlyJobs, []);
  assert.equal(second.seen.run, 0);
});

test('pilot revocation survives registry reload and prevents secondary reconnect without disturbing primary', async t => {
  const f = await pilot(t);
  const first = f.connect(f.devices[0]), second = f.connect(f.devices[1]);
  await Promise.all([first.agent.tick(), second.agent.tick()]);
  const secondary = f.devices[1].credentials;
  assert.equal((await f.call('/api/admin/agents/revoke', { method: 'POST', body: { deviceId: secondary.deviceId } })).status, 200);
  assert.equal((await f.call('/api/agent/status', { token: secondary.token })).status, 401);
  await assert.rejects(second.agent.tick(), /HTTP 401/);
  const reloaded = createCredentialStore({ file: f.registry });
  assert.equal(reloaded.authenticate(secondary.token), null);
  const reconnect = f.connect(f.devices[1]);
  await assert.rejects(reconnect.agent.tick(), /HTTP 401/);
  await first.agent.tick();
  const state = (await f.call('/api/state')).body;
  assert.equal(state.devices.find(item => item.id === first.agent.deviceId).online, true);
  assert.equal(state.devices.find(item => item.id === secondary.deviceId).online, false);
  assert.ok(state.devices.find(item => item.id === secondary.deviceId).revokedAt);
  assert.equal(reconnect.seen.run + second.seen.run, 0);
});
