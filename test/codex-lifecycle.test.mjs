import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as immediate } from 'node:timers/promises';
import { createCodexControl } from '../src/codex-control.mjs';
import { fixture } from '../test-support/fixtures.mjs';

const THREAD_A = '11111111-1111-4111-8111-111111111111';
const THREAD_B = '22222222-2222-4222-8222-222222222222';
const input = { mode: 'new', workspaceId: 'project', confirmed: true, prompt: 'Synthetic read-only request.' };
const resume = id => ({ ...input, mode: 'resume', threadId: id });

// Model the native writer lease rather than treating every RPC as stateless:
// a loaded thread remains owned until that exact synthetic process exits.
function brokerFixture(t) {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, 'README.md'), '# Synthetic lifecycle fixture\n');
  const owners = new Map();
  const turns = new Map();
  const servers = [];
  const controls = [];
  const requests = [];
  let nextThread = 0;
  const state = { outcome: 'completed', holdWorkerExit: false, ignoreWorkerExit: false, clockTime: 1000 };
  const exit = record => {
    if (record.exited) return;
    record.exited = true;
    clearInterval(record.activity);
    record.child.exitCode = record.exitSignal ? null : 1;
    record.child.signalCode = record.exitSignal || null;
    for (const [id, owner] of owners) if (owner === record) owners.delete(id);
    record.child.emit('close', record.child.exitCode, record.child.signalCode);
  };
  const spawnImpl = (_command, args) => {
    const child = new EventEmitter();
    child.pid = 999999; child.exitCode = null; child.signalCode = null;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const record = { child, exited: false, signals: [], role: args[0] === '--version' ? 'version' : 'metadata' };
    if (record.role !== 'version') servers.push(record);
    const reply = message => { if (!record.exited) child.stdout.write(JSON.stringify(message) + '\n'); };
    child.kill = signal => {
      if (record.exited) return false;
      record.signals.push(signal); record.exitSignal = signal;
      if (state.ignoreWorkerExit && record.role === 'worker') {
        // An exit field alone is not proof that stdio close was observed.
        child.exitCode = 0;
        return true;
      }
      if (!state.holdWorkerExit || record.role !== 'worker') queueMicrotask(() => exit(record));
      return true;
    };
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      for (const line of chunk.toString().trim().split('\n').filter(Boolean)) {
        const message = JSON.parse(line);
        requests.push({ server: record, ...message });
        if (!message.method || message.method === 'initialized') continue;
        queueMicrotask(() => {
          if (record.exited) return;
          const response = result => reply({ id: message.id, result });
          switch (message.method) {
            case 'initialize': response({}); break;
            case 'account/read': response({ account: { type: 'chatgpt' } }); break;
            case 'thread/list':
              response({ data: [THREAD_A, THREAD_B].map(id => ({ id, cwd: f.workspace,
                source: 'cli', updatedAt: 1700000000, status: { type: 'notLoaded' } })), nextCursor: null });
              break;
            case 'thread/start':
            case 'thread/resume': {
              record.role = 'worker';
              const id = message.method === 'thread/start' ? [THREAD_A, THREAD_B][nextThread++ % 2] : message.params.threadId;
              if (owners.has(id) && owners.get(id) !== record) {
                reply({ id: message.id, error: { code: -32600, message: 'thread ' + id + ' already has an active writer' } });
                break;
              }
              owners.set(id, record);
              response({ cwd: f.workspace, sandbox: { type: state.outcome === 'policy' ? 'workspaceWrite' : 'readOnly', networkAccess: false },
                approvalPolicy: 'on-request', approvalsReviewer: 'user',
                thread: { id, cwd: f.workspace, status: { type: 'idle' } } });
              break;
            }
            case 'turn/start': {
              if (state.outcome === 'rpc-timeout') break;
              if (state.outcome === 'output') { child.stderr.write(Buffer.alloc(33554433)); break; }
              if (state.outcome === 'clock') state.clockTime = NaN;
              if (state.outcome === 'approval') {
                reply({ id: 'synthetic-approval', method: 'item/commandExecution/requestApproval', params: {} });
                break;
              }
              if (state.outcome === 'protocol') { child.stdout.write('synthetic-invalid-json\n'); break; }
              const id = message.params.threadId;
              const number = (turns.get(id) || 0) + 1;
              turns.set(id, number);
              const turnId = String(number).padStart(8, '0') + '-3333-4333-8333-333333333333';
              response({ turn: { id: turnId, status: 'inProgress', items: [] } });
              if (state.outcome === 'exit') { exit(record); break; }
              if (state.outcome === 'idle-timeout' || state.outcome === 'hold') break;
              if (state.outcome === 'turn-timeout') {
                record.activity = setInterval(() => reply({ method: 'item/reasoning/summaryTextDelta',
                  params: { threadId: id, turnId, itemId: 'synthetic-reasoning', delta: 'Synthetic activity, never displayed.' } }), 15);
                break;
              }
              reply({ method: 'turn/completed', params: { threadId: id, turn: { id: turnId,
                status: state.outcome === 'failed' ? 'failed' : 'completed',
                items: [{ type: 'agentMessage', id: 'synthetic-message', text: 'Synthetic response ' + number + '.' }] } } });
              break;
            }
            default: assert.fail('Unexpected synthetic protocol method.');
          }
        });
      }
      done();
    } });
    if (record.role === 'version') queueMicrotask(() => {
      child.stdout.write('codex-cli 0.163.0\n'); child.exitCode = 0; record.exited = true; child.emit('close', 0, null);
    });
    return child;
  };
  const control = () => {
    const c = createCodexControl({ workspace: f.workspace, home: f.home, spawnImpl,
      rpcTimeoutMs: 80, idleTimeoutMs: 80, turnTimeoutMs: 250, now: () => state.clockTime });
    controls.push(c);
    return c;
  };
  const releaseWorkerExits = () => {
    state.holdWorkerExit = false;
    state.ignoreWorkerExit = false;
    for (const record of servers) if (record.role === 'worker' && record.exitSignal) exit(record);
  };
  t.after(async () => { releaseWorkerExits(); await Promise.all(controls.map(c => c.close())); });
  return { ...f, state, owners, turns, servers, requests, control, releaseWorkerExits };
}

