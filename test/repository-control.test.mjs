import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createCodexControl } from '../src/codex-control.mjs';
import { fixture } from '../test-support/fixtures.mjs';

const THREAD = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const INPUT = { mode: 'new', workspaceId: 'project', confirmed: true,
  prompt: 'Analyze the authorized source files without modifying anything.' };

// Synthetic App Server transport, real filesystem reader. It does not run a
// model or a shell; native-Codex integration is reported separately.
function broker(t, { onTurn, controllerOptions = {}, configPatch = {}, skillsReply } = {}) {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.workspace, 'src'));
  fs.writeFileSync(path.join(f.workspace, 'README.md'), '# Synthetic source fixture\n');
  fs.writeFileSync(path.join(f.workspace, 'src', 'alpha.mjs'),
    'export const alpha = 7;\nexport function dormant() { return 9; }\n');
  fs.writeFileSync(path.join(f.workspace, 'src', 'beta.mjs'),
    "import { alpha } from './alpha.mjs';\nexport const beta = alpha + 1;\n");
  const original = ['README.md', 'src/alpha.mjs', 'src/beta.mjs']
    .map(file => [file, fs.readFileSync(path.join(f.workspace, file))]);
  const requests = [], children = [], events = [], scripts = [], pendingTools = new Map();
  const timers = new Set();
  let turnNumber = 0, rpcNumber = 0;
  const spawnImpl = (_command, args, options) => {
    const child = new EventEmitter();
    child.pid = 999999; child.exitCode = null; child.signalCode = null;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      child.signalCode = signal;
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    const reply = message => {
      if (child.exitCode === null && child.signalCode === null) child.stdout.write(JSON.stringify(message) + '\n');
    };
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      for (const line of chunk.toString().trim().split('\n').filter(Boolean)) {
        const message = JSON.parse(line); requests.push({ ...message, child });
        if (!message.method) {
          const waiter = pendingTools.get(message.id);
          if (waiter) { pendingTools.delete(message.id); queueMicrotask(() => waiter(message)); }
          continue;
        }
        if (message.method === 'initialized') continue;
        queueMicrotask(() => {
          const response = result => reply({ id: message.id, result });
          switch (message.method) {
            case 'initialize': response({}); break;
            case 'account/read': response({ account: { type: 'chatgpt' } }); break;
            case 'config/read': response({ config: { mcp_servers: {}, ...configPatch } }); break;
            case 'skills/list': response(typeof skillsReply === 'function' ? skillsReply(f.workspace)
              : skillsReply ?? { data: [{ cwd: f.workspace, errors: [], skills: [] }] }); break;
            case 'thread/list': response({ data: [{ id: THREAD, cwd: f.workspace, source: 'cli',
              updatedAt: 1700000000, status: { type: 'notLoaded' } }], nextCursor: null }); break;
            case 'thread/start':
            case 'thread/resume': response({ cwd: f.workspace, sandbox: { type: 'readOnly', networkAccess: false },
              approvalPolicy: 'on-request', approvalsReviewer: 'user',
              thread: { id: THREAD, cwd: f.workspace, status: { type: 'idle' } } }); break;
            case 'turn/start': {
              const number = ++turnNumber, turnId = 'synthetic-turn-' + number;
              const ack = () => response({ turn: { id: turnId, status: 'inProgress', items: [] } });
              const complete = (text, status = 'completed') => reply({ method: 'turn/completed',
                params: { threadId: THREAD, turn: { id: turnId, status,
                  items: [{ type: 'agentMessage', id: 'message-' + number, text }] } } });
              const tool = (name, arguments_, extra = {}) => {
                const id = 'repository-rpc-' + (++rpcNumber);
                const result = new Promise(resolve => pendingTools.set(id, resolve));
                reply({ id, method: 'item/tool/call', params: { threadId: THREAD, turnId,
                  callId: 'call-' + rpcNumber, namespace: null, tool: name, arguments: arguments_, ...extra } });
                return result;
              };
              const later = (fn, delay) => {
                const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay);
                timers.add(timer);
              };
              const script = Promise.resolve().then(() => onTurn
                ? onTurn({ number, turnId, ack, complete, tool, reply, message, later, child, f })
                : (() => { ack(); complete('Synthetic analysis.'); })());
              scripts.push(script);
              // Assertion failures are reported as test failures below; they
              // cannot escape as unhandled rejections in a protocol callback.
              script.catch(() => { reply({ method: 'turn/completed', params: { threadId: THREAD,
                turn: { id: turnId, status: 'failed', items: [] } } }); });
              break;
            }
            default: assert.fail('Unexpected synthetic method: ' + message.method);
          }
        });
      }
      done();
    } });
    children.push({ child, args, options });
    if (args[0] === '--version') queueMicrotask(() => {
      child.stdout.write('codex-cli 0.163.0\n'); child.exitCode = 0; child.emit('close', 0, null);
    });
    return child;
  };
  const control = createCodexControl({ workspace: f.workspace, home: f.home, spawnImpl,
    rpcTimeoutMs: 200, turnTimeoutMs: 1000, idleTimeoutMs: 500, ...controllerOptions });
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    await control.close();
  });
  return { ...f, control, requests, children, events, scripts,
    run: input => control.run(input || INPUT, event => events.push(event)),
    assertUnchanged() {
      for (const [file, bytes] of original) assert.deepEqual(fs.readFileSync(path.join(f.workspace, file)), bytes);
    },
  };
}
const decode = message => {
  assert.ok(message.result, 'authorized data request must receive a JSON-RPC result');
  assert.equal(message.result.contentItems.length, 1);
  assert.equal(message.result.contentItems[0].type, 'inputText');
  const body = JSON.parse(message.result.contentItems[0].text);
  assert.equal(body.source, 'untrusted-repository-data');
  return body.result;
};
const envelope = request => JSON.stringify({ repositoryRequest: request });

