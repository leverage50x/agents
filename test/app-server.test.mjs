import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from '../test-support/fixtures.mjs';
import { discoverCodexSessions, listAppServerSessions } from '../src/codex-app-server.mjs';

const id = index => index.toString(16).padStart(8, '0') + '-0000-0000-0000-000000000000';
const row = (index, other = {}) => ({ id: id(index), source: 'cli', updatedAt: 1700000000 + index,
  cwd: '/synthetic/private-parent/example-project', preview: 'SYNTHETIC_PRIVATE_PREVIEW',
  name: null, gitInfo: { originUrl: 'SYNTHETIC_PRIVATE_ORIGIN' },
  turns: [{ content: 'SYNTHETIC_PRIVATE_TRANSCRIPT' }], status: { type: 'active' }, ...other });

/** A real Node child speaks synthetic JSON-RPC; it never launches real Codex. */
function syntheticServer(t, config = {}) {
  const f = fixture(t);
  const calls = [];
  const children = [];
  const requests = path.join(f.root, 'requests.jsonl');
  const script = `
    const fs = require('node:fs');
    const readline = require('node:readline');
    const config = JSON.parse(process.argv[1]);
    const trace = process.argv[2];
    if (config.versionOnly) {
      process.stdout.write(config.version);
    } else {
      if (config.ignoreTerminate) process.on('SIGTERM', () => {});
      const input = readline.createInterface({ input: process.stdin });
      let page = 0;
      input.on('line', line => {
        const message = JSON.parse(line);
        fs.appendFileSync(trace, JSON.stringify(message) + '\\n');
        if (message.method === 'initialize') {
          process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
        } else if (message.method === 'thread/list') {
          if (config.hang) { if (config.ignoreTerminate) setInterval(() => {}, 1000); return; }
          if (config.badJson) { process.stdout.write('not-json\\n'); return; }
          if (config.unsolicited) {
            process.stdout.write(JSON.stringify({ id: 900, method: 'item/commandExecution/requestApproval',
              params: { command: 'SYNTHETIC_NEVER_EXECUTE' } }) + '\\n'); return;
          }
          if (config.oversize) { process.stdout.write('x'.repeat(config.oversize)); return; }
          if (config.rpcError) {
            process.stdout.write(JSON.stringify({ id: message.id,
              error: { code: -32602, message: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' } }) + '\\n'); return;
          }
          const result = config.pages[page++] || { data: [], nextCursor: null };
          process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
        }
      });
    }
  `;
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const versionOnly = args[0] === '--version';
    const child = spawn(process.execPath, ['-e', script,
      JSON.stringify({ version: 'codex-cli 0.163.0\n', pages: [{ data: [row(1)], nextCursor: null }], ...config, versionOnly }), requests], options);
    children.push(child);
    return child;
  };
  return { ...f, calls, children, spawnImpl, requests: () => fs.existsSync(requests)
    ? fs.readFileSync(requests, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] };
}

test('App Server adapter whitelists metadata and never claims other processes are active', async t => {
  const f = syntheticServer(t);
  const original = process.env.LEVERAGE_AGENT_TOKEN;
  process.env.LEVERAGE_AGENT_TOKEN = 'synthetic-agent-credential-not-for-codex-child';
  t.after(() => {
    if (original === undefined) delete process.env.LEVERAGE_AGENT_TOKEN;
    else process.env.LEVERAGE_AGENT_TOKEN = original;
  });
  const result = await listAppServerSessions({ home: f.home, spawnImpl: f.spawnImpl });
  assert.deepEqual(result, { status: 'available', truncated: false, source: 'app-server', sessions: [{
    id: id(1), modified: new Date(1700000001000).toISOString(), lastActivity: new Date(1700000001000).toISOString(),
    project: 'example-project', activity: 'discovered', source: 'app-server',
  }] });
  assert.deepEqual(f.calls[0].args, ['--version']);
  assert.deepEqual(f.calls[1].args, ['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false']);
  for (const call of f.calls) {
    assert.equal(call.command, 'codex');
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.CODEX_HOME, f.home);
    assert.equal('LEVERAGE_AGENT_TOKEN' in call.options.env, false);
    assert.equal('OPENAI_API_KEY' in call.options.env, false);
  }
  const requests = f.requests();
  assert.deepEqual(requests.map(request => request.method), ['initialize', 'initialized', 'thread/list']);
  assert.equal(requests[2].params.useStateDbOnly, true);
  assert.equal(requests[2].params.sortKey, 'updated_at');
  assert.equal(requests[2].params.limit, 40);
  assert.equal(requests[2].params.archived, false);
  assert.deepEqual(requests[2].params.sourceKinds, ['cli', 'vscode']);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /PRIVATE|private-parent|turns|preview|gitInfo|active|cwd/);
  assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
});

