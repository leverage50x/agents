import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createCodexControl, CODEX_CONTROL_TOOL_POLICY_VERIFIED } from '../src/codex-control.mjs';
import { fixture } from '../test-support/fixtures.mjs';

const threadId = '11111111-1111-1111-1111-111111111111';
const otherId = '22222222-2222-2222-2222-222222222222';
const turnId = '33333333-3333-3333-3333-333333333333';
const newInput = { mode: 'new', workspaceId: 'project', prompt: 'Summarize the supplied README.', confirmed: true };

function fakeCodex(t, behavior = {}) {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, 'README.md'), '# Synthetic project\nRead-only fixture.\n');
  const calls = [];
  const requests = [];
  const children = [];
  const turnIds = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (behavior.spawnFailure) throw new Error('Synthetic private startup diagnostic.');
    const child = new EventEmitter();
    child.pid = 999999; child.exitCode = null; child.signalCode = null;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const reply = message => child.stdout.write(JSON.stringify(message) + '\n');
    child.kill = signal => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      child.signalCode = signal;
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      for (const line of chunk.toString().trim().split('\n').filter(Boolean)) {
        const message = JSON.parse(line); requests.push(message);
        if (!message.method) continue;
        queueMicrotask(() => {
          if (message.method === 'initialized') return;
          if (behavior.hang === message.method) return;
          if (behavior.serverRequest === message.method) {
            return reply({ id: 'synthetic-approval', method: 'item/commandExecution/requestApproval',
              params: { command: 'SYNTHETIC_NEVER_EXECUTE' } });
          }
          if (behavior.badJson === message.method) return child.stdout.write('invalid-json\n');
          if (behavior.error === message.method) return reply({ id: message.id,
            error: { code: -32000, message: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' } });
          const response = result => reply({ id: message.id, result });
          switch (message.method) {
            case 'initialize': response({}); break;
            case 'account/read': response({ account: behavior.unauthenticated ? null : {
              type: 'chatgpt', email: 'synthetic-private-account@example.com', planType: 'synthetic-private-plan',
            }, requiresOpenaiAuth: true }); break;
            case 'thread/list': response({ data: behavior.rows || [{ id: threadId, cwd: f.workspace,
              updatedAt: 1700000000, preview: 'SYNTHETIC_PRIVATE_PREVIEW', name: 'SYNTHETIC_PRIVATE_TITLE',
              turns: [{ text: 'SYNTHETIC_PRIVATE_HISTORY' }], status: { type: 'notLoaded' } }], nextCursor: null }); break;
            case 'thread/start':
            case 'thread/resume': {
              const responseWorkspace = behavior.foreignResponse ? '/synthetic/foreign-workspace' : f.workspace;
              response({ cwd: responseWorkspace,
              sandbox: { type: behavior.unsafePolicy ? 'workspaceWrite' : 'readOnly', networkAccess: false },
              approvalPolicy: 'on-request', approvalsReviewer: 'user',
              thread: { id: threadId, cwd: responseWorkspace, status: { type: behavior.busy ? 'active' : 'idle' },
                turns: [{ text: 'SYNTHETIC_PRIVATE_HISTORY' }] } }); break;
            }
            case 'turn/start': {
              const currentTurnId = behavior.sequentialTurns
                ? (turnIds.length + 1).toString(16).padStart(8, '0') + '-3333-3333-3333-333333333333' : turnId;
              turnIds.push(currentTurnId);
              response({ turn: { id: currentTurnId, status: 'inProgress', items: [] } });
              if (behavior.turnHang) break;
              const method = behavior.toolNotification ? 'item/started' : 'item/agentMessage/delta';
              reply({ method, params: { threadId, turnId: currentTurnId,
                ...(behavior.toolNotification ? { item: { id: 'synthetic-tool', type: 'commandExecution' } } :
                  { itemId: 'synthetic-message', delta: behavior.output || 'Synthetic README summary.' }) } });
              reply({ method: 'turn/completed', params: { threadId,
                turn: { id: currentTurnId, status: behavior.failedTurn ? 'failed' : 'completed', items: [] } } });
              break;
            }
            default: assert.fail('Unexpected Codex RPC method: ' + message.method);
          }
        });
      }
      callback();
    } });
    children.push(child);
    if (args[0] === '--version') queueMicrotask(() => {
      child.stdout.write('codex-cli ' + (behavior.version || '0.163.0') + '\n');
      child.exitCode = 0; child.emit('close', 0, null);
    });
    return child;
  };
  const control = createCodexControl({ workspace: f.workspace, home: f.home, spawnImpl,
    externalActivityCheck: behavior.defaultActivityCheck ? undefined : () => behavior.externalActivity || 'clear',
    rpcTimeoutMs: 100, turnTimeoutMs: 100, ...(behavior.now ? { now: behavior.now } : {}) });
  t.after(() => control.close());
  return { ...f, calls, requests, children, turnIds, control, spawnImpl };
}