test('New requests real files on demand through two bounded tools and retains the native tool blockade', async t => {
  const outputs = [];
  const f = broker(t, { onTurn: async ({ ack, complete, tool, reply, turnId }) => {
    ack();
    reply({ method: 'item/started', params: { threadId: THREAD, turnId,
      item: { type: 'dynamicToolCall', id: 'call-1', tool: 'repository_list', arguments: { path: 'src' }, status: 'inProgress' } } });
    outputs.push(decode(await tool('repository_list', { path: 'src' })));
    outputs.push(decode(await tool('repository_read', { path: 'src/alpha.mjs', startLine: 1, endLine: 2 })));
    outputs.push(decode(await tool('repository_read', { path: 'src/beta.mjs', startLine: 1, endLine: 2 })));
    reply({ method: 'item/completed', params: { threadId: THREAD, turnId,
      item: { type: 'dynamicToolCall', id: 'call-1', tool: 'repository_list', status: 'completed', success: true } } });
    complete('Possible unused dormant function: src/alpha.mjs:2. Import relationship: src/beta.mjs:1.');
  } });
  const result = await f.run();
  assert.equal(result.status, 'completed');
  await Promise.all(f.scripts);
  assert.deepEqual(outputs[0].entries.map(entry => entry.name).sort(), ['alpha.mjs', 'beta.mjs']);
  assert.match(outputs[1].content, /2: export function dormant/);
  assert.match(outputs[2].content, /1: import \{ alpha \}/);
  assert.equal(result.outputTruncated, false);
  const start = f.requests.find(request => request.method === 'thread/start');
  assert.deepEqual(start.params.dynamicTools.map(tool => tool.name).sort(), ['repository_list', 'repository_read']);
  assert.ok(start.params.dynamicTools.every(tool => tool.inputSchema.additionalProperties === false));
  assert.equal(start.params.config.project_doc_max_bytes, 0);
  assert.equal(start.params.sandbox, 'read-only');
  assert.equal(start.params.config.web_search, 'disabled');
  for (const key of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'code_mode']) {
    assert.equal(start.params.config.features[key], false, key);
  }
  const firstPrompt = f.requests.find(request => request.method === 'turn/start').params.input[0].text;
  assert.doesNotMatch(firstPrompt, /Synthetic source fixture|export const alpha|Top-level files/,
    'authorized content must not be preloaded as a repository snapshot');
  assert.ok(f.requests.some(request => request.method === 'initialize' && request.params.capabilities.experimentalApi === true));
  assert.ok(f.events.some(event => event.type === 'progress' && /alpha\.mjs/.test(event.message)));
  f.assertUnchanged();
});

