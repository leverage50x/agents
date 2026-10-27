import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay, setImmediate as immediate } from 'node:timers/promises';
import { createAgent } from '../src/agent.mjs';
import { fixture } from '../test-support/fixtures.mjs';

const THREAD = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';

function setup(t, { closeDelay = 0, holdFirstUpdate = false } = {}) {
  const f = fixture(t);
  const updates = [];
  const heartbeats = [];
  let releaseUpdate;
  const updateGate = new Promise(resolve => { releaseUpdate = resolve; });
  let finish;
  let reject;
  let emit;
  let status = 200;
  let claimed = false;
  let closes = 0;
  const pending = new Promise((resolve, rejectRun) => { finish = resolve; reject = rejectRun; });
  const controller = {
    async accountStatus() { return { status: 'authenticated' }; },
    async listSessions() { return { sessions: [], status: 'available', truncated: false, source: 'app-server' }; },
    run(job, onEvent) {
      assert.equal(job.id, JOB);
      emit = onEvent;
      return pending;
    },
    async close() {
      closes++;
      await delay(closeDelay);
      finish({ status: 'interrupted', threadId: THREAD, output: 'Synthetic operation interrupted.' });
    }
  };
  const agent = createAgent({ env: { ...f.env, LEVERAGE_LOCAL_READONLY: '1' },
    controlFactory: () => controller,
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      let body = { ok: true };
      let code = 200;
      if (pathname === '/api/agent/local/task') {
        body = { job: claimed ? null : { id: JOB, mode: 'new', workspaceId: 'project', confirmed: true,
          policy: 'local-read-only', prompt: 'Synthetic read-only instruction.' } };
        claimed = true;
      }
      if (pathname === '/api/agent/local/update') {
        updates.push({ bytes: Buffer.byteLength(options.body), body: JSON.parse(options.body) });
        if (holdFirstUpdate && updates.length === 1) await updateGate;
        code = status;
      }
      if (pathname === '/api/agent/heartbeat') heartbeats.push(JSON.parse(options.body));
      return { ok: code >= 200 && code < 300, status: code, json: async () => body };
    }
  });
  t.after(async () => { releaseUpdate(); finish({ status: 'interrupted', output: 'Synthetic cleanup.' }); await agent.close(); });
  return { agent, updates, heartbeats, releaseUpdate, finish, reject, emit: event => emit(event),
    failWith: code => { status = code; }, get closes() { return closes; } };
}

test('failed progress requests close exactly once with no unhandled rejection while shutdown is pending', { timeout: 5000 }, async t => {
  for (const status of [401, 403, 409, 500]) {
    const f = setup(t, { closeDelay: 25 });
    await f.agent.tick();
    f.failWith(status);
    f.emit({ type: 'progress', message: 'Synthetic update before Hub failure.' });
    await f.agent.waitForIdle();
    assert.ok(f.updates.length > 0);
    assert.equal(f.closes, 1, 'all HTTP failures during an active run close the controller once');
    await assert.rejects(f.agent.tick(), /restart/);
    await Promise.all([f.agent.close(), f.agent.close()]);
    assert.equal(f.closes, 1, 'explicit close shares the existing shutdown');
  }
});

test('Unicode and JSON control characters stay inside the full update byte limit with terminal identity intact', { timeout: 5000 }, async t => {
  const f = setup(t);
  await f.agent.tick();
  const unicode = '😀\u0000\\"\nș漢'.repeat(8000);
  f.emit({ type: 'output', message: unicode });
  for (let index = 0; index < 25; index++) f.emit({ type: 'progress', message: unicode });
  f.finish({ status: 'completed', output: unicode, threadId: THREAD, errorCode: 'synthetic-result' });
  await f.agent.waitForIdle();
  assert.ok(f.updates.length > 0);
  for (const update of f.updates) {
    assert.ok(update.bytes < 18000, 'entire serialized JSON stays below the transport budget');
    assert.ok(Buffer.byteLength(update.body.output) <= 8000);
    assert.equal(update.body.output.isWellFormed(), true);
    assert.equal(update.body.output.includes('\ufffd'), false, 'complete synthetic Unicode code points are retained');
    assert.ok(update.body.events.length <= 20);
    for (const event of update.body.events) {
      assert.ok(event.message.length <= 160);
      assert.equal(event.message.isWellFormed(), true);
    }
  }
  const terminal = f.updates.at(-1).body;
  assert.equal(terminal.jobId, JOB);
  assert.equal(terminal.threadId, THREAD);
  assert.equal(terminal.errorCode, 'synthetic-result');
  assert.equal(terminal.status, 'completed');
});