test('control validates one local workspace and rejects Windows executable configuration', t => {
  const f = fixture(t);
  assert.throws(() => createCodexControl({ workspace: 'relative' }), /workspace/);
  assert.throws(() => createCodexControl({ workspace: f.workspace, command: 'powershell.exe' }), /configuration/);
  assert.throws(() => createCodexControl({ workspace: f.workspace, command: '/mnt/c/tools/codex' }), /configuration/);
});

test('accountStatus reports authentication without returning account PII or refreshing tokens', async t => {
  const f = fakeCodex(t);
  assert.deepEqual(await f.control.accountStatus(), { status: 'authenticated' });
  assert.equal(f.requests.find(request => request.method === 'account/read').params.refreshToken, false);
  assert.equal(f.calls.length, 2);
  await f.control.accountStatus();
  assert.equal(f.calls.length, 2, 'Persistent child and version check are reused.');
  assert.ok(f.calls.every(call => call.command === 'codex' && call.options.shell === false));
  assert.ok(f.calls.every(call => !('LEVERAGE_AGENT_TOKEN' in call.options.env) && !('OPENAI_API_KEY' in call.options.env)));
  assert.doesNotMatch(JSON.stringify(await f.control.accountStatus()), /email|plan|PRIVATE|private/);
});

test('missing login is distinct from an unavailable or incompatible CLI', async t => {
  const noLogin = fakeCodex(t, { unauthenticated: true });
  assert.deepEqual(await noLogin.control.accountStatus(), { status: 'not-authenticated' });
  const unavailable = fakeCodex(t, { version: '0.100.0' });
  assert.deepEqual(await unavailable.control.accountStatus(), { status: 'unavailable' });
  assert.equal(unavailable.calls.length, 1, 'Unknown CLI must not start an App Server.');
  const rejected = fakeCodex(t, { error: 'account/read' });
  assert.deepEqual(await rejected.control.accountStatus(), { status: 'unavailable' });
});

test('session inventory is DB-only, scoped to the configured workspace and sanitized', async t => {
  const f = fakeCodex(t);
  const result = await f.control.listSessions();
  assert.deepEqual(result.sessions, [{ id: threadId, modified: new Date(1700000000000).toISOString(),
    lastActivity: new Date(1700000000000).toISOString(), project: 'workspace', source: 'app-server',
    activity: 'discovered', eligibility: 'discovered' }]);
  const request = f.requests.find(request => request.method === 'thread/list');
  assert.equal(request.params.cwd, f.workspace);
  assert.equal(request.params.useStateDbOnly, true);
  assert.equal(request.params.limit, 40);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|preview|turns|cwd|example\.invalid/);
});

test('all run requests require explicit confirmation, project ID and bounded input', async t => {
  const f = fakeCodex(t);
  for (const input of [{ ...newInput, confirmed: false }, { ...newInput, workspaceId: '/other/workspace' },
    { ...newInput, prompt: 'x'.repeat(2001) }, { ...newInput, mode: 'shell' },
    { ...newInput, threadId }, { ...newInput, mode: 'resume', threadId: 'invalid' }]) {
    assert.equal((await f.control.run(input)).errorCode, 'invalid-local-request');
  }
  assert.equal(f.calls.length, 0);
});

