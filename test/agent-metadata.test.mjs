import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createAgent } from '../src/agent.mjs';
import { fixture } from '../test-support/fixtures.mjs';

const THREAD = '11111111-1111-4111-8111-111111111111';
const INVENTORY = { status: 'available', source: 'app-server', truncated: false,
  sessions: [{ id: THREAD, modified: '2026-10-29T10:00:00.000Z', source: 'app-server' }] };

function setup(t, { auth = 'authenticated', env: additions = {}, initialFailure = false } = {}) {
  const f = fixture(t);
  const environment = { ...f.env, LEVERAGE_LOCAL_READONLY: '0', LEVERAGE_CODEX_METADATA: '1',
    LEVERAGE_SESSION_SOURCE: 'app-server', ...additions };
  const requests = [];
  const controllers = [];
  let time = 0;
  let response = 'ok';
  const agent = createAgent({ env: environment, now: () => time, controlFactory: settings => {
    let failed = initialFailure && controllers.length === 0;
    const controller = { closes: 0, settings, calls: [],
      async accountStatus() { controller.calls.push('account/read'); return { status: failed ? 'unavailable' : auth }; },
      async listSessions() { controller.calls.push('thread/list'); return failed
        ? { ...INVENTORY, status: 'unavailable', sessions: [] } : INVENTORY; },
      recoveryState: () => ({ recoverable: failed, errorCode: failed ? 'codex-unavailable' : null }),
      run() { assert.fail('Metadata-only agent must never execute any turn.'); },
      async close() { controller.closes++; failed = false; }
    };
    controllers.push(controller);
    return controller;
  }, fetchImpl: async (url, options) => {
    requests.push({ path: new URL(url).pathname, authorization: options.headers.Authorization,
      body: options.body ? JSON.parse(options.body) : undefined });
    if (response === 'network') throw new Error('Synthetic connection failure.');
    return { ok: response !== 'revoked', status: response === 'revoked' ? 401 : 200,
      // Even an unsolicited job in a heartbeat response cannot start execution.
      json: async () => ({ job: { id: 'unrequested-synthetic-job', mode: 'new', confirmed: true } }) };
  } });
  t.after(() => agent.close());
  return { ...f, agent, environment, requests, controllers,
    respond: value => { response = value; }, advance: milliseconds => { time += milliseconds; } };
}

test('metadata-only agent publishes local authentication and workspace without claim or execution capability', async t => {
  for (const auth of ['authenticated', 'not-authenticated', 'unavailable']) {
    const f = setup(t, { auth });
    await f.agent.tick();
    await f.agent.tick();
    assert.equal(f.controllers.length, 1, 'the metadata process is reused');
    assert.deepEqual(f.controllers[0].calls, ['account/read', 'thread/list', 'account/read', 'thread/list']);
    assert.deepEqual(f.requests.map(request => request.path), ['/api/agent/heartbeat', '/api/agent/heartbeat']);
    const heartbeat = f.requests[0].body;
    assert.equal(heartbeat.codexAuth, auth);
    assert.equal(heartbeat.codexMetadata, true);
    assert.equal(heartbeat.localControl, false);
    assert.equal(heartbeat.executionMode, 'inventory-only');
    assert.equal(heartbeat.workspaceBinding, null);
    assert.deepEqual(heartbeat.workspaces, [{ id: 'project', label: 'workspace' }]);
    assert.equal(heartbeat.sessions[0].id, THREAD);
    assert.equal(JSON.stringify(heartbeat).includes(f.workspace), false);
    assert.equal(JSON.stringify(heartbeat).includes(f.home), false);
    await f.agent.close();
    assert.equal(f.controllers[0].closes, 1);
  }
});

test('metadata-only reconnect keeps the same identity and credentials without replaying executable work', async t => {
  const f = setup(t);
  await f.agent.tick();
  f.respond('network');
  await assert.rejects(f.agent.tick(), /Synthetic connection/);
  assert.equal(f.controllers[0].closes, 0);
  f.respond('ok');
  await f.agent.tick();
  assert.equal(f.controllers.length, 1);
  for (const request of f.requests) {
    assert.equal(request.body.deviceId, f.device.deviceId);
    assert.equal(request.authorization, 'Bearer ' + f.agentToken);
    assert.equal(request.path, '/api/agent/heartbeat');
  }
});

test('revocation permanently stops metadata polling and closes only the owned controller', async t => {
  const f = setup(t);
  await f.agent.tick();
  f.respond('revoked');
  await assert.rejects(f.agent.tick(), /HTTP 401/);
  f.respond('ok');
  await assert.rejects(f.agent.tick(), /restart/);
  await f.agent.close();
  assert.equal(f.controllers[0].closes, 1);
  assert.equal(f.requests.length, 2);
});

test('metadata-only transient recovery reuses the original authorized workspace and never starts a turn', async t => {
  const f = setup(t, { initialFailure: true });
  await f.agent.tick();
  assert.equal(f.requests.at(-1).body.codexAuth, 'unavailable');
  f.environment.LEVERAGE_WORKSPACE = f.home;
  f.environment.LEVERAGE_LOCAL_READONLY = '1';
  f.advance(5000);
  await f.agent.tick();
  assert.equal(f.controllers.length, 2);
  assert.equal(f.controllers[0].closes, 1);
  assert.deepEqual(f.controllers[1].settings, f.controllers[0].settings);
  assert.equal(f.controllers[1].settings.workspace, f.workspace);
  assert.equal(f.requests.at(-1).body.codexAuth, 'authenticated');
  assert.ok(f.requests.every(request => request.path === '/api/agent/heartbeat'));
});

test('metadata-only mode requires an explicit workspace and App Server source while the legacy live switch stays blocked', t => {
  const f = fixture(t);
  for (const changes of [{ LEVERAGE_WORKSPACE: undefined }, { LEVERAGE_WORKSPACE: path.join(f.root, 'missing') },
    { LEVERAGE_SESSION_SOURCE: 'files' }]) {
    assert.throws(() => createAgent({ env: { ...f.env, LEVERAGE_CODEX_METADATA: '1', LEVERAGE_SESSION_SOURCE: 'app-server', ...changes },
      controlFactory: () => assert.fail('Invalid metadata options cannot create a controller.') }), /workspace|App Server/);
  }
  const agent = createAgent({ env: { ...f.env, LEVERAGE_CODEX_METADATA: '1', LEVERAGE_ENABLE_LIVE_CODEX: '1' },
    controlFactory: () => assert.fail('The legacy live flag cannot create any controller.') });
  return agent.close();
});

test('workspace presentation respects label privacy and never discloses an unsafe basename', async t => {
  const hidden = setup(t, { env: { LEVERAGE_REPORT_PROJECT: '0' } });
  await hidden.agent.tick();
  assert.deepEqual(hidden.requests[0].body.workspaces, [{ id: 'project', label: 'project' }]);
  const f = fixture(t);
  const workspace = path.join(f.root, 'unsafe@workspace');
  fs.mkdirSync(workspace);
  const unsafe = setup(t, { env: { LEVERAGE_WORKSPACE: workspace } });
  await unsafe.agent.tick();
  assert.deepEqual(unsafe.requests[0].body.workspaces, [{ id: 'project', label: 'project' }]);
});
