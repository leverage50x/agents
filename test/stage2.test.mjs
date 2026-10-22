import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { createCredentialStore } from '../src/credentials.mjs';
import { createHub } from '../src/hub.mjs';
import { createAgent } from '../src/agent.mjs';

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leverage-stage2-'));
  const operator = randomBytes(32).toString('hex');
  const store = createCredentialStore({ file: path.join(root, 'agents.json') });
  let now = Date.now();
  const server = createHub({ token: operator, credentialStore: store, now: () => now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  async function call(endpoint, { token = operator, method = 'GET', body } = {}) {
    const r = await fetch(url + endpoint, {
      method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error',
      signal: AbortSignal.timeout(3000)
    });
    return { status: r.status, body: await r.json() };
  }
  function device(credential, index) {
    const home = path.join(root, 'codex-' + index);
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    fs.writeFileSync(path.join(home, 'sessions', 'rollout-' + id + '.jsonl'), 'SYNTHETIC_TRANSCRIPT_NEVER_COLLECT');
    const env = { LEVERAGE_AGENT_ID: credential.deviceId, LEVERAGE_AGENT_TOKEN: credential.token,
      LEVERAGE_DEVICE: credential.name, LEVERAGE_CODEX_HOME: home, LEVERAGE_SESSION_SOURCE: 'files',
      LEVERAGE_URL: url, LEVERAGE_WORKSPACE: root };
    return { agent: createAgent({ env }), env, home };
  }
  return { store, call, operator, root, url, server, device, advance: ms => { now += ms; } };
}

test('two authenticated agents with identical names remain distinct, reconnect and expire independently', async t => {
  const f = await setup(t);
  const a = f.store.enroll('Laptop');
  const b = f.store.enroll('Laptop');
  const first = f.device(a, 1), second = f.device(b, 2);
  assert.notEqual(first.agent.deviceId, second.agent.deviceId);
  await Promise.all([first.agent.tick(), second.agent.tick()]);
  let state = (await f.call('/api/state')).body;
  assert.equal(state.devices.length, 2);
  assert.equal(state.devices.every(d => d.online && d.name === 'Laptop'), true);
  assert.equal(state.devices.every(d => d.sessions[0].activity === 'discovered'), true);
  assert.equal(state.devices.every(d => !d.sessions[0].lastActivity && !d.sessions[0].project), true);
  for (const secret of [a.token, b.token, f.operator, 'SYNTHETIC_TRANSCRIPT_NEVER_COLLECT']) {
    assert.equal(JSON.stringify(state).includes(secret), false);
  }
  f.advance(15000);
  state = (await f.call('/api/state')).body;
  assert.equal(state.devices.every(d => !d.online), true);
  const reconnected = createAgent({ env: first.env });
  assert.equal(reconnected.deviceId, a.deviceId);
  await reconnected.tick();
  state = (await f.call('/api/state')).body;
  assert.equal(state.devices.find(d => d.id === a.deviceId).online, true);
  assert.equal(state.devices.find(d => d.id === b.deviceId).online, false);
});

test('credential roles and bound identities reject admin access, spoofing and revoked reconnects', async t => {
  const f = await setup(t);
  const a = f.store.enroll('Laptop'), b = f.store.enroll('Laptop');
  const first = f.device(a, 1), second = f.device(b, 2);
  await Promise.all([first.agent.tick(), second.agent.tick()]);
  assert.equal((await f.call('/api/state', { token: 'invalid-credential' })).status, 401);
  for (const endpoint of ['/api/state', '/api/admin/agents', '/api/admin/agents/revoke', '/api/task', '/api/task/approve', '/api/task/reject']) {
    const r = await f.call(endpoint, { token: a.token, method: endpoint === '/api/state' ? 'GET' : 'POST', body: endpoint === '/api/state' ? undefined : {} });
    assert.equal(r.status, 403, endpoint);
  }
  assert.equal((await f.call('/api/agent/heartbeat', { method: 'POST', body: {} })).status, 403);
  assert.equal((await f.call('/api/agent/task?deviceId=' + a.deviceId)).status, 403);
  assert.equal((await f.call('/api/agent/heartbeat', { token: a.token, method: 'POST', body: {
    deviceId: b.deviceId, name: 'Laptop', platform: 'linux'
  } })).status, 403);
  assert.equal((await f.call('/api/agent/task?deviceId=' + b.deviceId, { token: a.token })).status, 403);
  assert.equal((await f.call('/api/agent/result', { token: a.token, method: 'POST', body: { deviceId: b.deviceId } })).status, 403);
  const created = await f.call('/api/task', { method: 'POST', body: { deviceId: a.deviceId, prompt: 'DEMO remains gated' } });
  assert.equal(created.status, 201);
  assert.equal((await f.call('/api/admin/agents/revoke', { method: 'POST', body: { deviceId: a.deviceId } })).status, 200);
  await assert.rejects(first.agent.tick(), /HTTP 401/);
  await second.agent.tick();
  const state = (await f.call('/api/state')).body;
  assert.equal(state.devices.find(d => d.id === a.deviceId).online, false);
  assert.ok(state.devices.find(d => d.id === a.deviceId).revokedAt);
  assert.equal(state.devices.find(d => d.id === b.deviceId).online, true);
  assert.equal(state.jobs.find(j => j.id === created.body.job.id).status, 'rejected');
  const replacement = await f.call('/api/admin/agents', { method: 'POST', body: { name: 'Laptop' } });
  assert.equal(replacement.status, 201);
  assert.notEqual(replacement.body.deviceId, a.deviceId);
  assert.notEqual(replacement.body.token, a.token);
  await f.device(replacement.body, 3).agent.tick();
  assert.equal((await f.call('/api/state')).body.devices.length, 3);
});

test('an active or revoked agent token cannot be configured as an operator credential', () => {
  const store = createCredentialStore();
  const agent = store.enroll('Laptop');
  assert.throws(() => createHub({ token: agent.token, credentialStore: store }), /separate/);
  store.revoke(agent.deviceId);
  assert.throws(() => createHub({ token: agent.token, credentialStore: store }), /separate/);
});

test('revocation during a streamed heartbeat is checked again before accepting inventory', async t => {
  const f = await setup(t);
  const enrolled = f.store.enroll('Laptop');
  const req = new PassThrough();
  req.method = 'POST'; req.url = '/api/agent/heartbeat';
  req.headers = { authorization: 'Bearer ' + enrolled.token };
  const response = new Promise(resolve => f.server.emit('request', req, {
    destroyed: false, writableEnded: false,
    writeHead(status) { this.status = status; },
    end() { this.writableEnded = true; resolve(this.status); }
  }));
  f.store.revoke(enrolled.deviceId);
  req.end(JSON.stringify({ deviceId: enrolled.deviceId, name: 'Laptop', platform: 'linux' }));
  assert.equal(await response, 401);
  assert.equal((await f.call('/api/state')).body.devices.length, 0);
});

test('inventory strips private fields and refuses fabricated activity or mtime-based last activity', async t => {
  const f = await setup(t);
  const agent = f.store.enroll('Laptop');
  const session = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', modified: '2026-10-22T01:00:00Z',
    lastActivity: '2026-10-22T01:00:00Z', source: 'app-server', activity: 'active-confirmed',
    project: 'personal-project', preview: 'SYNTHETIC_PRIVATE_PREVIEW', turns: ['SYNTHETIC_PRIVATE_TURN'] };
  const heartbeat = { deviceId: agent.deviceId, name: 'Laptop', platform: 'linux', sessions: [session],
    sessionInventory: { status: 'available', truncated: false, source: 'app-server' } };
  assert.equal((await f.call('/api/agent/heartbeat', { token: agent.token, method: 'POST', body: heartbeat })).status, 200);
  let state = (await f.call('/api/state')).body;
  assert.equal(state.devices[0].sessions[0].activity, 'discovered');
  assert.equal(state.devices[0].sessions[0].project, 'personal-project');
  assert.equal(state.devices[0].sessions[0].lastActivity, '2026-10-22T01:00:00.000Z');
  assert.equal(JSON.stringify(state).includes('SYNTHETIC_PRIVATE_'), false);
  heartbeat.sessions = [{ ...session, source: 'files', project: '/private/absolute/path' }];
  heartbeat.sessionInventory = { status: 'available', truncated: false, source: 'files', reason: 'app-server-incompatible' };
  await f.call('/api/agent/heartbeat', { token: agent.token, method: 'POST', body: heartbeat });
  state = (await f.call('/api/state')).body;
  assert.equal(state.devices[0].sessions[0].lastActivity, undefined);
  assert.equal(state.devices[0].sessions[0].project, undefined);
  assert.equal(state.devices[0].sessionInventory.reason, 'app-server-incompatible');
  assert.equal((await f.call('/api/admin/agents', { method: 'POST', body: { name: 'bad\nname' } })).status, 400);
});