test('completed New and Resume release native ownership while persistent metadata stays unloaded', async t => {
  const f = brokerFixture(t);
  const first = f.control();
  assert.equal((await first.accountStatus()).status, 'authenticated');
  const metadata = f.servers[0];
  const created = await first.run(input);
  assert.equal(created.status, 'completed');
  assert.equal(f.owners.size, 0, 'terminal results are published only after native ownership is released');
  assert.equal(metadata.exited, false);
  assert.deepEqual(metadata.signals, []);
  assert.equal((await first.listSessions()).sessions.find(s => s.id === created.threadId).eligibility, 'discovered');
  const second = f.control();
  const continued = await second.run(resume(created.threadId));
  assert.equal(continued.status, 'completed');
  assert.equal(continued.threadId, created.threadId);
  assert.equal(continued.output, 'Synthetic response 2.');
  assert.equal(f.owners.size, 0);
  assert.ok(f.servers.filter(s => s.role === 'worker').every(s => s.exited));
  assert.equal(f.requests.filter(r => r.server === metadata).some(r => ['thread/start', 'thread/resume', 'turn/start'].includes(r.method)), false);
});

test('failed turns, RPC/idle/absolute timeouts and native exit release only their worker and permit explicit retry', async t => {
  for (const outcome of ['failed', 'rpc-timeout', 'idle-timeout', 'turn-timeout', 'exit']) {
    const f = brokerFixture(t);
    const c = f.control();
    assert.equal((await c.accountStatus()).status, 'authenticated');
    const metadata = f.servers[0];
    f.state.outcome = outcome;
    const result = await c.run(input);
    assert.equal(result.status, 'failed', outcome);
    if (outcome.endsWith('timeout')) assert.equal(result.errorCode, 'codex-' + outcome);
    assert.equal(f.owners.size, 0, outcome + ' must release the native lease');
    assert.equal(metadata.exited, false, 'worker failure must not poison metadata');
    assert.equal((await c.accountStatus()).status, 'authenticated');
    f.state.outcome = 'completed';
    assert.equal((await c.run(resume(THREAD_A))).status, 'completed');
    assert.equal(f.owners.size, 0);
  }
});

test('a synthetic native-owner conflict protects its selected thread while another thread in the same workspace is allowed', async t => {
  const f = brokerFixture(t);
  const external = { role: 'synthetic-external', signals: [] };
  f.owners.set(THREAD_A, external);
  const c = f.control();
  const blocked = await c.run(resume(THREAD_A));
  assert.equal(blocked.errorCode, 'codex-busy');
  assert.equal(f.owners.get(THREAD_A), external);
  assert.deepEqual(external.signals, []);
  assert.equal(f.requests.some(r => r.method === 'turn/start'), false);
  const allowed = await c.run(resume(THREAD_B));
  assert.equal(allowed.status, 'completed');
  assert.equal(allowed.threadId, THREAD_B);
  assert.equal(f.owners.get(THREAD_A), external);
  assert.equal(f.owners.has(THREAD_B), false);
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
});

