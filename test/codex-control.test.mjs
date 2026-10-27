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
const inventoryRow = (index, workspace, extra = {}) => ({
  id: index.toString(16).padStart(8, '0') + '-4444-4444-4444-444444444444',
  cwd: workspace, source: 'cli', updatedAt: 1700000000 + index, status: { type: 'notLoaded' }, ...extra,
});

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
          if (behavior.rpcError?.method === message.method) return reply({ id: message.id,
            error: { code: behavior.rpcError.code, message: behavior.rpcError.message } });
          const response = result => reply({ id: message.id, result });
          switch (message.method) {
            case 'initialize': response({}); break;
            case 'account/read': response({ account: behavior.unauthenticated ? null : {
              type: 'chatgpt', email: 'synthetic-private-account@example.com', planType: 'synthetic-private-plan',
            }, requiresOpenaiAuth: true }); break;
            case 'thread/list': response(behavior.listReply ? behavior.listReply(message.params, f.workspace) :
              { data: behavior.rows || [{ id: threadId, cwd: f.workspace, source: 'cli',
                updatedAt: 1700000000, preview: 'SYNTHETIC_PRIVATE_PREVIEW', name: 'Synthetic named session',
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
              if (behavior.turnBehavior) {
                behavior.turnBehavior({ reply, response, threadId, turnId: currentTurnId });
                break;
              }
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
    rpcTimeoutMs: 100, turnTimeoutMs: 100, ...(behavior.now ? { now: behavior.now } : {}),
    ...behavior.controllerOptions });
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
    lastActivity: new Date(1700000000000).toISOString(), title: 'Synthetic named session', project: 'workspace', source: 'app-server',
    activity: 'discovered', eligibility: 'discovered' }]);
  const request = f.requests.find(request => request.method === 'thread/list');
  assert.equal(request.params.cwd, f.workspace);
  assert.equal(request.params.useStateDbOnly, true);
  assert.equal(request.params.limit, 40);
  assert.deepEqual(request.params.sourceKinds, ['cli', 'vscode']);
  assert.equal(request.params.archived, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|preview|turns|cwd|example\.invalid/);
});

test('CLI Cwd + Active inventory excludes non-interactive, archived, child and foreign rows without fixing a count', async t => {
  const rows = [];
  const f = fakeCodex(t, { rows });
  for (let index = 1; index <= 7; index++) rows.push(inventoryRow(index, f.workspace, { source: { subAgent: { other: 'synthetic' } } }));
  rows.push(inventoryRow(8, f.workspace, { source: 'vscode' }), inventoryRow(9, f.workspace, { source: 'vscode' }));
  const first = await f.control.listSessions();
  assert.equal(first.sessions.length, 2);
  assert.ok(first.sessions.every(session => session.activity === 'discovered'));
  rows.push(inventoryRow(10, f.workspace, { status: { type: 'active', activeFlags: [] } }));
  for (const [index, source] of ['exec', 'appServer', 'unknown', 'subAgent', { custom: 'synthetic' }, undefined].entries()) {
    rows.push(inventoryRow(20 + index, f.workspace, { source }));
  }
  rows.push(inventoryRow(30, f.workspace, { archived: true }), inventoryRow(31, f.workspace, { ephemeral: true }),
    inventoryRow(32, f.workspace, { parentThreadId: threadId }), inventoryRow(33, '/synthetic/foreign-workspace'),
    inventoryRow(34, f.workspace, { id: 'invalid' }), inventoryRow(35, f.workspace, { updatedAt: 'invalid' }));
  const next = await f.control.listSessions();
  assert.equal(next.sessions.length, 3, 'Additional eligible CLI rows must appear; the expected count is never hard-coded.');
  assert.equal(next.sessions.find(session => session.id === inventoryRow(10, f.workspace).id).eligibility, 'busy');
  assert.equal(next.truncated, false);
});