test('private, outside, encoded, symlinked and credential-bearing reads return safe denials', async t => {
  const rejected = [];
  const forbidden = ['.env', '.local-run/private.md', '../outside.md', '/etc/passwd',
    'src/%2e%2e/private.md', 'src/escape.mjs', 'src/settings.json'];
  const f = broker(t, { onTurn: async ({ ack, complete, tool }) => {
    ack();
    for (const file of forbidden) {
      const message = await tool('repository_read', { path: file });
      rejected.push({ success: message.result?.success, body: decode(message) });
    }
    complete('Protected files were withheld.');
  } });
  fs.writeFileSync(path.join(f.workspace, '.env'), 'PRIVATE_ENV_SENTINEL');
  fs.mkdirSync(path.join(f.workspace, '.local-run'));
  fs.writeFileSync(path.join(f.workspace, '.local-run', 'private.md'), 'PRIVATE_LOG_SENTINEL');
  fs.writeFileSync(path.join(f.root, 'outside.md'), 'PRIVATE_OUTSIDE_SENTINEL');
  fs.symlinkSync(path.join(f.root, 'outside.md'), path.join(f.workspace, 'src', 'escape.mjs'));
  fs.writeFileSync(path.join(f.workspace, 'src', 'settings.json'), '{"password":"SYNTHETIC_SECRET_SENTINEL"}');
  const result = await f.run();
  assert.equal(result.status, 'completed');
  await Promise.all(f.scripts);
  assert.equal(rejected.length, forbidden.length);
  for (const value of rejected) {
    assert.equal(value.success, false);
    assert.equal(value.body.ok, false);
    assert.match(value.body.error.code, /^repository-/);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_.*SENTINEL|SYNTHETIC_SECRET_SENTINEL/);
  }
  f.assertUnchanged();
});

test('an authorized tool request racing turn/start waits for the acknowledged turn binding', async t => {
  let sawEarlyResponse = false;
  const f = broker(t, { onTurn: async ({ ack, complete, tool, later }) => {
    const pending = tool('repository_read', { path: 'src/alpha.mjs', startLine: 1, endLine: 1 });
    let acknowledged = false;
    pending.then(() => { if (!acknowledged) sawEarlyResponse = true; });
    later(() => { acknowledged = true; ack(); }, 15);
    const result = decode(await pending);
    assert.match(result.content, /alpha = 7/);
    complete('Acknowledged selected-turn read.');
  } });
  assert.equal((await f.run()).status, 'completed');
  await Promise.all(f.scripts);
  assert.equal(sawEarlyResponse, false);
});

