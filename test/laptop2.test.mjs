import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runInNewContext } from 'node:vm';
import { createLauncher, checkLaptop2 } from '../src/launcher.mjs';

const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const token = 'synthetic-secondary-agent-'.padEnd(64, 'x');

test('wrapper reports unsupported Node before importing launcher-only runtime APIs', async () => {
  const source = fs.readFileSync(new URL('../laptop2', import.meta.url), 'utf8').replace(/^#![^\n]*\n/, '');
  const process = { versions: { node: '18.0.0' }, exitCode: 0 };
  const messages = [];
  await runInNewContext('(async () => {\n' + source + '\n})()', {
    process, console: { error: value => messages.push(value) }
  });
  assert.equal(process.exitCode, 1);
  assert.deepEqual(messages, ['Node.js 22 or newer is required in WSL/Linux.']);
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leverage-secondary-'));
  for (const dir of ['src', 'workspace', 'bin']) fs.mkdirSync(path.join(root, dir));
  fs.mkdirSync(path.join(root, '.local-run'), { mode: 0o700 });
  let lastSeen = 0, revoked = false;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    if (revoked) { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/heartbeat') lastSeen = Date.now();
    else assert.equal(req.url, '/api/agent/status');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ deviceId: id, online: Date.now() - lastSeen < 1000, lastSeen,
      codexAuth: 'authenticated', privateDiagnostic: 'SYNTHETIC_MUST_NOT_LOG' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const file = path.join(root, '.local-run/agent.env');
  const contents = 'LEVERAGE_AGENT_ID=' + id + '\nLEVERAGE_AGENT_TOKEN=' + token +
    '\nLEVERAGE_URL=' + origin + '\nLEVERAGE_WORKSPACE=' + path.join(root, 'workspace') + '\n';
  fs.writeFileSync(file, contents, { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'src/agent.mjs'), `
if (process.env.LEVERAGE_LOCAL_READONLY !== '0' || process.env.LEVERAGE_ENABLE_LIVE_CODEX !== '0' ||
    process.env.LEVERAGE_CODEX_METADATA !== '1' || process.env.LEVERAGE_OPERATOR_TOKEN) process.exit(2);
const tick = () => fetch(process.env.LEVERAGE_URL + '/heartbeat', { headers: { Authorization: 'Bearer ' + process.env.LEVERAGE_AGENT_TOKEN } }).catch(() => {});
await tick(); setInterval(tick, 100);
`);
  fs.writeFileSync(path.join(root, 'src/hub.mjs'), 'throw new Error("A second Hub must never start");\n');
  const output = [];
  const launcher = createLauncher({ root, agentOnly: true, env: process.env, log: row => output.push(row), startTimeoutMs: 2000, stopTimeoutMs: 500 });
  t.after(async () => {
    await launcher.stop(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, file, contents, launcher, output, setHeartbeat: value => { lastSeen = value; }, revoke: () => { revoked = true; } };
}

test('secondary launcher starts only its agent without Hub/operator credentials and prevents duplicate starts', async t => {
  const f = await fixture(t);
  const first = await f.launcher.start();
  const second = await f.launcher.start();
  assert.equal(first.agentPid, second.agentPid);
  assert.equal(first.hubPid, undefined);
  const status = await f.launcher.status();
  assert.equal(status.hub.ownedRunning, false);
  assert.equal(status.agent.ownedRunning, true);
  assert.equal(status.agent.online, true);
  assert.equal(status.agent.codexAuth, 'authenticated');
  assert.equal(status.deviceId, id);
  assert.equal(fs.existsSync(path.join(f.root, '.local-run/hub.env')), false);
  assert.equal(fs.existsSync(path.join(f.root, '.local-run/agents.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, '.local-run/launcher')), false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.contents);
  const state = JSON.parse(fs.readFileSync(path.join(f.root, '.local-run/agent-launcher/state.json')));
  assert.equal(state.hub, null);
  for (const secret of [token, 'SYNTHETIC_MUST_NOT_LOG']) assert.equal(f.output.join('\n').includes(secret), false);
  await f.launcher.stop();
  assert.equal((await f.launcher.status()).agent.ownedRunning, false);
});

test('secondary launcher refuses an externally reporting agent without adopting it', async t => {
  const f = await fixture(t);
  f.setHeartbeat(Date.now());
  await assert.rejects(f.launcher.start(), /outside this launcher/);
  assert.equal((await f.launcher.status()).agent.ownedRunning, false);
});

test('secondary startup rejects revoked tokens, missing/unsafe configuration and nonloopback destinations', async t => {
  const f = await fixture(t);
  f.revoke();
  await assert.rejects(f.launcher.start(), /rejected/);
  fs.writeFileSync(f.file, f.contents.replace(/LEVERAGE_URL=.*/, 'LEVERAGE_URL=http://192.0.2.1:8765'));
  await assert.rejects(f.launcher.start(), /loopback/);
  fs.chmodSync(f.file, 0o644);
  await assert.rejects(f.launcher.start(), /private file/);
  fs.unlinkSync(f.file);
  await assert.rejects(f.launcher.start(), /credential files are required/);
  assert.equal(fs.existsSync(f.file), false);
});

test('secondary state cannot be used to stop a Hub or signal another process generation', async t => {
  const f = await fixture(t);
  await f.launcher.start();
  const file = path.join(f.root, '.local-run/agent-launcher/state.json');
  const state = JSON.parse(fs.readFileSync(file));
  const original = fs.readFileSync(file);
  try {
    state.hub = { ...state.agent, entry: path.join(f.root, 'src/hub.mjs') };
    fs.writeFileSync(file, JSON.stringify(state));
    await assert.rejects(f.launcher.stop(), /unsafe or corrupt/);
    state.hub = null;
    state.agent = { ...state.agent, pid: process.pid, startTime: '0' };
    fs.writeFileSync(file, JSON.stringify(state));
    await f.launcher.stop();
    assert.equal(process.kill(process.pid, 0), true);
  } finally {
    fs.writeFileSync(file, original);
  }
});

test('prerequisite checks reuse local Codex status and return no raw account output or credentials', async t => {
  const f = await fixture(t);
  const bin = path.join(f.root, 'bin');
  const command = (name, source) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + source, { mode: 0o700 });
  command('git', "printf 'git version 2.43.0\\n'\n");
  command('codex', "if test \"$1\" = --version; then printf 'codex-cli 0.163.0\\n'; else printf 'Logged in using ChatGPT\\nSYNTHETIC_ACCOUNT_PRIVATE\\n'; fi\n");
  const options = { root: f.root, env: { PATH: bin } };
  const authenticated = await checkLaptop2(options);
  assert.equal(authenticated.codexAuth, 'authenticated');
  assert.equal(authenticated.codexCompatible, true);
  assert.equal(authenticated.gitAvailable, true);
  assert.equal(JSON.stringify(authenticated).includes('SYNTHETIC_ACCOUNT_PRIVATE'), false);
  assert.equal(JSON.stringify(authenticated).includes(token), false);
  command('codex', "if test \"$1\" = --version; then printf 'codex-cli 0.163.0\\n'; else printf 'Not logged in\\n'; exit 1; fi\n");
  const loggedOut = await checkLaptop2(options);
  assert.equal(loggedOut.codexAuth, 'not-authenticated');
  assert.match(loggedOut.nextStep, /codex login manually/);
  command('codex', "printf 'codex-cli 0.100.0\\n'\n");
  assert.equal((await checkLaptop2(options)).codexCompatible, false);
});
