import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fixture } from '../test-support/fixtures.mjs';

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

test('CLI hub serves authenticated inventory and rejects retired dispatch endpoints', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const port = await freePort();
  const token = f.token;
  const child = spawn(process.execPath, ['src/hub.mjs'], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: f.root, TMPDIR: f.root,
      ...f.env, LEVERAGE_PORT: String(port), LEVERAGE_HOST: '127.0.0.1' },
    stdio: ['ignore','pipe','pipe']
  });
  let spawnFailed = false;
  child.once('error', () => { spawnFailed = true; });
  async function call(method, endpoint, data, authorization = token) {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method, headers: { Authorization: `Bearer ${authorization}`, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    let ready = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      assert.equal(spawnFailed, false, 'hub test child started without spawn errors');
      try { await call('GET','/api/state'); ready = true; break; } catch { await wait(40); }
    }
    assert.ok(ready, 'hub started');
    assert.equal((await call('GET','/api/state',undefined,'wrong-secret')).status,401);
    const deviceId = f.device.deviceId;
    const joined = await call('POST','/api/agent/heartbeat',{
      deviceId,name:'test-unit',platform:'linux',mcp:{status:'configured-only',servers:['docs']},sessions:[],sandbox:'no-execution',workspaceReady:true
    }, f.agentToken);
    assert.equal(joined.status,200);
    for (const endpoint of ['/api/task', '/api/task/approve', '/api/task/reject']) {
      assert.equal((await call('POST', endpoint, { deviceId })).status, 404);
    }
    assert.equal((await call('GET', `/api/agent/task?deviceId=${deviceId}`, undefined, f.agentToken)).status, 404);
    assert.equal((await call('POST', '/api/agent/result', { deviceId }, f.agentToken)).status, 404);
    assert.equal((await call('POST', '/api/local/task', { deviceId }, f.agentToken)).status, 403);
    assert.equal((await call('GET', '/api/agent/local/task?deviceId=' + deviceId)).status, 403);
    const state = await call('GET','/api/state');
    assert.equal(Object.hasOwn(state.body, 'jobs'), false);
    assert.deepEqual(state.body.readonlyJobs, []);
    assert.equal(state.body.devices[0].mcp.servers[0],'docs');
    assert.equal(state.body.devices[0].executionMode, 'inventory-only');
    assert.equal(state.body.devices[0].sandbox, 'no-execution');
    assert.equal(state.body.devices[0].localControl, false);
  } finally {
    if (child.exitCode === null) {
      await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
    }
    child.stdout.destroy();
    child.stderr.destroy();
  }
});