test('pagination filters every page before the limit and deduplicates UUIDs using the latest metadata', async t => {
  const f = fakeCodex(t, { listReply: (params, workspace) => {
    if (!params.cursor) return { data: Array.from({ length: 40 }, (_, index) =>
      inventoryRow(index + 100, workspace, { source: { subAgent: { other: 'synthetic' } } })), nextCursor: 'second' };
    if (params.cursor === 'second') return { data: [inventoryRow(10, workspace),
      inventoryRow(10, workspace, { id: inventoryRow(10, workspace).id.toUpperCase(), updatedAt: 1700000015, name: 'Latest metadata title' }),
      inventoryRow(20, workspace), inventoryRow(21, workspace, { archived: true })], nextCursor: 'third' };
    return { data: [inventoryRow(30, workspace)], nextCursor: null };
  } });
  const result = await f.control.listSessions();
  assert.equal(result.status, 'available');
  assert.deepEqual(result.sessions.map(session => session.id), [30, 20, 10].map(index => inventoryRow(index, f.workspace).id));
  assert.equal(result.sessions.find(session => session.id === inventoryRow(10, f.workspace).id).title, 'Latest metadata title');
  assert.equal(result.truncated, false);
  const requests = f.requests.filter(request => request.method === 'thread/list');
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(request => request.params.limit), [40, 40, 38]);
  for (const request of requests) {
    assert.deepEqual(request.params.sourceKinds, ['cli', 'vscode']);
    assert.equal(request.params.archived, false);
    assert.equal(request.params.cwd, f.workspace);
    assert.equal(request.params.useStateDbOnly, true);
    assert.equal(request.params.sortKey, 'updated_at');
    assert.equal(request.params.sortDirection, 'desc');
  }
});

test('inventory caps eligible sessions at 40 after filtering and sorting a server page', async t => {
  const f = fakeCodex(t, { listReply: (_params, workspace) => ({
    data: [inventoryRow(100, workspace, { source: 'unknown' }),
      ...Array.from({ length: 45 }, (_, index) => inventoryRow(index + 1, workspace))], nextCursor: null,
  }) });
  const result = await f.control.listSessions();
  assert.equal(result.sessions.length, 40);
  assert.equal(result.truncated, true);
  assert.equal(result.sessions[0].id, inventoryRow(45, f.workspace).id);
  assert.equal(result.sessions.at(-1).id, inventoryRow(6, f.workspace).id);
});

test('cursor cycles and page bounds stop safely while invalid cursors fail closed', async t => {
  const cycle = fakeCodex(t, { listReply: (_params, workspace) => ({ data: [inventoryRow(1, workspace)], nextCursor: 'repeat' }) });
  const repeated = await cycle.control.listSessions();
  assert.equal(repeated.truncated, true);
  assert.equal(cycle.requests.filter(request => request.method === 'thread/list').length, 2);
  const bounded = fakeCodex(t, { listReply: (params, workspace) => ({ data: [inventoryRow(1, workspace)],
    nextCursor: String(Number(params.cursor || 0) + 1) }) });
  assert.equal((await bounded.control.listSessions()).truncated, true);
  assert.equal(bounded.requests.filter(request => request.method === 'thread/list').length, 8);
  for (const nextCursor of [12, 'x'.repeat(4097)]) {
    const invalid = fakeCodex(t, { listReply: () => ({ data: [], nextCursor }) });
    assert.equal((await invalid.control.listSessions()).status, 'unavailable');
    assert.deepEqual(invalid.control.recoveryState(), { recoverable: false, errorCode: 'codex-protocol-error' });
  }
});

