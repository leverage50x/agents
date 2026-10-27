import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHub, validToken, startHub } from '../src/hub.mjs';
import { createAgent } from '../src/agent.mjs';
import { loopbackHost, localHubUrl, validateToken, workspaceReady } from '../src/local-config.mjs';
import { fixture, dispatch, register } from '../test-support/fixtures.mjs';

function setup(t, { localReadOnly = false, ...options } = {}) {
  const f = fixture(t);
  const server = createHub({ token: f.token, credentialStore: f.store, ...options,
    ...(localReadOnly ? { localControl: { deviceId: f.device.deviceId, workspace: f.workspace } } : {}) });
  return { ...f, server, binding: createHash('sha256').update(f.workspace).digest('hex'),
    call: input => dispatch(server, f.token, input), agentCall: input => dispatch(server, f.agentToken, input) };
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

test('authentication requires a valid bearer token and rejects unauthenticated local instructions', async t => {
  const f = setup(t);
  assert.ok(validToken('Bearer ' + f.token, f.token));
  assert.equal(validToken(f.token, f.token), false);
  assert.equal(validToken('Bearer wrong', f.token), false);
  assert.equal(validToken('Bearer ', ''), false);
  assert.equal((await f.call({ authorization: '' })).status, 401);
  assert.equal((await f.call({ method: 'POST', endpoint: '/api/local/task', body: {}, authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await f.call()).headers['Access-Control-Allow-Origin'], undefined);
});

test('API rejects malformed/non-object JSON and counts bytes, preserving chunked UTF-8', async t => {
  const { call } = setup(t);
  for (const raw of ['null', '[]', '"value"', 'true', '1', '{', '']) {
    const result = await call({ method: 'POST', endpoint: '/api/admin/agents', raw });
    assert.equal(result.status, 400);
    assert.equal(JSON.stringify(result.body).includes('TypeError'), false);
  }
  const large = await call({ method: 'POST', endpoint: '/api/admin/agents', raw: JSON.stringify({ name: 'ă'.repeat(10001) }) });
  assert.equal(large.status, 413);
  const bytes = Buffer.from(JSON.stringify({ name: 'Dispozitiv ă' }));
  const at = bytes.indexOf(Buffer.from('ă')) + 1;
  const valid = await call({ method: 'POST', endpoint: '/api/admin/agents', chunks: [bytes.subarray(0, at), bytes.subarray(at)] });
  assert.equal(valid.status, 201);
  assert.equal(valid.body.name, 'Dispozitiv ă');
});

test('invalid heartbeat data is rejected atomically and cannot claim live capabilities', async t => {
  const { call, agentCall, device } = setup(t);
  const post = body => agentCall({ method: 'POST', endpoint: '/api/agent/heartbeat', body });
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
  assert.equal(state.devices[0].executionMode, 'inventory-only');
  assert.equal(state.devices[0].sandbox, 'no-execution');
  assert.equal(state.devices[0].sessionInventory.truncated, true);
  assert.equal(JSON.stringify(state).includes('SYNTHETIC_DO_NOT_RETURN'), false);
});

test('session titles are optional sanitized App Server metadata without name or preview fallback', async t => {
  const { call, agentCall, device } = setup(t);
  const session = { id: '01a0f2f7-6fa5-7f72-999c-8522c8196a4f', modified: '2026-10-17T00:00:00.000Z',
    source: 'app-server', name: 'SYNTHETIC_NAME_NOT_ALLOWED', preview: 'SYNTHETIC_PREVIEW_NOT_ALLOWED',
    turns: ['SYNTHETIC_TRANSCRIPT_NOT_ALLOWED'] };
  const post = async patch => {
    const result = await agentCall({ method: 'POST', endpoint: '/api/agent/heartbeat',
      body: { ...device, sessions: [{ ...session, ...patch }] } });
    assert.equal(result.status, 200);
    const state = (await call()).body;
    for (const marker of ['SYNTHETIC_NAME_NOT_ALLOWED', 'SYNTHETIC_PREVIEW_NOT_ALLOWED', 'SYNTHETIC_TRANSCRIPT_NOT_ALLOWED']) {
      assert.equal(JSON.stringify(state).includes(marker), false);
    }
    return state.devices[0].sessions[0];
  };
  assert.equal((await post({ title: '  Plan   pentru MVP  ' })).title, 'Plan pentru MVP');
  const bounded = await post({ title: '😀 Analiză '.repeat(80) });
  assert.ok(Buffer.byteLength(bounded.title) <= 120);
  assert.equal(bounded.title.isWellFormed(), true);
  assert.equal(bounded.title.endsWith('…'), true);
  for (const title of [undefined, null, {}, [], 17, ' ', 'a'.repeat(4097), '\ud800',
    'invalid\nmultiline', 'invalid\u202ebidi', 'synthetic' + '@example.invalid',
    'ghp_' + 'x'.repeat(40), 'password=' + 'synthetic-only', '/home/' + 'synthetic-private/project',
    'workspace=/synthetic/path', 'cwd:C:\\synthetic\\project']) {
    assert.equal(Object.hasOwn(await post({ title }), 'title'), false);
  }
  assert.equal(Object.hasOwn(await post({ title: 'Safe official title', source: 'files' }), 'title'), false);
  assert.equal(Object.hasOwn(await post({ title: 'Safe official title', source: 'unknown' }), 'title'), false);
});

test('retired dispatch endpoints return 404 and cannot create or deliver jobs', async t => {
  const { call, agentCall, device } = setup(t);
  await register(agentCall, device);
  for (const endpoint of ['/api/task', '/api/task/approve', '/api/task/reject']) {
    assert.equal((await call({ method: 'POST', endpoint, body: { deviceId: device.deviceId } })).status, 404);
  }
  assert.equal((await agentCall({ endpoint: '/api/agent/task?deviceId=' + device.deviceId })).status, 404);
  assert.equal((await agentCall({ method: 'POST', endpoint: '/api/agent/result', body: { deviceId: device.deviceId } })).status, 404);
  const state = (await call()).body;
  assert.equal(Object.hasOwn(state, 'jobs'), false);
  assert.deepEqual(state.readonlyJobs, []);
});

test('execution capability is calculated from the configured local identity and workspace binding', async t => {
  const f = setup(t, { localReadOnly: true });
  const report = patch => f.agentCall({ method: 'POST', endpoint: '/api/agent/heartbeat', body: {
    ...f.device, localControl: true, workspaceBinding: f.binding, codexAuth: 'authenticated',
    executionMode: 'live', sandbox: 'unrestricted', ...patch,
  } });
  assert.equal((await report({})).status, 200);
  let device = (await f.call()).body.devices[0];
  assert.equal(device.executionMode, 'local-read-only');
  assert.equal(device.sandbox, 'no-execution');
  assert.equal(device.localControl, true);
  assert.equal((await report({ workspaceBinding: '0'.repeat(64), executionMode: 'local-read-only' })).status, 200);
  device = (await f.call()).body.devices[0];
  assert.equal(device.executionMode, 'inventory-only');
  assert.equal(device.localControl, false);
  const other = f.store.enroll('another-device');
  assert.equal((await dispatch(f.server, other.token, {
    method: 'POST', endpoint: '/api/agent/heartbeat', body: { ...f.device, deviceId: other.deviceId,
      localControl: true, workspaceBinding: f.binding, executionMode: 'local-read-only', codexAuth: 'authenticated' },
  })).status, 200);
  const untrusted = (await f.call()).body.devices.find(value => value.id === other.deviceId);
  assert.equal(untrusted.executionMode, 'inventory-only');
  assert.equal(untrusted.localControl, false);
  assert.equal(untrusted.codexAuth, 'unavailable');
  assert.equal(untrusted.sandbox, 'no-execution');
});

test('explicit READ-ONLY confirmation and one terminal result remain required for local jobs', async t => {
  const f = setup(t, { localReadOnly: true });
  await register(f.agentCall, { ...f.device, localControl: true, workspaceBinding: f.binding, codexAuth: 'authenticated' });
  const body = { deviceId: f.device.deviceId, mode: 'new', workspaceId: 'project', prompt: 'Synthetic read-only instruction', confirmed: true };
  assert.equal((await f.call({ method: 'POST', endpoint: '/api/local/task', body: { ...body, confirmed: false } })).status, 400);
  const created = await f.call({ method: 'POST', endpoint: '/api/local/task', body });
  assert.equal(created.status, 201);
  const jobId = created.body.job.id;
  const claim = () => f.agentCall({ endpoint: '/api/agent/local/task?deviceId=' + f.device.deviceId });
  assert.equal((await claim()).body.job.status, 'running');
  assert.equal((await claim()).body.job, null);
  const update = { deviceId: f.device.deviceId, jobId, status: 'completed', output: 'Synthetic read-only result' };
  assert.equal((await f.agentCall({ method: 'POST', endpoint: '/api/agent/local/update', body: { ...update, status: 'live' } })).status, 400);
  assert.equal((await f.agentCall({ method: 'POST', endpoint: '/api/agent/local/update', body: update })).status, 200);
  assert.equal((await f.agentCall({ method: 'POST', endpoint: '/api/agent/local/update', body: update })).status, 409);
  const state = (await f.call()).body;
  assert.equal(Object.hasOwn(state, 'jobs'), false);
  assert.equal(state.readonlyJobs[0].status, 'completed');
});

test('expired and revoked local devices cannot receive instructions', async t => {
  let time = Date.now();
  const f = setup(t, { localReadOnly: true, now: () => time });
  const heartbeat = { ...f.device, localControl: true, workspaceBinding: f.binding, codexAuth: 'authenticated' };
  await register(f.agentCall, heartbeat);
  const body = { deviceId: f.device.deviceId, mode: 'new', workspaceId: 'project', prompt: 'Synthetic read-only instruction', confirmed: true };
  assert.equal((await f.call({ method: 'POST', endpoint: '/api/local/task', body })).status, 201);
  time += 15000;
  let state = (await f.call()).body;
  assert.equal(state.devices[0].online, false);
  assert.equal(state.readonlyJobs[0].errorCode, 'agent-disconnected');
  assert.equal((await f.call({ method: 'POST', endpoint: '/api/local/task', body })).status, 400);
  assert.equal((await f.agentCall({ endpoint: '/api/agent/local/task?deviceId=' + f.device.deviceId })).status, 400);
  await register(f.agentCall, heartbeat);
  const created = await f.call({ method: 'POST', endpoint: '/api/local/task', body });
  assert.equal(created.status, 201);
  assert.equal((await f.call({ method: 'POST', endpoint: '/api/admin/agents/revoke', body: { deviceId: f.device.deviceId } })).status, 200);
  state = (await f.call()).body;
  assert.equal(state.readonlyJobs.find(job => job.id === created.body.job.id).errorCode, 'agent-revoked');
  assert.equal((await f.agentCall({ endpoint: '/api/agent/local/task?deviceId=' + f.device.deviceId })).status, 401);
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