test('verified safety policy cannot be relaxed through run input', async t => {
  assert.equal(CODEX_CONTROL_TOOL_POLICY_VERIFIED, true);
  const f = fakeCodex(t);
  const result = await f.control.run({ ...newInput, sandbox: 'unsafe-synthetic-value', enableTools: true,
    approvalPolicy: 'unsafe-synthetic-value', config: { features: { shell_tool: true } } });
  assert.equal(result.status, 'completed');
  const started = f.requests.find(request => request.method === 'thread/start');
  assert.equal(started.params.config.features.shell_tool, false);
  assert.equal(started.params.sandbox, 'read-only');
  assert.equal(started.params.approvalPolicy, 'on-request');
});

test('server initiated approval is denied and never forwarded to executable code', async t => {
  const f = fakeCodex(t, { serverRequest: 'account/read' });
  assert.deepEqual(await f.control.accountStatus(), { status: 'unavailable' });
  const denial = f.requests.find(request => request.id === 'synthetic-approval');
  assert.equal(denial.error.code, -32000);
  assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
  assert.equal(f.requests.some(request => /shell|command\/exec|process\/|tool\/call/.test(request.method || '')), false);
});

test('malformed JSON, request timeout and closure fail safely without raw diagnostics', async t => {
  const badJson = fakeCodex(t, { badJson: 'account/read' });
  assert.deepEqual(await badJson.control.accountStatus(), { status: 'unavailable' });
  const hanging = fakeCodex(t, { hang: 'account/read' });
  assert.deepEqual(await hanging.control.accountStatus(), { status: 'unavailable' });
  await hanging.control.close();
  assert.deepEqual(await hanging.control.accountStatus(), { status: 'unavailable' });
});

test('new read-only turn validates returned restrictions and emits bounded, safe events', async t => {
  const f = fakeCodex(t); const events = [];
  const result = await f.control.run(newInput, event => events.push(event));
  assert.equal(result.status, 'completed'); assert.equal(result.threadId, threadId);
  assert.equal(result.output, 'Synthetic README summary.');
  const started = f.requests.find(request => request.method === 'thread/start');
  assert.deepEqual(started.params.config.mcp_servers, {});
  assert.deepEqual(started.params.config.plugins, {});
  assert.equal(started.params.config.features.shell_tool, false);
  assert.equal(started.params.config.features.apps, false);
  assert.equal(started.params.config.features.hooks, false);
  assert.equal(started.params.config.features.browser_use, false);
  const turn = f.requests.find(request => request.method === 'turn/start');
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turn.params.approvalPolicy, 'on-request');
  assert.equal(turn.params.approvalsReviewer, 'user');
  assert.match(turn.params.input[0].text, /Synthetic project/);
  assert.ok(events.some(event => event.type === 'completed'));
  assert.ok(events.every(event => ['progress', 'output', 'error', 'completed'].includes(event.type)));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_HISTORY/);
});

test('resume uses fresh metadata, excludes history hydration and rejects external busy sessions', async t => {
  const f = fakeCodex(t);
  const result = await f.control.run({ ...newInput, mode: 'resume', threadId });
  assert.equal(result.status, 'completed');
  const resume = f.requests.find(request => request.method === 'thread/resume');
  assert.equal(resume.params.excludeTurns, true);
  assert.deepEqual(resume.params.config.mcp_servers, {});
  assert.equal(f.requests.some(request => /thread\/read|thread\/turns|thread\/items/.test(request.method || '')), false);
  const busy = fakeCodex(t, { externalActivity: 'busy' });
  assert.equal((await busy.control.run({ ...newInput, mode: 'resume', threadId })).errorCode, 'codex-busy');
  assert.equal(busy.requests.some(request => request.method === 'thread/resume'), false);
  const unknown = fakeCodex(t, { externalActivity: 'unknown' });
  assert.equal((await unknown.control.run({ ...newInput, mode: 'resume', threadId })).errorCode, 'session-activity-unverified');
});

