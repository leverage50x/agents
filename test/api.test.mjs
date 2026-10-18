import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub, validToken, startHub } from '../src/hub.mjs';
import { createAgent } from '../src/agent.mjs';
import { loopbackHost, localHubUrl, validateToken, workspaceReady } from '../src/local-config.mjs';
import { fixture, dispatch, device, register } from '../test-support/fixtures.mjs';

function setup(t, options = {}) {
  const f = fixture(t);
  const server = createHub({ token: f.token, ...options });
  return { ...f, call: input => dispatch(server, f.token, input) };
}

test('local configuration rejects external destinations, credentials and weak tokens', t => {
  const f = fixture(t);
  assert.equal(loopbackHost('localhost'), '127.0.0.1');
  assert.equal(loopbackHost('::1'), '::1');
  assert.equal(localHubUrl('http://localhost:8765'), 'http://127.0.0.1:8765');
  assert.equal(localHubUrl('http://[::1]:8765'), 'http://[::1]:8765');
  for (const value of ['0.0.0.0', '192.168.1.2', 'example.invalid', '127.0.0.1.example.invalid']) {
    assert.throws(() => loopbackHost(value), /loopback/);
  }
  for (const value of ['https://127.0.0.1', 'http://example.invalid', 'http://user:password@127.0.0.1',
    'http://127.0.0.1/path', 'http://127.0.0.1/?query=1', 'http://127.0.0.1/#fragment', 'invalid']) {
    assert.throws(() => localHubUrl(value));
    assert.throws(() => createAgent({ env: { ...f.env, LEVERAGE_URL: value } }));
  }
  assert.throws(() => startHub({ ...f.env, LEVERAGE_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => startHub({ ...f.env, LEVERAGE_PORT: 'invalid' }), /port/);
  assert.throws(() => validateToken('short'));
  assert.throws(() => validateToken('x'.repeat(24) + '\n'));
  assert.ok(workspaceReady(f.workspace));
  assert.equal(workspaceReady('relative'), false);
});

test('authentication requires a valid bearer token and rejects unauthenticated approval', async t => {
  const f = setup(t);
  assert.ok(validToken('Bearer ' + f.token, f.token));
  assert.equal(validToken(f.token, f.token), false);
  assert.equal(validToken('Bearer wrong', f.token), false);
  assert.equal(validToken('Bearer ', ''), false);
  assert.equal((await f.call({ authorization: '' })).status, 401);
  assert.equal((await f.call({ method: 'POST', endpoint: '/api/task/approve', body: {}, authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await f.call()).headers['Access-Control-Allow-Origin'], undefined);
});

test('API rejects malformed/non-object JSON and counts bytes, preserving chunked UTF-8', async t => {
  const { call } = setup(t);
  for (const raw of ['null', '[]', '"value"', 'true', '1', '{', '']) {
    const result = await call({ method: 'POST', endpoint: '/api/task', raw });
    assert.equal(result.status, 400);
    assert.equal(JSON.stringify(result.body).includes('TypeError'), false);
  }
  const large = await call({ method: 'POST', endpoint: '/api/task', raw: JSON.stringify({ prompt: 'ă'.repeat(10001) }) });
  assert.equal(large.status, 413);
  await register(call);
  const bytes = Buffer.from(JSON.stringify({ deviceId: device.deviceId, prompt: 'ă demo' }));
  const at = bytes.indexOf(Buffer.from('ă')) + 1;
  const valid = await call({ method: 'POST', endpoint: '/api/task', chunks: [bytes.subarray(0, at), bytes.subarray(at)] });
  assert.equal(valid.status, 201);
  assert.equal(valid.body.job.prompt, 'ă demo');
});

test('invalid heartbeat data is rejected atomically and cannot claim live capabilities', async t => {
  const { call } = setup(t);
  const post = body => call({ method: 'POST', endpoint: '/api/agent/heartbeat', body });
  for (const change of [
    { deviceId: 1 }, { name: null }, { platform: [] }, { workspaceReady: 'yes' },
    { mcp: null }, { mcp: { status: 'connected', servers: [] } },
    { mcp: { status: 'configured-only', servers: [null] } },
    { sessions: [null] }, { sessions: [{ id: 'invalid', modified: 'invalid' }] },
    { sessionInventory: { status: 'live', truncated: false } }
  ]) assert.equal((await post({ ...device, ...change })).status, 400);
  assert.equal((await call()).body.devices.length, 0);
  const session = { id: '01a0f2f7-6fa5-7f72-999c-8522c8196a4f', modified: '2026-10-17T00:00:00.000Z', secret: 'SYNTHETIC_DO_NOT_RETURN' };
  assert.equal((await post({ ...device, sessions: [session], executionMode: 'live', sandbox: 'unrestricted',
    sessionInventory: { status: 'partial', truncated: true } })).status, 200);
  const state = (await call()).body;
  assert.equal(state.devices[0].executionMode, 'demo-only');
  assert.equal(state.devices[0].sandbox, 'no-execution');
  assert.equal(state.devices[0].sessionInventory.truncated, true);
  assert.equal(JSON.stringify(state).includes('SYNTHETIC_DO_NOT_RETURN'), false);
});

test('only explicitly approved jobs are claimed, with one terminal result', async t => {
  const { call } = setup(t);
  await register(call);
  for (const prompt of [null, {}, '', ' ', 'x'.repeat(2001)]) {
    assert.equal((await call({ method: 'POST', endpoint: '/api/task', body: { deviceId: device.deviceId, prompt } })).status, 400);
  }
  const queued = await call({ method: 'POST', endpoint: '/api/task', body: { deviceId: device.deviceId, prompt: 'Synthetic demo' } });
  const jobId = queued.body.job.id;
  const claim = () => call({ endpoint: '/api/agent/task?deviceId=' + device.deviceId });
  assert.equal((await claim()).body.job, null);
  assert.equal((await call({ method: 'POST', endpoint: '/api/task/approve', body: { jobId } })).status, 200);
  assert.equal((await call({ method: 'POST', endpoint: '/api/task/approve', body: { jobId } })).status, 409);
  assert.equal((await claim()).body.job.status, 'running');
  assert.equal((await claim()).body.job, null);
  const result = { jobId, deviceId: device.deviceId, status: 'completed', output: 'MOCK DEMO RESULT' };
  assert.equal((await call({ method: 'POST', endpoint: '/api/agent/result', body: { ...result, deviceId: 'b'.repeat(20) } })).status, 400);
  assert.equal((await call({ method: 'POST', endpoint: '/api/agent/result', body: { ...result, status: 'live' } })).status, 400);
  assert.equal((await call({ method: 'POST', endpoint: '/api/agent/result', body: result })).status, 200);
  assert.equal((await call({ method: 'POST', endpoint: '/api/agent/result', body: result })).status, 400);
});

test('rejected jobs are terminal; expired devices cannot receive instructions', async t => {
  let time = Date.now();
  const { call } = setup(t, { now: () => time });
  await register(call);
  const jobId = (await call({ method: 'POST', endpoint: '/api/task', body: { deviceId: device.deviceId, prompt: 'Reject demo' } })).body.job.id;
  assert.equal((await call({ method: 'POST', endpoint: '/api/task/reject', body: { jobId } })).body.status, 'rejected');
  assert.equal((await call({ method: 'POST', endpoint: '/api/task/approve', body: { jobId } })).status, 409);
  assert.equal((await call({ endpoint: '/api/agent/task?deviceId=' + device.deviceId })).body.job, null);
  time += 15000;
  assert.equal((await call()).body.devices[0].online, false);
  assert.equal((await call({ method: 'POST', endpoint: '/api/task', body: { deviceId: device.deviceId, prompt: 'offline' } })).status, 400);
  assert.equal((await call({ endpoint: '/api/agent/task?deviceId=' + device.deviceId })).status, 400);
});

test('dashboard assets are served with restrictive headers', async t => {
  const { call } = setup(t);
  for (const endpoint of ['/', '/app.js', '/app.css']) {
    const result = await call({ endpoint, authorization: '' });
    assert.equal(result.status, 200);
    assert.ok(result.headers['Content-Security-Policy'].includes("frame-ancestors 'none'"));
    assert.ok(result.body.length > 0);
  }
});