test('App Server pagination follows cursors, deduplicates and enforces the 40-session bound', async t => {
  const f = syntheticServer(t, { pages: [
    { data: Array.from({ length: 20 }, (_, index) => row(index)), nextCursor: 'second-page' },
    { data: [row(19), ...Array.from({ length: 21 }, (_, index) => row(index + 20))], nextCursor: 'third-page' },
  ] });
  const result = await listAppServerSessions({ home: f.home, spawnImpl: f.spawnImpl });
  assert.equal(result.sessions.length, 40);
  assert.equal(result.truncated, true);
  const lists = f.requests().filter(request => request.method === 'thread/list');
  assert.equal(lists.length, 2);
  assert.equal(lists[1].params.cursor, 'second-page');
  assert.equal(lists[1].params.limit, 20);
  assert.ok(lists.every(request => request.params.useStateDbOnly === true));
});

test('repeated pagination cursors stop without an unbounded scan', async t => {
  const f = syntheticServer(t, { pages: [
    { data: [row(1)], nextCursor: 'repeat' }, { data: [row(2)], nextCursor: 'repeat' },
  ] });
  const result = await listAppServerSessions({ home: f.home, spawnImpl: f.spawnImpl });
  assert.equal(result.truncated, true);
  assert.equal(f.requests().filter(request => request.method === 'thread/list').length, 2);
});

test('older duplicate pages cannot replace newer UUID metadata or its sanitized title', async t => {
  const f = syntheticServer(t, { pages: [
    { data: [row(1, { name: 'Newer metadata', updatedAt: 1700000200 })], nextCursor: 'second' },
    { data: [row(1, { id: id(1).toUpperCase(), name: 'Older metadata', updatedAt: 1700000100 }),
      row(2, { updatedAt: 1700000150 })], nextCursor: null }
  ] });
  const result = await listAppServerSessions({ home: f.home, spawnImpl: f.spawnImpl });
  assert.deepEqual(result.sessions.map(session => session.id), [id(1), id(2)]);
  assert.equal(result.sessions[0].title, 'Newer metadata');
  assert.equal(result.sessions[0].lastActivity, new Date(1700000200000).toISOString());
});

test('Cwd + Active filters auxiliary rows before pagination limits and uses only official name for titles', async t => {
  const { workspace } = fixture(t);
  const pages = [
    { data: [row(1, { source: 'exec', cwd: workspace })], nextCursor: 'second' },
    { data: [row(2, { source: { subAgent: 'review' }, cwd: workspace }),
      row(3, { cwd: workspace, archived: true }), row(4, { cwd: '/synthetic/other' }),
      row(10, { cwd: workspace, name: 'Named session', status: { type: 'notLoaded' } }),
      row(11, { cwd: workspace, source: 'vscode', title: 'Untrusted alias' })], nextCursor: null }
  ];
  const g = syntheticServer(t, { pages });
  const result = await listAppServerSessions({ home: g.home, workspace, limit: 2, spawnImpl: g.spawnImpl });
  assert.deepEqual(result.sessions.map(s => s.id), [id(11), id(10)]);
  assert.equal(result.sessions.find(s => s.id === id(10)).title, 'Named session');
  assert.equal(result.sessions.find(s => s.id === id(11)).title, undefined);
  assert.equal(result.status, 'available');
  assert.ok(g.requests().filter(r => r.method === 'thread/list').every(r =>
    r.params.cwd === workspace && r.params.archived === false &&
    JSON.stringify(r.params.sourceKinds) === JSON.stringify(['cli', 'vscode']) && r.params.useStateDbOnly));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|Untrusted alias/);
});

test('workspace-scoped inventory stays unavailable when metadata fails instead of guessing from filenames', async t => {
  const f = syntheticServer(t, { version: 'codex-cli 0.100.0\n' });
  fs.mkdirSync(path.join(f.home, 'sessions'));
  fs.writeFileSync(path.join(f.home, 'sessions', 'rollout-' + id(7) + '.jsonl'), 'SYNTHETIC_PRIVATE_TRANSCRIPT');
  const result = await discoverCodexSessions({ home: f.home, workspace: f.workspace, source: 'app-server', spawnImpl: f.spawnImpl });
  assert.deepEqual(result, { status: 'unavailable', sessions: [], truncated: false,
    source: 'app-server', reason: 'app-server-incompatible' });
  assert.equal(f.calls.length, 1);
});