test('synthetic New then Resume retains the app-created thread and read-only policy across distinct turns', async t => {
  const f = fakeCodex(t, { sequentialTurns: true });
  const created = await f.control.run(newInput);
  assert.equal(created.status, 'completed');
  const inventory = await f.control.listSessions();
  assert.equal(inventory.sessions.find(session => session.id === created.threadId).eligibility, 'confirmed');
  const resumed = await f.control.run({ ...newInput, mode: 'resume', threadId: created.threadId,
    prompt: 'Continue the synthetic analysis in this explicitly selected thread.' });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.threadId, created.threadId);
  assert.equal(f.turnIds.length, 2);
  assert.notEqual(f.turnIds[0], f.turnIds[1]);
  assert.equal(f.requests.filter(request => request.method === 'thread/start').length, 1);
  const resume = f.requests.find(request => request.method === 'thread/resume');
  assert.equal(resume.params.threadId, created.threadId);
  assert.equal(resume.params.excludeTurns, true);
  const turns = f.requests.filter(request => request.method === 'turn/start');
  assert.equal(turns.length, 2);
  for (const request of f.requests.filter(request => ['thread/start', 'thread/resume', 'turn/start'].includes(request.method))) {
    assert.equal(request.params.approvalPolicy, 'on-request');
    assert.equal(request.params.approvalsReviewer, 'user');
    assert.equal(request.params.cwd, f.workspace);
    if (request.method === 'turn/start') {
      assert.deepEqual(request.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
      assert.equal(request.params.threadId, created.threadId);
    } else {
      assert.equal(request.params.sandbox, 'read-only');
      assert.deepEqual(request.params.config.mcp_servers, {});
      assert.deepEqual(request.params.config.plugins, {});
      assert.equal(request.params.config.features.shell_tool, false);
    }
  }
  assert.equal(f.requests.some(request => /thread\/read|thread\/turns|thread\/items/.test(request.method || '')), false);
});

test('a stale selection or foreign-workspace inventory fails unavailable before thread/resume', async t => {
  const rows = [];
  const stale = fakeCodex(t, { rows });
  rows.push({ id: threadId, cwd: stale.workspace, updatedAt: 1700000000, status: { type: 'notLoaded' } });
  assert.equal((await stale.control.listSessions()).sessions.length, 1);
  rows.length = 0;
  const staleResult = await stale.control.run({ ...newInput, mode: 'resume', threadId });
  assert.equal(staleResult.errorCode, 'session-unavailable');
  assert.equal(stale.requests.some(request => request.method === 'thread/resume'), false);
  const foreign = fakeCodex(t, { rows: [{ id: threadId, cwd: '/synthetic/foreign-workspace', updatedAt: 1700000000 }] });
  const foreignResult = await foreign.control.run({ ...newInput, mode: 'resume', threadId });
  assert.equal(foreignResult.errorCode, 'session-unavailable');
  assert.equal(foreign.requests.some(request => request.method === 'thread/resume'), false);
  assert.equal(foreign.requests.some(request => request.method === 'turn/start'), false);
});

test('active resume responses and foreign workspace responses stop without a new turn', async t => {
  const busy = fakeCodex(t, { busy: true });
  const busyResult = await busy.control.run({ ...newInput, mode: 'resume', threadId });
  assert.equal(busyResult.errorCode, 'codex-busy');
  assert.equal(busy.requests.filter(request => request.method === 'thread/resume').length, 1);
  assert.equal(busy.requests.some(request => request.method === 'turn/start'), false);
  const foreign = fakeCodex(t, { foreignResponse: true });
  const foreignResult = await foreign.control.run({ ...newInput, mode: 'resume', threadId });
  assert.equal(foreignResult.errorCode, 'codex-policy-mismatch');
  assert.equal(foreign.requests.some(request => request.method === 'turn/start'), false);
  assert.deepEqual(foreign.control.recoveryState(), { recoverable: false, errorCode: 'codex-policy-mismatch' });
});

test('a resumed thread disappearing at the server produces only a safe rejection, never a replacement session', async t => {
  const f = fakeCodex(t, { error: 'thread/resume' });
  const result = await f.control.run({ ...newInput, mode: 'resume', threadId });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'codex-request-rejected');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DIAGNOSTIC|PRIVATE_HISTORY/);
  assert.equal(f.requests.some(request => request.method === 'thread/start'), false);
  assert.equal(f.requests.some(request => request.method === 'turn/start'), false);
});

