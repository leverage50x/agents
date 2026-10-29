import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHub } from '../src/hub.mjs';
import { createAgent } from '../src/agent.mjs';
import { fixture, dispatch } from '../test-support/fixtures.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const busyThreadId = '22222222-2222-4222-8222-222222222222';
const foreignThreadId = '33333333-3333-4333-8333-333333333333';
const session = (id = threadId, eligibility = 'discovered') => ({
  id, modified: '2026-10-23T10:00:00.000Z', source: 'app-server', eligibility
});

function setup(t, { now = Date.now, enabled = true } = {}) {
  const f = fixture(t);
  const other = f.store.enroll('synthetic-device');
  const server = createHub({ token: f.token, credentialStore: f.store, now,
    ...(enabled ? { localControl: { deviceId: f.device.deviceId, workspace: f.workspace } } : {}) });
  const operator = input => dispatch(server, f.token, input);
  const agent = input => dispatch(server, f.agentToken, input);
  const otherAgent = input => dispatch(server, other.token, input);
  const workspaceBinding = createHash('sha256').update(fs.realpathSync(f.workspace)).digest('hex');
  const heartbeat = patch => agent({ method: 'POST', endpoint: '/api/agent/heartbeat', body: {
    ...f.device, localControl: true, workspaceBinding, codexAuth: 'authenticated', sessions: [session()], ...patch
  } });
  const propose = patch => operator({ method: 'POST', endpoint: '/api/local/task', body: {
    deviceId: f.device.deviceId, mode: 'new', threadId: null, workspaceId: 'project',
    prompt: 'Inspect the synthetic workspace without changing files.', confirmed: true, ...patch
  } });
  const claim = () => agent({ endpoint: '/api/agent/local/task?deviceId=' + f.device.deviceId });
  const update = body => agent({ method: 'POST', endpoint: '/api/agent/local/update', body: {
    deviceId: f.device.deviceId, ...body
  } });
  return { ...f, other, server, operator, agent, otherAgent, heartbeat, propose, claim, update };
}

test('reconnecting heartbeat cannot revive a turn that expired without a dashboard poll', async t => {
  let time = 1000;
  const f = setup(t, { now: () => time });
  await f.heartbeat();
  const proposed = await f.propose();
  await f.claim();
  time += 15000;
  await f.heartbeat();
  assert.equal((await f.update({ jobId: proposed.body.job.id, status: 'completed', output: 'Late synthetic response.' })).status, 409);
  const state = (await f.operator()).body;
  assert.equal(state.devices[0].online, true);
  assert.equal(state.readonlyJobs[0].status, 'failed');
  assert.equal(state.readonlyJobs[0].errorCode, 'agent-disconnected');
  assert.equal(state.readonlyJobs[0].output, '');
});

test('inventory does not certify idle ownership from obsolete agent metadata', async t => {
  const f = setup(t);
  await f.heartbeat({ sessions: [{ ...session(threadId, 'confirmed'), activity: 'active-confirmed' }] });
  const row = (await f.operator()).body.devices[0].sessions[0];
  assert.equal(row.activity, 'discovered');
  assert.equal(row.eligibility, 'discovered');
  await f.heartbeat({ sessions: [session(threadId, 'busy')] });
  assert.equal((await f.operator()).body.devices[0].sessions[0].eligibility, 'busy');
});