test('foreign identities, stale turns, unknown tools and duplicate calls never receive source bytes', async t => {
  const cases = [
    { threadId: FOREIGN }, { turnId: 'synthetic-unacknowledged-turn' },
    { tool: 'shell' }, { tool: 'repository_write' }, { namespace: 'outside' },
    { callId: '' }, { callId: 'x'.repeat(129) }, { arguments: null },
    { arguments: { path: 'src/alpha.mjs', command: 'SYNTHETIC_NEVER_EXECUTE' } },
  ];
  for (const changed of cases) {
    const f = broker(t, { onTurn: ({ ack, tool }) => {
      ack(); void tool('repository_read', { path: 'src/alpha.mjs' }, changed);
    } });
    const result = await f.run();
    assert.equal(result.status, 'failed', JSON.stringify(changed));
    assert.equal(result.errorCode, 'approval-denied', JSON.stringify(changed));
    const responses = f.requests.filter(message => !message.method && message.id?.startsWith('repository-rpc-'));
    assert.equal(responses.filter(message => message.result?.success).length, 0);
    assert.doesNotMatch(JSON.stringify(responses), /export const alpha/);
    f.assertUnchanged();
  }
  const f = broker(t, { onTurn: async ({ ack, tool }) => {
    ack();
    assert.equal(decode(await tool('repository_read', { path: 'src/alpha.mjs' }, { callId: 'same' })).ok, true);
    void tool('repository_read', { path: 'src/beta.mjs' }, { callId: 'same' });
  } });
  assert.equal((await f.run()).errorCode, 'approval-denied');
  assert.equal(f.requests.filter(message => !message.method && message.result?.success).length, 1,
    'only the first unique selected-turn call may receive content');
});

test('bounded early-request queue fails closed before any turn acknowledgement', async t => {
  const f = broker(t, { onTurn: ({ tool }) => {
    for (let index = 0; index < 9; index++) void tool('repository_read', { path: 'src/alpha.mjs' });
  } });
  const result = await f.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'approval-denied');
  assert.equal(f.requests.some(message => message.result?.success), false);
});

test('native command execution and write approvals remain forbidden with repository tools present', async t => {
  for (const mode of ['notification', 'approval']) {
    const f = broker(t, { onTurn: ({ ack, reply, turnId }) => {
      ack();
      if (mode === 'notification') reply({ method: 'item/started', params: { threadId: THREAD, turnId,
        item: { id: 'blocked', type: 'commandExecution', command: 'SYNTHETIC_NEVER_EXECUTE' } } });
      else reply({ id: 'blocked-approval', method: 'item/fileChange/requestApproval',
        params: { threadId: THREAD, turnId } });
    } });
    const result = await f.run();
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, mode === 'notification' ? 'tool-use-blocked' : 'approval-denied');
    f.assertUnchanged();
  }
});

test('legacy Resume services strict list/read envelopes in the same approved thread without a snapshot or fork', async t => {
  const f = broker(t, { onTurn: ({ number, ack, complete, message }) => {
    ack();
    if (number === 1) complete(envelope({ operation: 'list', path: 'src' }));
    else if (number === 2) {
      assert.match(message.params.input[0].text, /alpha\.mjs/);
      complete(envelope({ operation: 'read', path: 'src/alpha.mjs', startLine: 2, endLine: 2 }));
    } else {
      assert.match(message.params.input[0].text, /2: export function dormant/);
      complete('Potential unused function: src/alpha.mjs:2.');
    }
  } });
  const result = await f.run({ ...INPUT, mode: 'resume', threadId: THREAD });
  assert.equal(result.status, 'completed');
  assert.equal(result.threadId, THREAD);
  assert.equal(result.output, 'Potential unused function: src/alpha.mjs:2.');
  await Promise.all(f.scripts);
  const turns = f.requests.filter(request => request.method === 'turn/start');
  assert.equal(turns.length, 3);
  assert.ok(turns.every(request => request.params.threadId === THREAD));
  assert.equal(f.requests.some(request => request.method === 'thread/start' || request.method === 'thread/fork'), false);
  assert.equal(f.requests.filter(request => request.method === 'thread/resume').length, 1);
  assert.ok(f.events.some(event => event.type === 'progress' && /alpha\.mjs/.test(event.message)));
  f.assertUnchanged();
});