test('same-workspace external Codex remains busy even for an app-created confirmed thread', async t => {
  const f = fakeCodex(t, { defaultActivityCheck: true, sequentialTurns: true });
  const readdir = fs.readdirSync; const stat = fs.statSync; const readlink = fs.readlinkSync; const read = fs.readFileSync;
  t.mock.method(fs, 'readdirSync', (name, ...args) => name === '/proc' ? ['4001'] : readdir(name, ...args));
  t.mock.method(fs, 'statSync', (name, ...args) => name === '/proc/4001' ? { uid: process.getuid() } : stat(name, ...args));
  t.mock.method(fs, 'readlinkSync', (name, ...args) => {
    if (name === '/proc/4001/exe') return '/synthetic/codex';
    if (name === '/proc/4001/cwd') return f.workspace;
    return readlink(name, ...args);
  });
  t.mock.method(fs, 'readFileSync', (name, ...args) => name === '/proc/4001/stat' ? '4001 (codex) S 1 0 0 0' : read(name, ...args));
  const created = await f.control.run(newInput);
  assert.equal(created.status, 'completed');
  assert.equal((await f.control.listSessions()).sessions[0].eligibility, 'confirmed');
  const resumed = await f.control.run({ ...newInput, mode: 'resume', threadId: created.threadId });
  assert.equal(resumed.errorCode, 'codex-busy');
  assert.equal(f.requests.some(request => request.method === 'thread/resume'), false);
  assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 1);
});

test('unreadable owned process metadata blocks Resume until a later explicit request can verify clear activity', async t => {
  const f = fakeCodex(t, { defaultActivityCheck: true, sequentialTurns: true });
  const readdir = fs.readdirSync; const stat = fs.statSync; const readlink = fs.readlinkSync;
  let unreadableOwnedProcess = true;
  t.mock.method(fs, 'readdirSync', (name, ...args) => name === '/proc'
    ? (unreadableOwnedProcess ? ['4002'] : []) : readdir(name, ...args));
  t.mock.method(fs, 'statSync', (name, ...args) => name === '/proc/4002' ? { uid: process.getuid() } : stat(name, ...args));
  t.mock.method(fs, 'readlinkSync', (name, ...args) => {
    if (name === '/proc/4002/exe') throw Object.assign(new Error('Synthetic denied process metadata.'), { code: 'EACCES' });
    return readlink(name, ...args);
  });
  const created = await f.control.run(newInput);
  assert.equal(created.status, 'completed');
  const input = { ...newInput, mode: 'resume', threadId: created.threadId };
  const blocked = await f.control.run(input);
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.errorCode, 'session-activity-unverified');
  assert.equal(f.requests.some(request => request.method === 'thread/resume'), false);
  assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 1);
  assert.equal((await f.control.accountStatus()).status, 'authenticated');
  assert.deepEqual(f.control.recoveryState(), { recoverable: false, errorCode: null });
  unreadableOwnedProcess = false;
  const resumed = await f.control.run(input);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.threadId, created.threadId);
  assert.equal(f.requests.filter(request => request.method === 'thread/resume').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 2);
});

test('unsafe returned policy and unexpected model tools stop before unsafe continuation', async t => {
  const unsafe = fakeCodex(t, { unsafePolicy: true });
  assert.equal((await unsafe.control.run(newInput)).errorCode, 'codex-policy-mismatch');
  assert.equal(unsafe.requests.some(request => request.method === 'turn/start'), false);
  const tools = fakeCodex(t, { toolNotification: true });
  assert.equal((await tools.control.run(newInput)).status, 'failed');
});

