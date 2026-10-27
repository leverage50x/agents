import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAgent } from '../src/agent.mjs';
import { createHub } from '../src/hub.mjs';
import { fixture, dispatch } from '../test-support/fixtures.mjs';

test('inventory-only agent reports metadata without polling or accepting executable work', async t => {
  const f = fixture(t);
  const server = createHub({ token: f.token, credentialStore: f.store });
  const call = input => dispatch(server, f.token, input);
  fs.writeFileSync(path.join(f.home, 'config.toml'), '[mcp_servers.synthetic]\npassword="SYNTHETIC_PRIVATE_VALUE"\n');
  const requests = [];
  const agent = createAgent({ env: f.env, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    requests.push({ endpoint: new URL(url).pathname, data: options.body ? JSON.parse(options.body) : null });
    const result = await call({
      endpoint: new URL(url).pathname + new URL(url).search,
      method: options.method, authorization: options.headers.Authorization,
      body: options.body === undefined ? undefined : JSON.parse(options.body)
    });
    return { ok: result.status < 400, status: result.status, json: async () => result.body };
  } });
  await agent.tick();
  assert.equal(JSON.stringify(requests).includes('SYNTHETIC_PRIVATE_VALUE'), false);
  const state = (await call()).body;
  assert.equal(state.devices[0].workspaceReady, true);
  assert.deepEqual(state.devices[0].mcp.servers, ['synthetic']);
  assert.equal(state.devices[0].sessionInventory.status, 'missing');
  await agent.tick();
  assert.equal(Object.hasOwn((await call()).body, 'jobs'), false);
  assert.equal(state.devices[0].executionMode, 'inventory-only');
  assert.deepEqual(requests.map(r => r.endpoint), ['/api/agent/heartbeat', '/api/agent/heartbeat']);
  assert.deepEqual(fs.readdirSync(f.workspace), []);
});

test('legacy live activation cannot construct a controller or request executable work', async t => {
  const f = fixture(t);
  const calls = [];
  const env = { ...f.env, LEVERAGE_LOCAL_READONLY: '1',
    LEVERAGE_WORKSPACE: path.join(f.root, 'missing'), LEVERAGE_ENABLE_LIVE_CODEX: '1' };
  const agent = createAgent({ env, controlFactory: () => assert.fail('Legacy live flag must not construct a controller.'),
    fetchImpl: async (url, options) => {
      const data = options.body && JSON.parse(options.body);
      calls.push({ url: new URL(url).pathname, data });
      return { ok: true, status: 200, json: async () => ({ job: { id: 'synthetic-unrequested-work', prompt: 'Never execute' } }) };
    } });
  await agent.tick();
  assert.equal(calls[0].data.workspaceReady, false);
  assert.equal(calls[0].data.localControl, false);
  assert.equal(calls[0].data.executionMode, 'inventory-only');
  assert.equal(calls[0].data.codexAuth, 'unavailable');
  assert.deepEqual(calls.map(c => c.url), ['/api/agent/heartbeat']);
  assert.deepEqual(fs.readdirSync(f.workspace), []);
});

test('optional titles cannot push an otherwise valid inventory heartbeat beyond the existing body limit', async t => {
  const f = fixture(t);
  const sessions = Array.from({ length: 40 }, (_, i) => ({
    id: i.toString(16).padStart(8, '0') + '-1111-4111-8111-111111111111',
    modified: '2026-10-26T08:00:00.000Z', lastActivity: '2026-10-26T08:00:00.000Z',
    project: 'p'.repeat(100), title: 't'.repeat(120), source: 'app-server', activity: 'discovered', eligibility: 'discovered'
  }));
  fs.writeFileSync(path.join(f.home, 'config.toml'), Array.from({ length: 20 }, (_, i) =>
    '[mcp_servers.server_' + i + '_' + 's'.repeat(60) + ']').join('\n'));
  let heartbeat;
  const agent = createAgent({ env: { ...f.env, LEVERAGE_LOCAL_READONLY: '1' }, controlFactory: () => ({
    accountStatus: async () => ({ status: 'authenticated' }),
    listSessions: async () => ({ sessions, status: 'available', source: 'app-server', truncated: false }),
    close: async () => {}
  }), fetchImpl: async (url, options) => {
    if (new URL(url).pathname === '/api/agent/heartbeat') heartbeat = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ job: null }) };
  } });
  t.after(() => agent.close());
  await agent.tick();
  assert.equal(heartbeat.sessions.length, 40);
  assert.equal(heartbeat.codexAuth, 'authenticated');
  assert.ok(heartbeat.sessions.every(s => s.title === undefined));
  assert.ok(Buffer.byteLength(JSON.stringify(heartbeat)) < 20000);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...heartbeat, sessions })) >= 19000);
  assert.deepEqual(heartbeat.sessions.map(s => s.id), sessions.map(s => s.id));
});