test('malformed legacy read envelopes cannot add executable operations or extra arguments', async t => {
  const outputs = [
    '{"repositoryRequest":{"operation":"shell","path":"src/alpha.mjs"}}',
    '{"repositoryRequest":{"operation":"read","path":"src/alpha.mjs","command":"SYNTHETIC_NEVER_EXECUTE"}}',
    '{"repositoryRequest":{"operation":"read","path":"src/alpha.mjs"},"extra":true}',
    '{"repositoryRequest":',
  ];
  for (const output of outputs) {
    const f = broker(t, { onTurn: ({ ack, complete }) => { ack(); complete(output); } });
    const result = await f.run({ ...INPUT, mode: 'resume', threadId: THREAD });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'repository-request-invalid');
    assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 1);
    f.assertUnchanged();
  }
});

test('legacy compatibility cannot reset the job read budget or create unbounded turns', async t => {
  const f = broker(t, { onTurn: ({ ack, complete }) => {
    ack(); complete(envelope({ operation: 'read', path: 'src/alpha.mjs', startLine: 1, endLine: 1 }));
  }, controllerOptions: { turnTimeoutMs: 2000, idleTimeoutMs: 1000 } });
  const result = await f.run({ ...INPUT, mode: 'resume', threadId: THREAD });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'repository-budget-exceeded');
  const count = f.requests.filter(request => request.method === 'turn/start').length;
  assert.ok(count > 1 && count <= 65, 'one approved job has a finite total turn/read budget');
  f.assertUnchanged();
});

test('the absolute turn deadline spans repository fallback continuations and releases its owned worker', async t => {
  const f = broker(t, { onTurn: ({ ack, complete, later }) => {
    ack(); later(() => complete(envelope({ operation: 'list', path: '.' })), 35);
  }, controllerOptions: { turnTimeoutMs: 120, idleTimeoutMs: 100 } });
  const result = await f.run({ ...INPUT, mode: 'resume', threadId: THREAD });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'codex-turn-timeout');
  assert.ok(f.requests.filter(request => request.method === 'turn/start').length > 1);
  assert.ok(f.children.filter(record => record.args[0] === 'app-server' &&
    f.requests.some(request => request.child === record.child && request.method === 'thread/resume'))
    .every(record => record.child.signalCode !== null), 'only the execution worker is cleaned after timeout');
  f.assertUnchanged();
});

test('a stale tool request from an earlier fallback turn cannot read through the current turn', async t => {
  const f = broker(t, { onTurn: ({ number, ack, complete, tool }) => {
    ack();
    if (number === 1) complete(envelope({ operation: 'list', path: 'src' }));
    else void tool('repository_read', { path: 'src/alpha.mjs' }, { turnId: 'synthetic-turn-1' });
  } });
  assert.equal((await f.run({ ...INPUT, mode: 'resume', threadId: THREAD })).errorCode, 'approval-denied');
  assert.equal(f.requests.some(request => request.result?.success), false);
});

test('large analysis output is visibly marked as truncated rather than silently presented as complete', async t => {
  const f = broker(t, { onTurn: ({ ack, complete }) => { ack(); complete('Synthetic analysis evidence. '.repeat(500)); } });
  const result = await f.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.outputTruncated, true);
  assert.ok(result.output.length <= 8000);
  f.assertUnchanged();
});

test('enabled or malformed inherited MCP configuration blocks New and Resume before loading any thread', async t => {
  const unsafeMaps = [
    { synthetic: { enabled: true, command: 'SYNTHETIC_PRIVATE_CONFIG_SENTINEL' } },
    { synthetic: { command: 'SYNTHETIC_PRIVATE_CONFIG_SENTINEL' } },
    { synthetic: null }, { synthetic: false }, { synthetic: { enabled: 'false' } },
    [], null, 'SYNTHETIC_PRIVATE_CONFIG_SENTINEL',
  ];
  for (const mcp_servers of unsafeMaps) {
    for (const mode of ['new', 'resume']) {
      const f = broker(t, { configPatch: { mcp_servers } });
      const result = await f.run({ ...INPUT, mode, ...(mode === 'resume' ? { threadId: THREAD } : {}) });
      assert.equal(result.status, 'failed');
      assert.equal(result.errorCode, 'codex-ambient-config-blocked');
      assert.equal(f.requests.some(request => ['thread/start', 'thread/resume', 'turn/start'].includes(request.method)), false,
        'a safety preflight must reject before Codex can load context or start an MCP runtime');
      assert.doesNotMatch(JSON.stringify([result, f.events]), /SYNTHETIC_PRIVATE_CONFIG_SENTINEL/);
      const config = f.requests.find(request => request.method === 'config/read');
      assert.equal(config.params.cwd, f.workspace);
      assert.equal(config.params.includeLayers, false);
      f.assertUnchanged();
    }
  }
});