test('titles use bounded name metadata only and never preview, transcripts, paths or credentials', async t => {
  const markup = '<img src=x onerror="synthetic()">';
  const f = fakeCodex(t, { listReply: (_params, workspace) => ({ data: [
    inventoryRow(1, workspace, { name: '  A   named session  ', preview: 'SYNTHETIC_PRIVATE_PREVIEW', turns: [{ text: 'SYNTHETIC_PRIVATE_HISTORY' }] }),
    inventoryRow(2, workspace, { preview: 'SYNTHETIC_NEVER_FALLBACK' }),
    inventoryRow(3, workspace, { name: 'synthetic@example.com' }), inventoryRow(4, workspace, { name: '/synthetic/private-project' }),
    inventoryRow(5, workspace, { name: 'sk-' + 'a'.repeat(32) }), inventoryRow(6, workspace, { name: 'Unsafe\ncontrol' }),
    inventoryRow(7, workspace, { name: 'Ședință '.repeat(40) }), inventoryRow(8, workspace, { name: markup }),
  ], nextCursor: null }) });
  const result = await f.control.listSessions();
  const session = index => result.sessions.find(item => item.id === inventoryRow(index, f.workspace).id);
  assert.equal(session(1).title, 'A named session');
  for (const index of [2, 3, 4, 5, 6]) assert.equal(session(index).title, undefined);
  assert.ok(Buffer.byteLength(session(7).title) <= 120);
  assert.ok(session(7).title.endsWith('…'));
  assert.equal(session(7).title, session(7).title.toWellFormed());
  assert.equal(session(8).title, markup, 'Title remains plain data; the dashboard must HTML-escape it when rendering.');
  assert.ok(result.sessions.every(item => !Object.hasOwn(item, 'name') && !Object.hasOwn(item, 'preview') && !Object.hasOwn(item, 'turns')));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PREVIEW|PRIVATE_HISTORY|NEVER_FALLBACK|synthetic@example/);
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

test('completed agent-message text is authoritative even when no deltas were emitted', async t => {
  const f = fakeCodex(t, { turnBehavior: ({ response, reply, threadId, turnId }) => {
    response({ turn: { id: turnId, status: 'inProgress', items: [] } });
    reply({ method: 'item/completed', params: { threadId, turnId, completedAtMs: 1,
      item: { type: 'agentMessage', id: 'message', text: 'Authoritative final answer.' } } });
    reply({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [] } } });
  } });
  assert.equal((await f.control.run(newInput)).output, 'Authoritative final answer.');
});

test('matching early completion survives an unrelated same-thread completion before the start reply', async t => {
  const f = fakeCodex(t, { turnBehavior: ({ response, reply, threadId, turnId }) => {
    reply({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed',
      items: [{ type: 'agentMessage', id: 'final-message', text: 'Matched early completion.' }] } } });
    reply({ method: 'turn/completed', params: { threadId, turn: { id: otherId, status: 'completed', items: [] } } });
    response({ turn: { id: turnId, status: 'inProgress', items: [] } });
  } });
  const result = await f.control.run(newInput);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'Matched early completion.');
});

test('RPC acknowledgement timeout is distinct from a model-turn timeout and never retries', async t => {
  const f = fakeCodex(t, { controllerOptions: { rpcTimeoutMs: 50, idleTimeoutMs: 200, turnTimeoutMs: 300 }, turnHang: true, hang: 'turn/start' });
  const result = await f.control.run(newInput);
  assert.equal(result.errorCode, 'codex-rpc-timeout');
  assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 1);
});

test('model-turn deadlines begin after the bounded RPC acknowledgement phase', async t => {
  let timer;
  t.after(() => clearTimeout(timer));
  const f = fakeCodex(t, { controllerOptions: { rpcTimeoutMs: 300, idleTimeoutMs: 50, turnTimeoutMs: 50 },
    turnBehavior: ({ response, reply, threadId, turnId }) => {
      timer = setTimeout(() => {
        response({ turn: { id: turnId, status: 'inProgress', items: [] } });
        reply({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed',
          items: [{ type: 'agentMessage', id: 'final', text: 'Completed after acknowledgement.' }] } } });
      }, 80);
    } });
  const result = await f.control.run(newInput);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'Completed after acknowledgement.');
});

test('a complete agent message and terminal start response do not replace turn/completed', async t => {
  const f = fakeCodex(t, { controllerOptions: { idleTimeoutMs: 50, turnTimeoutMs: 200 },
    turnBehavior: ({ response, reply, threadId, turnId }) => {
      const item = { type: 'agentMessage', id: 'complete-message', text: 'Finished item, missing terminal notification.' };
      response({ turn: { id: turnId, status: 'completed', items: [item] } });
      reply({ method: 'item/completed', params: { threadId, turnId, completedAtMs: 1, item } });
    } });
  const result = await f.control.run(newInput);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'codex-idle-timeout');
  assert.equal(result.output, 'Finished item, missing terminal notification.');
});

test('unrelated traffic cannot reset the idle timer and a timeout retains sanitized partial output', async t => {
  let interval;
  t.after(() => clearInterval(interval));
  const f = fakeCodex(t, { controllerOptions: { rpcTimeoutMs: 100, idleTimeoutMs: 60, turnTimeoutMs: 300 },
    turnBehavior: ({ response, reply, threadId, turnId }) => {
      response({ turn: { id: turnId, status: 'inProgress', items: [] } });
      reply({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'partial', delta: 'Partial answer ' } });
      interval = setInterval(() => reply({ method: 'item/agentMessage/delta',
        params: { threadId, turnId: otherId, itemId: 'foreign', delta: 'SYNTHETIC_FOREIGN_MUST_NOT_APPEAR' } }), 15);
    } });
  const result = await f.control.run(newInput);
  clearInterval(interval);
  assert.equal(result.errorCode, 'codex-idle-timeout');
  assert.equal(result.output, 'Partial answer ');
});