test('another request stays Busy until asynchronous worker shutdown has released ownership', async t => {
  const f = brokerFixture(t);
  const c = f.control();
  f.state.holdWorkerExit = true;
  const running = c.run(input);
  for (let tries = 0; tries < 100 && !f.servers.some(s => s.role === 'worker' && s.signals.length); tries++) await immediate();
  const worker = f.servers.find(s => s.role === 'worker');
  assert.ok(worker?.signals.length, 'the completed worker must begin shutdown');
  assert.equal(worker.exited, false);
  assert.equal(f.owners.get(THREAD_A), worker);
  assert.equal((await c.run(resume(THREAD_B))).errorCode, 'codex-busy');
  f.releaseWorkerExits();
  assert.equal((await running).status, 'completed');
  assert.equal(f.owners.size, 0);
  assert.equal((await c.run(resume(THREAD_A))).status, 'completed');
});

test('policy/protocol/approval/output/clock violations remain sticky and never trigger a new worker or weaker policy', async t => {
  for (const [outcome, errorCode] of [['policy', 'codex-policy-mismatch'], ['protocol', 'codex-protocol-error'],
    ['approval', 'approval-denied'], ['output', 'codex-output-limit'], ['clock', 'codex-clock-error']]) {
    const f = brokerFixture(t);
    const c = f.control();
    f.state.outcome = outcome;
    assert.equal((await c.run(input)).errorCode, errorCode);
    assert.equal(f.owners.size, 0);
    const count = f.servers.length;
    f.state.outcome = 'completed';
    f.state.clockTime = 1000;
    const refused = await c.run(input);
    assert.equal(refused.status, 'failed');
    assert.equal(f.servers.length, count, 'a fatal controller never silently starts another worker');
    assert.equal(c.recoveryState().recoverable, false);
    assert.equal(c.recoveryState().errorCode, errorCode);
    if (outcome === 'approval') assert.ok(f.requests.some(r => r.id === 'synthetic-approval' && r.error?.code === -32000));
    for (const request of f.requests.filter(r => ['thread/start', 'thread/resume', 'turn/start'].includes(r.method))) {
      assert.equal(request.params.approvalPolicy, 'on-request');
      assert.equal(request.params.approvalsReviewer, 'user');
      if (request.method === 'turn/start') assert.deepEqual(request.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
      else assert.equal(request.params.sandbox, 'read-only');
    }
  }
});

test('unconfirmed worker shutdown keeps app leases and fails closed despite an early exit field', { timeout: 5000 }, async t => {
  const f = brokerFixture(t);
  const c = f.control();
  const external = { role: 'synthetic-external', signals: [] };
  f.owners.set(THREAD_B, external);
  f.state.ignoreWorkerExit = true;
  const result = await c.run(input);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'codex-cleanup-unconfirmed');
  assert.equal(c.recoveryState().recoverable, false);
  assert.equal(c.recoveryState().errorCode, 'codex-cleanup-unconfirmed');
  assert.equal((await c.accountStatus()).status, 'unavailable');
  const worker = f.servers.find(s => s.role === 'worker');
  assert.equal(worker.exited, false);
  assert.equal(worker.child.exitCode, 0, 'the fixture models exit observed before close');
  assert.ok(worker.signals.includes('SIGTERM'));
  assert.equal(f.owners.get(THREAD_A), worker);
  assert.deepEqual(external.signals, []);
  const count = f.servers.length;
  assert.equal((await c.run(resume(THREAD_A))).status, 'failed');
  assert.equal(f.servers.length, count, 'a cleanup failure cannot start a replacement worker');
  assert.equal((await f.control().run(resume(THREAD_A))).errorCode, 'codex-busy');
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
  assert.ok(fs.readdirSync(path.join(f.workspace, '.local-run', 'codex-control-locks')).length > 0);
  f.releaseWorkerExits();
});

test('replacing the workspace after facade construction never authorizes the replacement directory', async t => {
  const f = brokerFixture(t);
  const c = f.control();
  fs.renameSync(f.workspace, f.workspace + '-original');
  fs.mkdirSync(f.workspace);
  fs.writeFileSync(path.join(f.workspace, 'README.md'), '# Unapproved replacement fixture\n');
  const result = await c.run(input);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'workspace-changed');
  assert.equal(f.requests.some(r => ['thread/start', 'thread/resume', 'turn/start'].includes(r.method)), false);
  assert.equal(f.owners.size, 0);
});