test('an explicitly disabled MCP entry does not start a service or block authorized repository analysis', async t => {
  const f = broker(t, { configPatch: { mcp_servers: {
    synthetic: { enabled: false, command: 'SYNTHETIC_PRIVATE_CONFIG_SENTINEL' },
  } } });
  const result = await f.run();
  assert.equal(result.status, 'completed');
  assert.equal(f.requests.some(request => request.method?.startsWith('mcp')), false);
  assert.doesNotMatch(JSON.stringify([result, f.events]), /SYNTHETIC_PRIVATE_CONFIG_SENTINEL/);
  f.assertUnchanged();
});

test('ambient instruction files, provider-auth commands and notification programs are never inherited for repository analysis', async t => {
  const unsafe = [
    { model_instructions_file: '/synthetic/private/instructions.md' },
    { experimental_compact_prompt_file: '/synthetic/private/compact.md' },
    { model_provider: 'synthetic', model_providers: {
      synthetic: { auth: { command: 'SYNTHETIC_PRIVATE_CONFIG_SENTINEL' } },
    } },
    { notify: ['SYNTHETIC_PRIVATE_CONFIG_SENTINEL'] },
    { notify: 'SYNTHETIC_PRIVATE_CONFIG_SENTINEL' },
  ];
  for (const configPatch of unsafe) {
    const f = broker(t, { configPatch });
    const result = await f.run();
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'codex-ambient-config-blocked');
    assert.equal(f.requests.some(request => ['thread/start', 'thread/resume', 'turn/start'].includes(request.method)), false);
    assert.doesNotMatch(JSON.stringify([result, f.events]), /SYNTHETIC_PRIVATE_CONFIG_SENTINEL|\/synthetic\/private/);
    f.assertUnchanged();
  }
});

test('ambient skill metadata is scoped and every listed or previously configured skill is disabled only for this thread', async t => {
  const existing = '/synthetic/existing/SKILL.md';
  const discovered = '/synthetic/discovered/SKILL.md';
  const system = '/synthetic/system/SKILL.md';
  for (const mode of ['new', 'resume']) {
    const f = broker(t, {
      configPatch: { skills: { config: [{ path: existing, enabled: true }] } },
      skillsReply: cwd => ({ data: [{ cwd, errors: [], skills: [
        { path: discovered, scope: 'user', enabled: true, name: 'synthetic',
          description: 'SYNTHETIC_PRIVATE_SKILL_SENTINEL' },
        { path: system, scope: 'system', enabled: false, name: 'synthetic-system',
          description: 'SYNTHETIC_PRIVATE_SKILL_SENTINEL' },
      ] }] }),
    });
    const result = await f.run({ ...INPUT, mode, ...(mode === 'resume' ? { threadId: THREAD } : {}) });
    assert.equal(result.status, 'completed');
    const list = f.requests.find(request => request.method === 'skills/list');
    assert.deepEqual(list.params, { cwds: [f.workspace], forceReload: true });
    const start = f.requests.find(request => request.method === 'thread/' + (mode === 'new' ? 'start' : 'resume'));
    assert.deepEqual(new Set(start.params.config.skills.config.map(entry => entry.path)),
      new Set([existing, discovered, system]));
    assert.ok(start.params.config.skills.config.every(entry => entry.enabled === false));
    assert.ok(start.params.config.skills.config.every(entry => Object.keys(entry).every(key => ['path', 'enabled'].includes(key))));
    assert.equal(f.requests.some(request => request.method === 'skills/config/write'), false,
      'thread-scoped catalog suppression must never change the operator configuration');
    assert.doesNotMatch(JSON.stringify([start.params, result, f.events]), /SYNTHETIC_PRIVATE_SKILL_SENTINEL/);
    assert.ok(f.requests.indexOf(list) < f.requests.indexOf(start));
    f.assertUnchanged();
  }
});