test('matching reasoning activity resets idle but cannot extend the absolute turn deadline', async t => {
  let interval;
  t.after(() => clearInterval(interval));
  const f = fakeCodex(t, { controllerOptions: { rpcTimeoutMs: 100, idleTimeoutMs: 60, turnTimeoutMs: 160 },
    turnBehavior: ({ response, reply, threadId, turnId }) => {
      response({ turn: { id: turnId, status: 'inProgress', items: [] } });
      reply({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'partial', delta: 'Visible answer ' } });
      interval = setInterval(() => reply({ method: 'item/reasoning/summaryTextDelta',
        params: { threadId, turnId, itemId: 'reasoning', delta: 'SYNTHETIC_REASONING_MUST_NOT_APPEAR' } }), 15);
    } });
  const events = [];
  const result = await f.control.run(newInput, event => events.push(event));
  clearInterval(interval);
  assert.equal(result.errorCode, 'codex-turn-timeout');
  assert.equal(result.output, 'Visible answer ');
  assert.doesNotMatch(JSON.stringify({ result, events }), /REASONING_MUST_NOT_APPEAR/);
});

test('output events are redacted replacement snapshots and final item text replaces streamed deltas', async t => {
  const f = fakeCodex(t, { turnBehavior: ({ response, reply, threadId, turnId }) => {
    response({ turn: { id: turnId, status: 'inProgress', items: [] } });
    queueMicrotask(() => {
    reply({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'message', delta: 'Visible text sk-' + 'a'.repeat(10) } });
    reply({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'message', delta: 'a'.repeat(22) + ' ' } });
    reply({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'message', delta: 'Bearer ' + 'b'.repeat(12) } });
    reply({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'message', delta: 'b'.repeat(12) + ' ' } });
    reply({ method: 'item/completed', params: { threadId, turnId, completedAtMs: 1,
      item: { type: 'agentMessage', id: 'message', text: 'Canonical final answer.' } } });
    reply({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [] } } });
    });
  } });
  const events = [];
  const result = await f.control.run(newInput, event => events.push(event));
  assert.equal(result.output, 'Canonical final answer.');
  const outputs = events.filter(event => event.type === 'output').map(event => event.message);
  assert.ok(outputs.some(output => output.startsWith('Visible text ')));
  assert.equal(outputs.at(-1), result.output);
  assert.ok(outputs.every(output => !output.includes('sk-')));
  assert.ok(outputs.every(output => !output.includes('Bearer b')));
});

test('resume uses fresh metadata and acquires native ownership without history hydration', async t => {
  const f = fakeCodex(t);
  const result = await f.control.run({ ...newInput, mode: 'resume', threadId });
  assert.equal(result.status, 'completed');
  const resume = f.requests.find(request => request.method === 'thread/resume');
  assert.equal(resume.params.excludeTurns, true);
  assert.deepEqual(resume.params.config.mcp_servers, {});
  assert.equal(f.requests.some(request => /thread\/read|thread\/turns|thread\/items/.test(request.method || '')), false);
});