test('invalid metadata is omitted and full or unsafe project paths are never returned', async t => {
  const f = syntheticServer(t, { pages: [{ data: [
    row(1, { id: 'invalid' }), row(2, { updatedAt: -1 }), row(3, { cwd: '/synthetic/project@example.com' }),
    row(4, { cwd: '/synthetic/project\nprivate' }), row(5, { cwd: '/synthetic/clean-project' }),
  ], nextCursor: null }] });
  const result = await listAppServerSessions({ home: f.home, spawnImpl: f.spawnImpl });
  assert.equal(result.status, 'partial');
  assert.equal(result.sessions.length, 3);
  assert.equal(result.sessions.find(session => session.id === id(3)).project, undefined);
  assert.equal(result.sessions.find(session => session.id === id(4)).project, undefined);
  assert.equal(result.sessions.find(session => session.id === id(5)).project, 'clean-project');
});

test('unsupported Codex versions fall back before starting an App Server or reading transcripts', async t => {
  const f = syntheticServer(t, { version: 'codex-cli 0.100.0\n' });
  fs.mkdirSync(path.join(f.home, 'sessions'));
  fs.writeFileSync(path.join(f.home, 'sessions', 'rollout-' + id(7) + '.jsonl'), 'SYNTHETIC_PRIVATE_TRANSCRIPT');
  const result = await discoverCodexSessions({ home: f.home, source: 'app-server', spawnImpl: f.spawnImpl });
  assert.equal(result.source, 'files');
  assert.equal(result.reason, 'app-server-incompatible');
  assert.equal(result.sessions[0].id, id(7));
  assert.equal(result.sessions[0].activity, 'discovered');
  assert.equal(result.sessions[0].lastActivity, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.requests().length, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TRANSCRIPT/);
});

test('filename inventory is the default and never launches Codex', async t => {
  const f = fixture(t);
  const result = await discoverCodexSessions({ home: f.home, spawnImpl: () => assert.fail('Must not spawn.') });
  assert.deepEqual(result, { status: 'missing', truncated: false, sessions: [], source: 'files' });
  await assert.rejects(discoverCodexSessions({ home: f.home, source: 'auto' }), /source/);
  await assert.rejects(listAppServerSessions({ home: f.home, command: 'powershell.exe' }), /executable/);
  await assert.rejects(listAppServerSessions({ home: f.home, command: '/mnt/c/tools/codex' }), /executable/);
});

for (const [name, config] of [
  ['RPC error', { rpcError: true }], ['malformed JSON', { badJson: true }],
  ['unsolicited execution approval', { unsolicited: true }], ['bounded output', { oversize: 10000 }],
]) {
  test(name + ' produces a safe fallback and terminates the child', async t => {
    const f = syntheticServer(t, config);
    const result = await discoverCodexSessions({ home: f.home, source: 'app-server',
      spawnImpl: f.spawnImpl, maxOutputBytes: 2048 });
    assert.equal(result.source, 'files');
    assert.equal(result.reason, 'app-server-unavailable');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|NEVER_EXECUTE|requestApproval/);
    assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
    assert.ok(f.requests().every(request => ['initialize', 'initialized', 'thread/list'].includes(request.method)));
  });
}

test('timeout escalates termination for an unresponsive synthetic App Server and reaps it', async t => {
  const f = syntheticServer(t, { hang: true, ignoreTerminate: true });
  const result = await discoverCodexSessions({ home: f.home, source: 'app-server', spawnImpl: f.spawnImpl, timeoutMs: 1000 });
  assert.equal(result.reason, 'app-server-unavailable');
  assert.equal(f.children[1].signalCode, 'SIGKILL');
});

test('missing Codex executable falls back without exposing a raw error or local path', async t => {
  const f = fixture(t);
  const result = await discoverCodexSessions({ home: f.home, source: 'app-server',
    spawnImpl: () => { throw new Error('SYNTHETIC_PRIVATE_ERROR ' + f.home); } });
  assert.equal(result.reason, 'app-server-unavailable');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ERROR|leverage50xagents-/);
});