test('unavailable, foreign, incomplete and oversized skill inventories fail closed before loading a thread', async t => {
  const invalid = [
    () => ({}),
    () => ({ data: null }),
    () => ({ data: [] }),
    () => ({ data: [null] }),
    () => ({ data: [{ cwd: '/synthetic/foreign', errors: [], skills: [] }] }),
    cwd => ({ data: [{ cwd, errors: [{ message: 'SYNTHETIC_PRIVATE_SKILL_SENTINEL' }], skills: [] }] }),
    cwd => ({ data: [{ cwd, errors: [], skills: null }] }),
    cwd => ({ data: [{ cwd, skills: [] }] }),
    cwd => ({ data: [{ cwd, errors: [], skills: [{ path: 'relative/SKILL.md', enabled: true }] }] }),
    cwd => ({ data: [{ cwd, errors: [], skills: [{ path: '', enabled: true }] }] }),
    cwd => ({ data: [{ cwd, errors: [], skills: [{ path: '/' + 'x'.repeat(4097), enabled: true }] }] }),
    cwd => ({ data: [{ cwd, errors: [], skills: Array.from({ length: 257 }, (_, index) =>
      ({ path: '/synthetic/skill-' + index + '/SKILL.md', enabled: true })) }] }),
  ];
  for (const skillsReply of invalid) {
    for (const mode of ['new', 'resume']) {
      const f = broker(t, { skillsReply });
      const result = await f.run({ ...INPUT, mode, ...(mode === 'resume' ? { threadId: THREAD } : {}) });
      assert.equal(result.status, 'failed');
      assert.equal(result.errorCode, 'codex-ambient-config-blocked');
      assert.equal(f.requests.some(request => ['thread/start', 'thread/resume', 'turn/start'].includes(request.method)), false);
      assert.doesNotMatch(JSON.stringify([result, f.events]), /SYNTHETIC_PRIVATE_SKILL_SENTINEL/);
      f.assertUnchanged();
    }
  }
});

test('home AGENTS paths block New and Resume without reading, deleting or following the operator files', async t => {
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
    for (const kind of ['file', 'directory', 'symlink']) {
      for (const mode of ['new', 'resume']) {
        const f = broker(t);
        const file = path.join(f.home, name);
        const outside = path.join(f.root, 'synthetic-global-instructions.md');
        if (kind === 'file') fs.writeFileSync(file, 'SYNTHETIC_PRIVATE_HOME_INSTRUCTIONS_SENTINEL');
        else if (kind === 'directory') fs.mkdirSync(file);
        else {
          fs.writeFileSync(outside, 'SYNTHETIC_PRIVATE_HOME_INSTRUCTIONS_SENTINEL');
          fs.symlinkSync(outside, file);
        }
        const before = fs.lstatSync(file);
        const result = await f.run({ ...INPUT, mode, ...(mode === 'resume' ? { threadId: THREAD } : {}) });
        assert.equal(result.status, 'failed');
        assert.equal(result.errorCode, 'codex-ambient-config-blocked');
        assert.equal(f.children.length, 0, 'outside instructions must be detected before native startup can read them');
        assert.equal(f.requests.length, 0);
        assert.equal(fs.lstatSync(file).ino, before.ino);
        assert.doesNotMatch(JSON.stringify([result, f.events]), /SYNTHETIC_PRIVATE_HOME_INSTRUCTIONS_SENTINEL/);
        f.assertUnchanged();
      }
    }
  }
});