test('local Hub requires explicit selectors, read-only approval and server-owned execution policy', async t => {
  const f = setup(t);
  assert.equal((await f.propose()).status, 400, 'a configured agent must first report its capability');
  assert.equal((await f.heartbeat()).status, 200);
  for (const patch of [
    { deviceId: undefined }, { deviceId: f.other.deviceId }, { confirmed: undefined }, { confirmed: false },
    { mode: undefined }, { mode: '' }, { mode: 'shell' }, { workspaceId: undefined }, { workspaceId: 'foreign' },
    { prompt: null }, { prompt: '' }, { prompt: '  ' }, { prompt: 'x'.repeat(2001) }, { threadId }
  ]) assert.equal((await f.propose(patch)).status, 400);
  for (const key of ['shell', 'command', 'sandbox', 'approvalPolicy', 'cwd', 'path', 'model']) {
    assert.equal((await f.propose({ [key]: 'SYNTHETIC_UNAUTHORIZED_OVERRIDE' })).status, 400);
  }
  assert.equal((await f.operator()).body.readonlyJobs.length, 0, 'invalid requests create no jobs');
  const queued = await f.propose();
  assert.equal(queued.status, 201);
  assert.equal(queued.body.job.status, 'queued');
  assert.equal(queued.body.job.policy, 'local-read-only');
  assert.equal(queued.body.job.confirmed, true);
  assert.equal(queued.body.job.threadId, null);
  assert.equal(Object.hasOwn(queued.body.job, 'cwd'), false);
  const state = (await f.operator()).body;
  assert.deepEqual(state.localControl, {
    enabled: true, deviceId: f.device.deviceId, workspaces: [{ id: 'project', label: 'workspace' }]
  });
  assert.deepEqual(state.devices[0].workspaces, state.localControl.workspaces);
  assert.equal(JSON.stringify(state).includes(f.workspace), false, 'authorized absolute workspace stays agent-local');
});