test('progress flushes the trailing phase and replaces partial snapshots before the turn completes', { timeout: 5000 }, async t => {
  const f = setup(t);
  let time = 10000;
  t.mock.method(Date, 'now', () => time);
  await f.agent.tick();
  f.emit({ type: 'progress', message: 'Synthetic session initialization.' });
  await immediate();
  assert.equal(f.updates.length, 1, 'the first real event is sent immediately');
  time++;
  f.emit({ type: 'progress', message: 'Synthetic response generation.' });
  f.emit({ type: 'output', message: 'Synthetic partial' });
  f.emit({ type: 'output', message: 'Synthetic partial response.' });
  await delay(350);
  const running = f.updates.at(-1).body;
  assert.equal(running.status, 'running');
  assert.equal(running.output, 'Synthetic partial response.', 'snapshot replacement never concatenates duplicate prefixes');
  assert.ok(running.events.some(event => event.message === 'Synthetic response generation.'));
  assert.equal(running.events.filter(event => event.type === 'output').length, 1);
  const sent = f.updates.length;
  await delay(350);
  assert.equal(f.updates.length, sent, 'no progress is invented while the controller emits nothing');
  f.finish({ status: 'completed', output: 'Synthetic final response.', threadId: THREAD });
  await f.agent.waitForIdle();
  assert.equal(f.updates.at(-1).body.status, 'completed');
  assert.equal(f.updates.at(-1).body.output, 'Synthetic final response.');
  const terminalCount = f.updates.length;
  f.emit({ type: 'output', message: 'Late synthetic callback must be ignored.' });
  await delay(350);
  assert.equal(f.updates.length, terminalCount);
});

test('failed, interrupted or thrown controller results retain safe partials while an empty completed snapshot stays authoritative', { timeout: 5000 }, async t => {
  for (const outcome of ['failed', 'interrupted', 'throw', 'completed']) {
    const f = setup(t);
    await f.agent.tick();
    f.emit({ type: 'output', message: 'Synthetic safe partial response.' });
    if (outcome === 'throw') f.reject(new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC_NOT_FOR_UI'));
    else f.finish({ status: outcome, output: '', threadId: THREAD,
      ...(outcome === 'failed' ? { errorCode: 'codex-rpc-timeout' } : {}) });
    await f.agent.waitForIdle();
    const terminal = f.updates.at(-1).body;
    assert.equal(terminal.status, outcome === 'throw' ? 'failed' : outcome);
    assert.equal(terminal.output, outcome === 'completed' ? '' : 'Synthetic safe partial response.');
    assert.equal(JSON.stringify(terminal).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC_NOT_FOR_UI'), false);
    if (outcome === 'failed') assert.equal(terminal.errorCode, 'codex-rpc-timeout');
  }
});

test('slow Hub updates coalesce to the latest snapshot without blocking independent heartbeats', { timeout: 5000 }, async t => {
  const f = setup(t, { holdFirstUpdate: true });
  await f.agent.tick();
  f.emit({ type: 'progress', message: 'Synthetic turn started.' });
  await immediate();
  assert.equal(f.updates.length, 1);
  for (let index = 0; index < 100; index++) f.emit({ type: 'output', message: 'Synthetic partial snapshot ' + index });
  await f.agent.tick();
  assert.equal(f.heartbeats.length, 2, 'heartbeat does not await the stalled progress response');
  assert.equal(f.updates.length, 1, 'only one progress request may be in flight');
  f.releaseUpdate();
  await delay(350);
  assert.equal(f.updates.length, 2, 'queued presentation snapshots are coalesced rather than replayed');
  assert.equal(f.updates[1].body.output, 'Synthetic partial snapshot 99');
  f.finish({ status: 'completed', output: 'Synthetic final answer.', threadId: THREAD });
  await f.agent.waitForIdle();
  assert.equal(f.updates.at(-1).body.output, 'Synthetic final answer.');
  assert.equal(f.closes, 0);
});
