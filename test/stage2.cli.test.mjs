import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createCredentialStore } from '../src/credentials.mjs';

async function unusedLoopbackPort() {
  const listener = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    return listener.address().port;
  } finally {
    if (listener.listening) await new Promise(resolve => listener.close(resolve));
  }
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null || !child.pid;
}

function waitForExit(child, milliseconds) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = value => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), milliseconds);
    child.once('exit', onExit);
    if (exited(child)) finish(true);
  });
}

async function stop(child) {
  if (exited(child)) return;
  const graceful = waitForExit(child, 2000);
  child.kill('SIGTERM');
  if (await graceful) return;
  const forced = waitForExit(child, 1000);
  child.kill('SIGKILL');
  assert.equal(await forced, true, 'test child process stopped within the cleanup deadline');
}

test('real loopback CLI hub and two synthetic agent processes reconnect and enforce revocation', { timeout: 25000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leverage50xagents-cli-'));
  fs.chmodSync(root, 0o700);
  const children = [];
  const failures = new Set();
  t.after(async () => {
    const results = await Promise.allSettled(children.map(stop));
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(results.every(result => result.status === 'fulfilled'), 'all test processes stopped');
  });
  const port = await unusedLoopbackPort();
  const url = 'http://127.0.0.1:' + port;
  const operatorToken = randomBytes(32).toString('hex');
  const credentialFile = path.join(root, 'agents.json');
  const store = createCredentialStore({ file: credentialFile });
  const first = store.enroll('same-laptop-name');
  const second = store.enroll('same-laptop-name');
  const sessionIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const baseEnvironment = {
    PATH: process.env.PATH || '', HOME: root, TMPDIR: root, LANG: 'C.UTF-8',
    LEVERAGE_ENABLE_LIVE_CODEX: '0'
  };
  function start(script, env) {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(), env: { ...baseEnvironment, ...env }, stdio: 'ignore'
    });
    child.once('error', () => failures.add(child));
    children.push(child);
    return child;
  }
  async function call(endpoint, { method = 'GET', body, token = operatorToken } = {}) {
    const response = await fetch(url + endpoint, {
      method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(1000), redirect: 'error'
    });
    return { status: response.status, body: await response.json() };
  }
  async function waitUntil(predicate, description) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      assert.equal(failures.size, 0, 'Node test processes started without spawn errors');
      if (await predicate()) return;
      await delay(50);
    }
    assert.fail(description);
  }
  start('src/hub.mjs', {
    LEVERAGE_OPERATOR_TOKEN: operatorToken, LEVERAGE_CREDENTIAL_STORE: credentialFile,
    LEVERAGE_HOST: '127.0.0.1', LEVERAGE_PORT: String(port)
  });
  await waitUntil(async () => {
    try { return (await call('/api/state')).status === 200; } catch { return false; }
  }, 'real CLI hub became available on loopback');

  const environments = [first, second].map((credential, index) => {
    const home = path.join(root, 'agent-' + index, 'codex');
    const workspace = path.join(root, 'agent-' + index, 'workspace');
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { mode: 0o700 });
    fs.writeFileSync(path.join(home, 'sessions', 'rollout-' + sessionIds[index] + '.jsonl'),
      'SYNTHETIC_TRANSCRIPT_MUST_NOT_LEAVE_FIXTURE\n', { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'config.toml'),
      '[mcp_servers.synthetic_' + index + ']\npassword="SYNTHETIC_CONFIG_MUST_NOT_LEAVE_FIXTURE"\n', { mode: 0o600 });
    return {
      LEVERAGE_AGENT_ID: credential.deviceId, LEVERAGE_AGENT_TOKEN: credential.token,
      LEVERAGE_DEVICE: credential.name, LEVERAGE_URL: url, LEVERAGE_CODEX_HOME: home,
      LEVERAGE_WORKSPACE: workspace, LEVERAGE_SESSION_SOURCE: 'files'
    };
  });
  const firstAgent = start('src/agent.mjs', environments[0]);
  start('src/agent.mjs', environments[1]);
  let state;
  await waitUntil(async () => {
    const result = await call('/api/state');
    state = result.body;
    return result.status === 200 && state.devices.length === 2 && state.devices.every(device => device.online);
  }, 'both synthetic CLI agents reported separate online devices');
  assert.notEqual(first.deviceId, second.deviceId);
  assert.deepEqual(state.devices.map(device => device.id).sort(), [first.deviceId, second.deviceId].sort());
  for (const [index, credential] of [first, second].entries()) {
    const device = state.devices.find(value => value.id === credential.deviceId);
    assert.equal(device.name, 'same-laptop-name');
    assert.deepEqual(device.sessions.map(session => session.id), [sessionIds[index]]);
    assert.equal(device.sessions[0].activity, 'discovered');
    assert.equal(device.sessions[0].source, 'files');
    assert.equal(device.sessions[0].lastActivity, undefined);
    assert.equal(device.executionMode, 'inventory-only');
    assert.equal(device.sandbox, 'no-execution');
    assert.deepEqual(device.mcp.servers, ['synthetic_' + index]);
  }
  assert.equal(JSON.stringify(state).includes('SYNTHETIC_TRANSCRIPT_MUST_NOT_LEAVE_FIXTURE'), false);
  assert.equal(JSON.stringify(state).includes('SYNTHETIC_CONFIG_MUST_NOT_LEAVE_FIXTURE'), false);
  assert.equal(Object.hasOwn(state, 'jobs'), false);
  assert.deepEqual(state.readonlyJobs, []);
  const page = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: 'error' });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Read-only/i);
  assert.equal((await call('/api/state', { token: first.token })).status, 403);

  const heartbeatBeforeRestart = state.devices.find(device => device.id === first.deviceId).lastSeen;
  await stop(firstAgent);
  assert.equal(firstAgent.exitCode, 0, 'first CLI agent handled SIGTERM gracefully');
  start('src/agent.mjs', environments[0]);
  await waitUntil(async () => {
    state = (await call('/api/state')).body;
    return state.devices.length === 2 && state.devices.some(device => device.id === first.deviceId &&
      device.online && device.lastSeen > heartbeatBeforeRestart);
  }, 'restarted CLI agent retained its enrolled device identity');
  assert.equal((await call('/api/admin/agents/revoke', { method: 'POST', body: { deviceId: first.deviceId } })).status, 200);
  const revokedHeartbeat = await call('/api/agent/heartbeat', {
    method: 'POST', token: first.token, body: { deviceId: first.deviceId }
  });
  assert.ok([401, 403].includes(revokedHeartbeat.status));
  state = (await call('/api/state')).body;
  assert.equal(state.devices.find(device => device.id === first.deviceId).online, false);
  assert.ok(state.agents.find(agent => agent.id === first.deviceId).revokedAt);
  assert.equal(state.devices.find(device => device.id === second.deviceId).online, true);
  assert.equal((await call('/api/agent/task?deviceId=' + second.deviceId, { token: second.token })).status, 404);
  assert.equal((await call('/api/agent/local/task?deviceId=' + second.deviceId, { token: second.token })).status, 403);
});