test('synthetic New then Resume retains the app-created thread and read-only policy across distinct turns', async t => {
  const f = fakeCodex(t, { sequentialTurns: true });
  const created = await f.control.run(newInput);
  assert.equal(created.status, 'completed');
  const inventory = await f.control.listSessions();
  assert.equal(inventory.sessions.find(session => session.id === created.threadId).eligibility, 'discovered', 'The finished worker released ownership.');
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
  rows.push({ id: threadId, cwd: stale.workspace, source: 'cli', updatedAt: 1700000000, status: { type: 'notLoaded' } });
  assert.equal((await stale.control.listSessions()).sessions.length, 1);
  rows.length = 0;
  const staleResult = await stale.control.run({ ...newInput, mode: 'resume', threadId });
  assert.equal(staleResult.errorCode, 'session-unavailable');
  assert.equal(stale.requests.some(request => request.method === 'thread/resume'), false);
  const foreign = fakeCodex(t, { rows: [{ id: threadId, cwd: '/synthetic/foreign-workspace', source: 'cli', updatedAt: 1700000000 }] });
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

test('other Codex processes in the same workspace do not block native ownership of a different thread', async t => {
  const f = fakeCodex(t, { sequentialTurns: true });
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (name, ...args) => {
    assert.notEqual(name, '/proc', 'A workspace-wide process scan cannot determine thread ownership.');
    return readdir(name, ...args);
  });
  const created = await f.control.run(newInput);
  assert.equal(created.status, 'completed');
  assert.equal((await f.control.listSessions()).sessions[0].eligibility, 'discovered');
  const resumed = await f.control.run({ ...newInput, mode: 'resume', threadId: created.threadId });
  assert.equal(resumed.status, 'completed');
  assert.equal(f.requests.filter(request => request.method === 'thread/resume').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 2);
});

test('native selected-thread writer conflict blocks even a confirmed thread until explicitly retried after release', async t => {
  const behavior = { sequentialTurns: true };
  const f = fakeCodex(t, behavior);
  const created = await f.control.run(newInput);
  assert.equal(created.status, 'completed');
  const input = { ...newInput, mode: 'resume', threadId: created.threadId };
  behavior.rpcError = { method: 'thread/resume', code: -32600,
    message: 'error resuming thread: thread ' + threadId + ' already has an active writer' };
  const blocked = await f.control.run(input);
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.errorCode, 'codex-busy');
  assert.doesNotMatch(JSON.stringify(blocked), /already has an active writer|error resuming/);
  assert.equal(f.requests.filter(request => request.method === 'thread/resume').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 1);
  assert.equal((await f.control.accountStatus()).status, 'authenticated');
  assert.deepEqual(f.control.recoveryState(), { recoverable: false, errorCode: null });
  behavior.rpcError = null;
  const resumed = await f.control.run(input);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.threadId, created.threadId);
  assert.equal(f.requests.filter(request => request.method === 'thread/resume').length, 2);
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

test('unverified writer errors reject without raw diagnostics, fallback or a model turn', async t => {
  for (const error of [
    { code: -32600, message: 'thread ' + otherId + ' already has an active writer' },
    { code: -32000, message: 'thread ' + threadId + ' already has an active writer' },
    { code: -32600, message: 'SYNTHETIC_PRIVATE_DIAGNOSTIC: cannot acquire writer lock' },
  ]) {
    const f = fakeCodex(t, { rpcError: { method: 'thread/resume', ...error } });
    const result = await f.control.run({ ...newInput, mode: 'resume', threadId });
    assert.equal(result.errorCode, 'codex-request-rejected');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DIAGNOSTIC|already has an active writer/);
    assert.equal(f.requests.some(request => request.method === 'thread/start' || request.method === 'turn/start'), false);
  }
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
  assert.deepEqual(timeout.control.recoveryState(), { recoverable: true, errorCode: 'codex-rpc-timeout' });
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

test('fatal metadata cannot be bypassed by a new worker and stops an already running worker', async t => {
  const behavior = { badJson: 'thread/list' };
  const f = fakeCodex(t, behavior);
  assert.equal((await f.control.listSessions()).status, 'unavailable');
  const calls = f.calls.length;
  behavior.badJson = null;
  assert.equal((await f.control.run(newInput)).errorCode, 'codex-protocol-error');
  assert.equal(f.calls.length, calls, 'fatal metadata must not create an execution worker');
  assert.equal(f.requests.some(request => request.method === 'turn/start'), false);

  const runningBehavior = { turnHang: true };
  const g = fakeCodex(t, runningBehavior);
  const running = g.control.run(newInput);
  await new Promise(resolve => setTimeout(resolve, 10));
  runningBehavior.badJson = 'account/read';
  assert.equal((await g.control.accountStatus()).status, 'unavailable');
  const result = await running;
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'codex-protocol-error');
  assert.equal(g.requests.filter(request => request.method === 'turn/start').length, 1);
  assert.equal((await g.control.run(newInput)).errorCode, 'codex-protocol-error');
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

test('a failed disposable worker never poisons metadata or replays its turn', async t => {
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
  assert.deepEqual(f.control.recoveryState(), { recoverable: false, errorCode: null });
  assert.equal((await f.control.accountStatus()).status, 'authenticated');
  assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 1, 'A failed turn is never replayed.');
});