test('local control separates operator permissions, primary agent identity and other enrolled agents', async t => {
  const f = setup(t);
  await f.heartbeat();
  const otherHeartbeat = await f.otherAgent({ method: 'POST', endpoint: '/api/agent/heartbeat', body: {
    ...f.device, deviceId: f.other.deviceId, localControl: true, codexAuth: 'authenticated', sessions: [session(foreignThreadId)]
  } });
  assert.equal(otherHeartbeat.status, 200);
  const remote = (await f.operator()).body.devices.find(device => device.id === f.other.deviceId);
  assert.equal(remote.localControl, false);
  assert.equal(remote.codexAuth, 'unavailable');
  assert.equal((await f.agent()).status, 403);
  assert.equal((await f.agent({ method: 'POST', endpoint: '/api/local/task', body: {} })).status, 403);
  assert.equal((await f.otherAgent({ method: 'POST', endpoint: '/api/local/task', body: {} })).status, 403);
  assert.equal((await f.operator({ endpoint: '/api/agent/local/task?deviceId=' + f.device.deviceId })).status, 403);
  const queued = await f.propose();
  const jobId = queued.body.job.id;
  for (const deviceId of [f.device.deviceId, f.other.deviceId]) {
    assert.equal((await f.otherAgent({ endpoint: '/api/agent/local/task?deviceId=' + deviceId })).status, 403);
  }
  assert.equal((await f.agent({ endpoint: '/api/agent/local/task?deviceId=' + f.other.deviceId })).status, 403);
  const claimed = await f.claim();
  assert.equal(claimed.body.job.id, jobId);
  assert.equal(claimed.body.job.status, 'running');
  assert.equal((await f.claim()).body.job, null, 'one job is claimed only once');
  const final = { deviceId: f.device.deviceId, jobId, status: 'completed', output: 'Synthetic result' };
  assert.equal((await f.otherAgent({ method: 'POST', endpoint: '/api/agent/local/update', body: final })).status, 403);
  assert.equal((await f.update({ ...final, deviceId: f.other.deviceId })).status, 403);
  assert.equal((await f.agent({ method: 'POST', endpoint: '/api/agent/local/update', body: final, authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await f.update(final)).status, 200);
});

test('local jobs serialize queued and running turns and accept only bounded matching progress/results', async t => {
  const f = setup(t);
  await f.heartbeat();
  const jobId = (await f.propose({ mode: 'resume', threadId })).body.job.id;
  assert.equal((await f.propose()).status, 409);
  await f.claim();
  assert.equal((await f.propose()).status, 409);
  for (const patch of [
    { status: 'live' }, { output: 'x'.repeat(8001) }, { outputTruncated: 'true' }, { threadId: 'invalid' }, { threadId: foreignThreadId },
    { events: [{ type: 'shell', message: 'not permitted' }] },
    { events: [{ type: 'progress', message: 'x'.repeat(161) }] },
    { events: Array.from({ length: 21 }, () => ({ type: 'progress', message: 'too many' })) }
  ]) assert.equal((await f.update({ jobId, status: 'running', ...patch })).status, 400);
  assert.equal((await f.operator()).body.readonlyJobs[0].status, 'running');
  const progress = { jobId, status: 'running', output: 'Synthetic partial response', outputTruncated: true, threadId,
    events: [{ type: 'progress', message: 'Read-only turn started.' }, { type: 'output', message: 'Response received.' }] };
  assert.equal((await f.update(progress)).status, 200);
  assert.equal((await f.operator()).body.readonlyJobs[0].output, progress.output);
  assert.equal((await f.operator()).body.readonlyJobs[0].outputTruncated, true);
  assert.equal((await f.update({ ...progress, status: 'completed', output: 'Synthetic final response', outputTruncated: false })).status, 200);
  assert.equal((await f.update({ ...progress, status: 'completed' })).status, 409);
  const final = (await f.operator()).body.readonlyJobs[0];
  assert.equal(final.threadId, threadId);
  assert.equal(final.outputTruncated, false);
  assert.ok(final.finishedAt);
  assert.equal((await f.propose()).status, 201, 'a completed turn releases the local queue');
});

test('terminal history rollover keeps newest results and never evicts queued or running work', async t => {
  const f = setup(t, { now: () => 1000 });
  await f.heartbeat();
  const completedIds = [];
  for (let index = 0; index < 105; index++) {
    const proposed = await f.propose();
    assert.equal(proposed.status, 201);
    const id = proposed.body.job.id;
    assert.equal((await f.claim()).body.job.id, id);
    assert.equal((await f.update({ jobId: id, status: ['completed', 'failed', 'interrupted'][index % 3],
      output: 'Synthetic terminal history ' + index })).status, 200);
    completedIds.push(id);
  }
  assert.deepEqual((await f.operator()).body.readonlyJobs.map(job => job.id), completedIds.slice(-40).reverse());
  const queued = (await f.propose()).body.job;
  assert.equal((await f.propose()).status, 409);
  assert.equal((await f.claim()).body.job.id, queued.id);
  assert.equal((await f.propose()).status, 409);
  assert.equal((await f.operator()).body.readonlyJobs[0].id, queued.id);
  assert.equal((await f.update({ jobId: queued.id, status: 'completed', output: 'Synthetic retained work.' })).status, 200);
});

test('Resume requires an explicit session reported by the local device and excludes busy sessions', async t => {
  const f = setup(t);
  await f.heartbeat({ sessions: [session(), session(busyThreadId, 'busy')] });
  await f.otherAgent({ method: 'POST', endpoint: '/api/agent/heartbeat', body: {
    ...f.device, deviceId: f.other.deviceId, sessions: [session(foreignThreadId)]
  } });
  for (const value of [undefined, null, '', 'invalid', foreignThreadId, busyThreadId]) {
    assert.equal((await f.propose({ mode: 'resume', threadId: value })).status, 400);
  }
  assert.equal((await f.operator()).body.readonlyJobs.length, 0);
  const accepted = await f.propose({ mode: 'resume', threadId });
  assert.equal(accepted.status, 201, 'explicitly selected discovery is verified by the controller at run time');
  assert.equal(accepted.body.job.threadId, threadId);
  assert.equal((await f.operator()).body.devices.find(device => device.id === f.device.deviceId).sessions[0].eligibility, 'discovered');
});

test('authentication, Offline, disabled capability and revocation fail local work closed', async t => {
  let time = Date.now();
  const f = setup(t, { now: () => time });
  for (const patch of [{ codexAuth: 'not-authenticated' }, { codexAuth: 'unavailable' }, { localControl: false }]) {
    await f.heartbeat(patch);
    assert.equal((await f.propose()).status, 400);
  }
  await f.heartbeat();
  time += 15000;
  assert.equal((await f.propose()).status, 400);
  assert.equal((await f.claim()).status, 400);
  await f.heartbeat();
  const jobId = (await f.propose()).body.job.id;
  await f.claim();
  assert.equal((await f.operator({ method: 'POST', endpoint: '/api/admin/agents/revoke', body: { deviceId: f.device.deviceId } })).status, 200);
  const state = (await f.operator()).body;
  assert.equal(state.devices[0].online, false);
  assert.equal(state.readonlyJobs[0].status, 'failed');
  assert.equal(state.readonlyJobs[0].errorCode, 'agent-revoked');
  assert.equal((await f.heartbeat()).status, 401);
  assert.equal((await f.claim()).status, 401);
  assert.equal((await f.update({ jobId, status: 'completed', output: 'Rejected late response' })).status, 401);
  assert.equal((await f.propose()).status, 400);
  const disabled = setup(t, { enabled: false });
  await disabled.heartbeat();
  assert.equal((await disabled.operator()).body.localControl.enabled, false);
  assert.equal((await disabled.propose()).status, 400);
});

test('Offline expires queued and running local jobs without replay, preserves partial output and permits explicit recovery', async t => {
  for (const initialStatus of ['queued', 'running']) {
    for (const trigger of ['state', 'propose', 'claim']) {
      let time = Date.now();
      const f = setup(t, { now: () => time });
      await f.heartbeat();
      const created = await f.propose();
      assert.equal(created.status, 201);
      const jobId = created.body.job.id;
      const partialOutput = initialStatus === 'running' ? 'Synthetic partial result before disconnect.' : '';
      const partialEvents = initialStatus === 'running' ? [{ type: 'progress', message: 'Synthetic turn in progress.' }] : [];
      if (initialStatus === 'running') {
        assert.equal((await f.claim()).body.job.id, jobId);
        assert.equal((await f.update({ jobId, status: 'running', output: partialOutput, events: partialEvents })).status, 200);
      }
      time += 14999;
      const before = (await f.operator()).body;
      assert.equal(before.devices[0].online, true);
      assert.equal(before.readonlyJobs[0].status, initialStatus);
      time++;
      let expired;
      if (trigger === 'state') {
        expired = (await f.operator()).body;
        assert.equal(expired.devices[0].online, false);
      } else {
        assert.equal((await (trigger === 'propose' ? f.propose() : f.claim())).status, 400);
        // Restore heartbeat before observing state so GET /api/state cannot hide a missing trigger.
        assert.equal((await f.heartbeat()).status, 200);
        expired = (await f.operator()).body;
      }
      const failed = expired.readonlyJobs.find(job => job.id === jobId);
      assert.equal(failed.status, 'failed', initialStatus + ' job expires via ' + trigger);
      assert.equal(failed.errorCode, 'agent-disconnected');
      assert.equal(failed.output, partialOutput);
      assert.deepEqual(failed.events, partialEvents);
      assert.equal(failed.finishedAt, new Date(time).toISOString());
      if (trigger === 'state') assert.equal((await f.heartbeat()).status, 200);
      assert.equal((await f.claim()).body.job, null, 'reconnection never requeues or replays the failed instruction');
      assert.equal((await f.update({ jobId, status: 'completed', output: 'Rejected late result' })).status, 409);
      const replacement = await f.propose();
      assert.equal(replacement.status, 201, 'recovery requires a new explicitly approved instruction');
      assert.notEqual(replacement.body.job.id, jobId);
      assert.equal((await f.claim()).body.job.id, replacement.body.job.id);
      assert.equal((await f.update({ jobId, status: 'completed', output: 'Rejected result for previous instruction' })).status, 409);
      const recovered = (await f.operator()).body;
      assert.equal(recovered.devices[0].online, true);
      assert.equal(recovered.readonlyJobs.find(job => job.id === jobId).status, 'failed');
      assert.equal(recovered.readonlyJobs.find(job => job.id === replacement.body.job.id).status, 'running');
      assert.equal(recovered.readonlyJobs.find(job => job.id === jobId).output, partialOutput);
    }
  }
});

test('late progress and results expire disconnected jobs without relying on a dashboard poll', async t => {
  for (const status of ['running', 'completed', 'failed', 'interrupted']) {
    let time = Date.now();
    const f = setup(t, { now: () => time });
    await f.heartbeat();
    const jobId = (await f.propose()).body.job.id;
    await f.claim();
    const output = 'Synthetic safe partial before losing heartbeat.';
    const events = [{ type: 'progress', message: 'Synthetic progress before losing heartbeat.' }];
    await f.update({ jobId, status: 'running', output, events });
    time += 15000;
    assert.equal((await f.update({ jobId, status, output: 'Late response must not overwrite the partial.' })).status, 409);
    await f.heartbeat(); // Reconnecting first prevents GET /api/state from hiding a missing expiry check.
    const job = (await f.operator()).body.readonlyJobs.find(job => job.id === jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.errorCode, 'agent-disconnected');
    assert.equal(job.finishedAt, new Date(time).toISOString());
    assert.equal(job.output, output);
    assert.deepEqual(job.events, events);
    assert.equal((await f.claim()).body.job, null, 'late responses never requeue a disconnected instruction');
  }
});

test('an update whose body crosses the heartbeat deadline is rejected after the complete body is read', async t => {
  let time = Date.now();
  const f = setup(t, { now: () => time });
  await f.heartbeat();
  const jobId = (await f.propose()).body.job.id;
  await f.claim();
  const body = Buffer.from(JSON.stringify({ deviceId: f.device.deviceId, jobId, status: 'completed', output: 'Late synthetic result.' }));
  const chunks = (function* () {
    yield body.subarray(0, 20);
    time += 15000;
    yield body.subarray(20);
  })();
  assert.equal((await f.agent({ method: 'POST', endpoint: '/api/agent/local/update', chunks })).status, 409);
  await f.heartbeat();
  const job = (await f.operator()).body.readonlyJobs.find(job => job.id === jobId);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'agent-disconnected');
  assert.equal(job.output, '');
});

test('agent runs an explicitly queued synthetic controller turn in the background while heartbeats continue', async t => {
  let time = Date.now();
  const f = setup(t, { now: () => time });
  const calls = { account: 0, inventory: 0, run: 0, closed: 0 };
  let finish;
  let emit;
  let captured;
  const completion = new Promise(resolve => { finish = resolve; });
  const controller = {
    async accountStatus() { calls.account++; return { status: 'authenticated' }; },
    async listSessions() { calls.inventory++; return { sessions: [session()], status: 'available', truncated: false, source: 'app-server' }; },
    run(job, onEvent) {
      calls.run++;
      captured = job;
      emit = onEvent;
      onEvent({ type: 'progress', message: 'Synthetic read-only turn started.' });
      return completion;
    },
    async close() { calls.closed++; }
  };
  const agent = createAgent({ env: { ...f.env, LEVERAGE_LOCAL_READONLY: '1' },
    controlFactory: options => {
      assert.equal(options.workspace, f.workspace);
      assert.equal(options.home, f.home);
      return controller;
    },
    fetchImpl: async (url, options) => {
      const endpoint = new URL(url);
      const response = await dispatch(f.server, '', {
        endpoint: endpoint.pathname + endpoint.search, method: options.method,
        authorization: options.headers.Authorization,
        ...(options.body === undefined ? {} : { body: JSON.parse(options.body) })
      });
      return { ok: response.status < 400, status: response.status, json: async () => response.body };
    }
  });
  try {
    await agent.tick();
    assert.equal(calls.run, 0, 'registration does not start a turn');
    const queued = await f.propose();
    assert.equal(queued.status, 201);
    await agent.tick();
    assert.equal(calls.run, 1);
    assert.equal(captured.policy, 'local-read-only');
    assert.equal(captured.confirmed, true);
    assert.equal(captured.workspaceId, 'project');
    assert.equal(Object.hasOwn(captured, 'cwd'), false);
    assert.equal(Object.hasOwn(captured, 'command'), false);
    assert.equal((await f.operator()).body.readonlyJobs[0].status, 'running');
    const before = { account: calls.account, inventory: calls.inventory };
    emit({ type: 'progress', message: 'Synthetic response generation in progress.' });
    emit({ type: 'output', message: 'Synthetic partial answer.' });
    await delay(350);
    const partial = (await f.operator()).body.readonlyJobs[0];
    assert.equal(partial.status, 'running');
    assert.equal(partial.output, 'Synthetic partial answer.');
    assert.ok(partial.events.some(event => event.message === 'Synthetic response generation in progress.'));
    for (let heartbeat = 0; heartbeat < 30; heartbeat++) {
      time += 5000;
      await agent.tick();
      const current = (await f.operator()).body;
      assert.equal(current.devices[0].online, true);
      assert.equal(current.readonlyJobs[0].status, 'running');
    }
    assert.equal(calls.account, before.account, 'an active turn does not block on another account request');
    assert.equal(calls.inventory, before.inventory, 'heartbeat uses cached inventory during the active turn');
    const active = (await f.operator()).body.devices[0];
    assert.equal(active.online, true);
    assert.equal(active.lastSeen, time);
    assert.equal(calls.run, 1);
    finish({ status: 'completed', output: 'Synthetic final answer; no files changed.', threadId });
    await agent.waitForIdle();
    const state = (await f.operator()).body;
    assert.equal(state.readonlyJobs[0].status, 'completed');
    assert.equal(state.readonlyJobs[0].threadId, threadId);
    assert.equal(state.readonlyJobs[0].output, 'Synthetic final answer; no files changed.');
    assert.ok(state.readonlyJobs[0].events.some(event => event.type === 'progress'));
    assert.ok(state.readonlyJobs[0].events.some(event => event.type === 'output'));
    assert.equal(Object.hasOwn(state, 'jobs'), false, 'state exposes only the real read-only queue');
    assert.deepEqual(fs.readdirSync(f.workspace), []);
  } finally {
    finish({ status: 'interrupted', output: 'Synthetic cleanup' });
    await agent.close();
  }
  assert.equal(calls.closed, 1);
});

test('legacy live flag cannot instantiate local control and normal discovery stays read-only', async t => {
  for (const localEnvironment of [
    {}, { LEVERAGE_LOCAL_READONLY: '1', LEVERAGE_ENABLE_LIVE_CODEX: '1' }
  ]) {
    const f = setup(t);
    const agent = createAgent({ env: { ...f.env, ...localEnvironment },
      controlFactory: () => assert.fail('local controller must remain disabled'),
      fetchImpl: async (url, options) => {
        const endpoint = new URL(url);
        const response = await dispatch(f.server, '', { endpoint: endpoint.pathname + endpoint.search,
          method: options.method, authorization: options.headers.Authorization,
          ...(options.body === undefined ? {} : { body: JSON.parse(options.body) }) });
        return { ok: response.status < 400, status: response.status, json: async () => response.body };
      }
    });
    try {
      await agent.tick();
      const state = (await f.operator()).body;
      assert.equal(state.devices[0].localControl, false);
      assert.equal(state.readonlyJobs.length, 0);
      assert.equal((await f.propose()).status, 400);
    } finally { await agent.close(); }
  }
});

test('agent reports UTF-8 transport truncation even when the controller character limit was not reached', async t => {
  const f = setup(t);
  const answer = '🙂'.repeat(3000);
  const agent = createAgent({ env: { ...f.env, LEVERAGE_LOCAL_READONLY: '1' }, controlFactory: () => ({
    accountStatus: async () => ({ status: 'authenticated' }),
    listSessions: async () => ({ sessions: [session()], status: 'available', truncated: false, source: 'app-server' }),
    run: async (_job, onEvent) => {
      onEvent({ type: 'output', message: answer, outputTruncated: false });
      return { status: 'completed', threadId, output: answer, outputTruncated: false };
    }, close: async () => {},
  }), fetchImpl: async (url, options) => {
    const endpoint = new URL(url);
    const response = await dispatch(f.server, '', { endpoint: endpoint.pathname + endpoint.search,
      method: options.method, authorization: options.headers.Authorization,
      ...(options.body === undefined ? {} : { body: JSON.parse(options.body) }) });
    return { ok: response.status < 400, status: response.status, json: async () => response.body };
  } });
  t.after(() => agent.close());
  await agent.tick(); await f.propose(); await agent.tick(); await agent.waitForIdle();
  const job = (await f.operator()).body.readonlyJobs[0];
  assert.equal(job.status, 'completed');
  assert.equal(job.outputTruncated, true);
  assert.equal(job.output, '🙂'.repeat(2000));
  assert.ok(Buffer.byteLength(job.output) <= 8000);
  assert.equal(job.output.isWellFormed(), true);
});

test('claim revalidates authentication, local capability, Resume availability and approval expiry', async t => {
  for (const patch of [
    { codexAuth: 'not-authenticated' }, { localControl: false },
    { sessions: [session(threadId, 'busy')] }, { sessions: [] }, { expired: true }
  ]) {
    let time = Date.now();
    const f = setup(t, { now: () => time });
    await f.heartbeat();
    const queued = await f.propose({ mode: 'resume', threadId });
    assert.equal(queued.status, 201);
    if (patch.expired) {
      // Approval age expires while the agent remains Online; an actual gap
      // is covered separately and must retain agent-disconnected instead.
      for (let beat = 0; beat < 24; beat++) { time += 5000; await f.heartbeat(); }
      time++;
    }
    const { expired, ...heartbeatPatch } = patch;
    await f.heartbeat(heartbeatPatch);
    const claim = await f.claim();
    assert.equal(claim.status, 200);
    assert.equal(claim.body.job, null, 'a stale selection never reaches the agent controller');
    const failed = (await f.operator()).body.readonlyJobs[0];
    assert.equal(failed.id, queued.body.job.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'selection-no-longer-available');
  }
});

test('the local agent must prove the configured workspace binding without exposing its path or binding', async t => {
  const f = setup(t);
  const wrongDirectoryBinding = createHash('sha256').update(fs.realpathSync(f.home)).digest('hex');
  for (const workspaceBinding of [undefined, '0'.repeat(64), wrongDirectoryBinding]) {
    assert.equal((await f.heartbeat({ workspaceBinding })).status, 200);
    const state = (await f.operator()).body;
    assert.equal(state.devices[0].localControl, false);
    assert.equal(state.devices[0].codexAuth, 'unavailable');
    assert.equal((await f.propose()).status, 400);
  }
  await f.heartbeat();
  const state = (await f.operator()).body;
  assert.equal(state.devices[0].localControl, true);
  assert.equal(state.devices[0].codexAuth, 'authenticated');
  assert.equal(Object.hasOwn(state.devices[0], 'workspaceBinding'), false);
  assert.equal(JSON.stringify(state).includes(f.workspace), false);
  assert.equal((await f.propose()).status, 201);
});

test('an active agent closes its synthetic controller on revocation or loss of Hub connectivity', { timeout: 5000 }, async t => {
  for (const failure of ['revoked', 'disconnected']) {
    const f = setup(t);
    const calls = { run: 0, close: 0, requests: 0 };
    let finish;
    let disconnected = false;
    const pending = new Promise(resolve => { finish = resolve; });
    const controller = {
      async accountStatus() { return { status: 'authenticated' }; },
      async listSessions() { return { sessions: [session()], status: 'available', truncated: false, source: 'app-server' }; },
      run() { calls.run++; return pending; },
      async close() {
        calls.close++;
        finish({ status: 'interrupted', output: 'Synthetic controller stopped.' });
      }
    };
    const agent = createAgent({ env: { ...f.env, LEVERAGE_LOCAL_READONLY: '1' },
      controlFactory: () => controller,
      fetchImpl: async (url, options) => {
        calls.requests++;
        if (disconnected) throw new Error('Synthetic connection lost.');
        const endpoint = new URL(url);
        const response = await dispatch(f.server, '', {
          endpoint: endpoint.pathname + endpoint.search, method: options.method,
          authorization: options.headers.Authorization,
          ...(options.body === undefined ? {} : { body: JSON.parse(options.body) })
        });
        return { ok: response.status < 400, status: response.status, json: async () => response.body };
      }
    });
    try {
      await agent.tick();
      assert.equal((await f.propose()).status, 201);
      await agent.tick();
      assert.equal(calls.run, 1);
      if (failure === 'revoked') {
        assert.equal((await f.operator({ method: 'POST', endpoint: '/api/admin/agents/revoke', body: { deviceId: f.device.deviceId } })).status, 200);
      } else disconnected = true;
      await assert.rejects(agent.tick(), failure === 'revoked' ? /HTTP 401/ : /Synthetic connection lost/);
      await agent.waitForIdle();
      assert.ok(calls.close >= 1, 'revocation or lost connectivity interrupts the active controller');
      assert.equal(calls.run, 1);
      const requestsAfterStop = calls.requests;
      await assert.rejects(agent.tick(), /restart/);
      assert.equal(calls.requests, requestsAfterStop, 'controller stays stopped until explicitly restarted');
      if (failure === 'revoked') {
        const job = (await f.operator()).body.readonlyJobs[0];
        assert.equal(job.status, 'failed');
        assert.equal(job.errorCode, 'agent-revoked');
      }
    } finally {
      finish({ status: 'interrupted', output: 'Synthetic cleanup' });
      await agent.close();
    }
  }
});
