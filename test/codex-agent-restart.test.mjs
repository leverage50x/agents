import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { createAgent } from '../src/agent.mjs';
import { createHub } from '../src/hub.mjs';
import { fixture, dispatch } from '../test-support/fixtures.mjs';

const THREAD = '11111111-1111-4111-8111-111111111111';

function setup(t, descriptions = [], options = {}) {
  const f = fixture(t);
  let clock = 0;
  let agentStatus = 200;
  const controllers = [];
  const factoryCalls = [];
  const requests = [];
  const server = createHub({ token: f.token, credentialStore: f.store, now: () => clock,
    localControl: { deviceId: f.device.deviceId, workspace: f.workspace } });
  const environment = { ...f.env, LEVERAGE_LOCAL_READONLY: '1', LEVERAGE_RECOVERY_DELAY_MS: '0' };
  const agent = createAgent({ env: environment, now: () => clock, ...options,
    controlFactory: settings => {
      const index = factoryCalls.length;
      factoryCalls.push({ workspace: settings.workspace, home: settings.home });
      const description = (typeof descriptions === 'function' ? descriptions(index) : descriptions[index]) || {};
      if (description.factoryThrows) throw new Error('Synthetic factory failure.');
      let recovery = { recoverable: false, errorCode: null };
      let firstAccount = true;
      let finish;
      let onEvent;
      const controller = {
        accounts: 0, inventories: 0, closes: 0, jobs: [],
        fail(recoverable, errorCode = 'codex-unavailable') { recovery = { recoverable, errorCode }; },
        async accountStatus() {
          controller.accounts++;
          if (firstAccount && description.initialFailure) {
            controller.fail(description.initialFailure !== 'terminal', description.errorCode || 'codex-unavailable');
          }
          firstAccount = false;
          return { status: recovery.errorCode ? 'unavailable' : 'authenticated' };
        },
        async listSessions() {
          controller.inventories++;
          return { status: recovery.errorCode ? 'unavailable' : 'available', truncated: false, source: 'app-server',
            sessions: recovery.errorCode ? [] : [{ id: THREAD, modified: '2026-10-25T10:00:00.000Z', source: 'app-server' }] };
        },
        run(job, callback) {
          controller.jobs.push(job.id);
          onEvent = callback;
          if (description.pending) return new Promise(resolve => { finish = resolve; });
          return Promise.resolve({ status: 'completed', output: 'Synthetic read-only result.', threadId: THREAD });
        },
        finish(result) { finish?.(result); },
        emit(event) { onEvent?.(event); },
        async close() {
          controller.closes++;
          recovery = { recoverable: false, errorCode: 'codex-closed' };
          if (description.closeRejects) throw new Error('Synthetic close failure.');
          await description.closeGate;
          finish?.({ status: 'interrupted', output: 'Synthetic cleanup.' });
        }
      };
      if (!description.noRecoveryState) controller.recoveryState = () => ({ ...recovery });
      controllers.push(controller);
      return controller;
    },
    fetchImpl: async (url, request) => {
      const parsed = new URL(url);
      const body = request.body === undefined ? undefined : JSON.parse(request.body);
      requests.push({ path: parsed.pathname, ...(body === undefined ? {} : { body }) });
      if (agentStatus !== 200) return { status: agentStatus, ok: false, json: async () => ({ error: 'Synthetic rejection.' }) };
      const result = await dispatch(server, '', { endpoint: parsed.pathname + parsed.search, method: request.method,
        authorization: request.headers.Authorization, ...(body === undefined ? {} : { body }) });
      return { status: result.status, ok: result.status < 400, json: async () => result.body };
    }
  });
  t.after(async () => {
    for (const controller of controllers) controller.finish({ status: 'interrupted', output: 'Synthetic cleanup.' });
    await agent.close();
  });
  return { ...f, environment, agent, controllers, factoryCalls, requests,
    advance: milliseconds => { clock += milliseconds; },
    rejectAgent: status => { agentStatus = status; },
    state: async () => (await dispatch(server, f.token)).body,
    propose: () => dispatch(server, f.token, { method: 'POST', endpoint: '/api/local/task', body: {
      deviceId: f.device.deviceId, mode: 'new', threadId: null, workspaceId: 'project',
      prompt: 'Inspect the synthetic README without changing files.', confirmed: true
    } }) };
}