test('lease rejects concurrent controllers, persists private locks and releases after close', async t => {
  const f = fakeCodex(t, { turnHang: true });
  const running = f.control.run(newInput);
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = createCodexControl({ workspace: f.workspace, home: f.home, spawnImpl: f.spawnImpl });
  t.after(() => second.close());
  assert.equal((await second.run(newInput)).errorCode, 'codex-busy');
  const directory = path.join(f.workspace, '.local-run', 'codex-control-locks');
  for (const filename of fs.readdirSync(directory)) assert.equal(fs.statSync(path.join(directory, filename)).mode & 0o777, 0o600);
  await f.control.close();
  assert.equal((await running).status, 'interrupted');
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('README symlinks are refused and model output is bounded and redacted', async t => {
  const f = fakeCodex(t);
  fs.unlinkSync(path.join(f.workspace, 'README.md'));
  fs.symlinkSync(path.join(f.root, 'outside-file'), path.join(f.workspace, 'README.md'));
  assert.equal((await f.control.run(newInput)).errorCode, 'workspace-context-unavailable');
  assert.equal(f.requests.some(request => request.method === 'thread/start'), false);
  const output = fakeCodex(t, { output: 'sk-' + 'a'.repeat(32) + ' ' + 'x'.repeat(10000) });
  const result = await output.control.run(newInput);
  assert.equal(result.status, 'completed');
  assert.ok(result.output.length <= 8000); assert.doesNotMatch(result.output, /sk-a{20}/);
});

test('stored file existence alone never makes an unknown session executable', async t => {
  const f = fakeCodex(t);
  assert.equal((await f.control.run({ ...newInput, mode: 'resume', threadId: otherId })).errorCode, 'session-unavailable');
  assert.equal(f.requests.some(request => request.method === 'thread/resume'), false);
});

test('native Codex children of the owned npm launcher are excluded from external busy detection', async t => {
  const f = fakeCodex(t, { defaultActivityCheck: true });
  const readdir = fs.readdirSync; const stat = fs.statSync; const readlink = fs.readlinkSync; const read = fs.readFileSync;
  t.mock.method(fs, 'readdirSync', (name, ...args) => name === '/proc' ? ['4000'] : readdir(name, ...args));
  t.mock.method(fs, 'statSync', (name, ...args) => name === '/proc/4000' ? { uid: process.getuid() } : stat(name, ...args));
  t.mock.method(fs, 'readlinkSync', (name, ...args) => name === '/proc/4000/exe' ? '/synthetic/codex' : readlink(name, ...args));
  t.mock.method(fs, 'readFileSync', (name, ...args) => name === '/proc/4000/stat' ? '4000 (codex) S 999999 0 0 0' : read(name, ...args));
  const result = await f.control.run({ ...newInput, mode: 'resume', threadId });
  assert.equal(result.status, 'completed');
});

test('idle native exit exposes recoverable state without restarting itself', async t => {
  const f = fakeCodex(t);
  assert.deepEqual(f.control.recoveryState(), { recoverable: false, errorCode: null });
  assert.equal((await f.control.accountStatus()).status, 'authenticated');
  const native = f.children.at(-1);
  native.exitCode = 1;
  native.emit('close', 1, null);
  assert.deepEqual(f.control.recoveryState(), { recoverable: true, errorCode: 'codex-unavailable' });
  assert.equal((await f.control.accountStatus()).status, 'unavailable');
  assert.equal(f.calls.length, 2, 'Only the owning agent may recreate an idle failed controller.');
  await f.control.close();
  assert.deepEqual(f.control.recoveryState(), { recoverable: false, errorCode: 'codex-closed' });
});

test('initial startup failure and metadata timeout are safely classified as recoverable', async t => {
  const startup = fakeCodex(t, { spawnFailure: true });
  assert.equal((await startup.control.accountStatus()).status, 'unavailable');
  assert.deepEqual(startup.control.recoveryState(), { recoverable: true, errorCode: 'codex-unavailable' });
  const timeout = fakeCodex(t, { hang: 'account/read' });
  assert.equal((await timeout.control.accountStatus()).status, 'unavailable');
  assert.deepEqual(timeout.control.recoveryState(), { recoverable: true, errorCode: 'codex-timeout' });
});

test('unsupported versions, malformed metadata, approval denial and policy mismatch never request automatic recovery', async t => {
  const version = fakeCodex(t, { version: '0.100.0' });
  await version.control.accountStatus();
  assert.deepEqual(version.control.recoveryState(), { recoverable: false, errorCode: 'codex-version-unsupported' });
  const protocol = fakeCodex(t, { rows: {} });
  assert.equal((await protocol.control.listSessions()).status, 'unavailable');
  assert.deepEqual(protocol.control.recoveryState(), { recoverable: false, errorCode: 'codex-protocol-error' });
  const approval = fakeCodex(t, { serverRequest: 'account/read' });
  await approval.control.accountStatus();
  assert.deepEqual(approval.control.recoveryState(), { recoverable: false, errorCode: 'approval-denied' });
  const policy = fakeCodex(t, { unsafePolicy: true });
  assert.equal((await policy.control.run(newInput)).errorCode, 'codex-policy-mismatch');
  assert.deepEqual(policy.control.recoveryState(), { recoverable: false, errorCode: 'codex-policy-mismatch' });
});

test('long-lived metadata traffic can exceed 32 MiB across separate minutes without poisoning the controller', async t => {
  let time = 1000;
  const f = fakeCodex(t, { now: () => time });
  await f.control.accountStatus();
  const chunk = Buffer.alloc(1048576);
  for (let minute = 0; minute < 3; minute++) {
    time = 1000 + minute * 61000;
    for (let index = 0; index < 31; index++) f.children.at(-1).stderr.write(chunk);
    assert.equal((await f.control.accountStatus()).status, 'authenticated');
    assert.equal((await f.control.listSessions()).status, 'available');
  }
  assert.deepEqual(f.control.recoveryState(), { recoverable: false, errorCode: null });
  assert.equal(f.calls.length, 2, 'Legitimate polling retains one healthy persistent child.');
});

test('a burst over 32 MiB in one rolling minute remains a fatal output limit', async t => {
  const f = fakeCodex(t, { now: () => 1000 });
  await f.control.accountStatus();
  const chunk = Buffer.alloc(1048576);
  for (let index = 0; index < 33; index++) f.children.at(-1).stderr.write(chunk);
  assert.equal((await f.control.accountStatus()).status, 'unavailable');
  assert.deepEqual(f.control.recoveryState(), { recoverable: false, errorCode: 'codex-output-limit' });
});

test('rolling-minute accounting retains recent traffic across a calendar-minute boundary', async t => {
  let time = 1000;
  const f = fakeCodex(t, { now: () => time });
  await f.control.accountStatus();
  const chunk = Buffer.alloc(1048576);
  for (let index = 0; index < 31; index++) f.children.at(-1).stderr.write(chunk);
  time = 60999;
  for (let index = 0; index < 2; index++) f.children.at(-1).stderr.write(chunk);
  assert.deepEqual(f.control.recoveryState(), { recoverable: false, errorCode: 'codex-output-limit' });
});

test('message-size bounds remain enforced and a faulty clock fails closed', async t => {
  const large = fakeCodex(t);
  await large.control.accountStatus();
  large.children.at(-1).stdout.write(Buffer.alloc(2097153, 120));
  assert.deepEqual(large.control.recoveryState(), { recoverable: false, errorCode: 'codex-output-limit' });
  let time = 1000;
  const clock = fakeCodex(t, { now: () => time });
  await clock.control.accountStatus();
  time = 999;
  clock.children.at(-1).stderr.write('synthetic');
  assert.deepEqual(clock.control.recoveryState(), { recoverable: false, errorCode: 'codex-clock-error' });
});

test('an active failed turn ends before its controller can advertise idle recovery', async t => {
  const f = fakeCodex(t, { turnHang: true });
  const running = f.control.run(newInput);
  await new Promise(resolve => setTimeout(resolve, 10));
  const native = f.children.at(-1);
  native.exitCode = 1;
  native.emit('close', 1, null);
  assert.equal(f.control.recoveryState().recoverable, false);
  const result = await running;
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'codex-unavailable');
  assert.deepEqual(f.control.recoveryState(), { recoverable: true, errorCode: 'codex-unavailable' });
  assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 1, 'A failed turn is never replayed.');
});