test('idle transient failure replaces the controller after backoff and restores authenticated inventory with immutable configuration', async t => {
  const f = setup(t);
  await f.agent.tick();
  assert.equal((await f.state()).devices[0].codexAuth, 'authenticated');
  f.controllers[0].fail(true);
  await f.agent.tick();
  let state = await f.state();
  assert.equal(state.devices[0].online, true);
  assert.equal(state.devices[0].codexAuth, 'unavailable');
  assert.equal(state.devices[0].sessions.length, 0);
  f.environment.LEVERAGE_WORKSPACE = f.home;
  f.environment.LEVERAGE_CODEX_HOME = f.workspace;
  f.environment.LEVERAGE_AGENT_TOKEN = 'invalid-synthetic-replacement';
  f.advance(4999);
  await f.agent.tick();
  assert.equal(f.factoryCalls.length, 1);
  f.advance(1);
  await f.agent.tick();
  assert.equal(f.factoryCalls.length, 2);
  assert.equal(f.controllers[0].closes, 1);
  assert.deepEqual(f.factoryCalls[1], f.factoryCalls[0]);
  state = await f.state();
  assert.equal(state.devices[0].id, f.device.deviceId);
  assert.equal(state.devices[0].codexAuth, 'authenticated');
  assert.equal(state.devices[0].sessionInventory.status, 'available');
  assert.equal(state.devices[0].sessions[0].id, THREAD);
  assert.ok(f.controllers.every(controller => controller.jobs.length === 0));
});

test('initial transient startup failure recovers through a new factory without starting a turn', async t => {
  const f = setup(t, [{ initialFailure: 'transient' }]);
  await f.agent.tick();
  assert.equal((await f.state()).devices[0].codexAuth, 'unavailable');
  f.advance(5000);
  await f.agent.tick();
  assert.equal(f.factoryCalls.length, 2);
  assert.equal((await f.state()).devices[0].codexAuth, 'authenticated');
  assert.ok(f.controllers.every(controller => controller.jobs.length === 0));
});

test('repeated transient failures use bounded 5, 10, 20 and 30 second backoff independent of environment input', async t => {
  const f = setup(t, () => ({ initialFailure: 'transient' }));
  await f.agent.tick();
  let expected = 1;
  for (const delay of [5000, 10000, 20000, 30000, 30000]) {
    f.advance(delay - 1);
    await f.agent.tick();
    assert.equal(f.factoryCalls.length, expected);
    f.advance(1);
    await f.agent.tick();
    assert.equal(f.factoryCalls.length, ++expected);
  }
  assert.ok(f.controllers.slice(0, -1).every(controller => controller.closes === 1));
});

test('policy failures, approval denial, explicit close and missing recovery diagnostics never restart a controller', async t => {
  for (const errorCode of ['approval-denied', 'codex-policy-mismatch', 'codex-version-unsupported']) {
    const f = setup(t, [{ initialFailure: 'terminal', errorCode }]);
    await f.agent.tick();
    f.advance(1000000);
    await f.agent.tick();
    assert.equal(f.factoryCalls.length, 1);
  }
  const legacy = setup(t, [{ noRecoveryState: true }]);
  await legacy.agent.tick();
  legacy.controllers[0].fail(true);
  legacy.advance(1000000);
  await legacy.agent.tick();
  assert.equal(legacy.factoryCalls.length, 1);
  const closed = setup(t);
  await closed.agent.tick();
  await closed.agent.close();
  closed.advance(1000000);
  await assert.rejects(closed.agent.tick(), /restart/);
  assert.equal(closed.factoryCalls.length, 1);
});

test('Hub authentication rejection stays permanently closed even if a controller previously reported recoverable failure', async t => {
  for (const status of [401, 403]) {
    const f = setup(t);
    await f.agent.tick();
    f.controllers[0].fail(true);
    f.rejectAgent(status);
    await assert.rejects(f.agent.tick(), /HTTP/);
    f.advance(1000000);
    await assert.rejects(f.agent.tick(), /restart/);
    assert.equal(f.factoryCalls.length, 1);
    await f.agent.close();
    assert.equal(f.controllers[0].closes, 1);
  }
});

test('recovery waits for the previous controller to close fully before constructing its replacement', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = setup(t, [{ closeGate: gate }]);
  await f.agent.tick();
  f.controllers[0].fail(true);
  await f.agent.tick();
  f.advance(5000);
  const pending = f.agent.tick();
  await immediate();
  assert.equal(f.controllers[0].closes, 1);
  assert.equal(f.factoryCalls.length, 1);
  release();
  await pending;
  assert.equal(f.factoryCalls.length, 2);
});

test('failed turns are never replayed, recovery is idle-only and late callbacks cannot poison a new explicitly approved turn', async t => {
  const f = setup(t, [{ pending: true }, { pending: true }]);
  await f.agent.tick();
  const oldJob = (await f.propose()).body.job.id;
  await f.agent.tick();
  f.controllers[0].fail(true);
  f.advance(5000);
  await f.agent.tick();
  assert.equal(f.factoryCalls.length, 1, 'an active turn cannot be replaced');
  f.controllers[0].finish({ status: 'failed', output: '', errorCode: 'codex-unavailable' });
  await f.agent.waitForIdle();
  assert.equal((await f.state()).readonlyJobs[0].status, 'failed');
  await f.agent.tick();
  f.advance(5000);
  await f.agent.tick();
  assert.equal(f.factoryCalls.length, 2);
  assert.equal(f.controllers[1].jobs.length, 0, 'recovery does not replay the failed instruction');
  assert.equal((await f.state()).readonlyJobs[0].id, oldJob);
  const newJob = (await f.propose()).body.job.id;
  assert.notEqual(newJob, oldJob);
  await f.agent.tick();
  assert.deepEqual(f.controllers[1].jobs, [newJob]);
  const updates = f.requests.filter(request => request.path === '/api/agent/local/update').length;
  f.controllers[0].emit({ type: 'progress', message: 'Late old-controller callback.' });
  await immediate();
  assert.equal(f.requests.filter(request => request.path === '/api/agent/local/update').length, updates);
  assert.equal(f.controllers[1].closes, 0);
  f.controllers[1].finish({ status: 'completed', output: 'New explicitly approved synthetic result.', threadId: THREAD });
  await f.agent.waitForIdle();
  const state = await f.state();
  assert.equal(state.readonlyJobs.find(job => job.id === oldJob).status, 'failed');
  assert.equal(state.readonlyJobs.find(job => job.id === newJob).status, 'completed');
});

test('a replacement factory throw or failure to close the old controller stops recovery permanently', async t => {
  for (const descriptions of [
    [{ closeRejects: true }], [{}, { factoryThrows: true }]
  ]) {
    const f = setup(t, descriptions);
    await f.agent.tick();
    f.controllers[0].fail(true);
    await f.agent.tick();
    f.advance(5000);
    await assert.rejects(f.agent.tick(), /restart/);
    const attempts = f.factoryCalls.length;
    f.advance(1000000);
    await assert.rejects(f.agent.tick(), /restart/);
    assert.equal(f.factoryCalls.length, attempts);
    assert.equal(f.controllers[0].closes, 1);
  }
});

test('programmatic recovery timing is bounded and cannot be changed through dashboard or environment values', t => {
  const f = fixture(t);
  for (const recoveryDelayMs of [0, 49, 30001, NaN, '5000']) {
    assert.throws(() => createAgent({ env: f.env, recoveryDelayMs }), /recovery configuration/);
  }
  assert.throws(() => createAgent({ env: f.env, now: 0 }), /recovery configuration/);
});
