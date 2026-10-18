import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAgent } from '../src/agent.mjs';
import { createHub } from '../src/hub.mjs';
import { fixture, dispatch } from '../test-support/fixtures.mjs';

test('agent uses synthetic inventory and transports only approved demo jobs without redirects', async t => {
  const f = fixture(t);
  const server = createHub({ token: f.token });
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
  const jobId = (await call({ method: 'POST', endpoint: '/api/task', body: { deviceId: agent.deviceId, prompt: 'Simulate only' } })).body.job.id;
  await agent.tick();
  assert.equal((await call()).body.jobs[0].status, 'pending_approval');
  await call({ method: 'POST', endpoint: '/api/task/approve', body: { jobId } });
  await agent.tick();
  const job = (await call()).body.jobs[0];
  assert.equal(job.status, 'completed');
  assert.match(job.output, /DEMO ONLY/);
  assert.deepEqual(fs.readdirSync(f.workspace), []);
});

test('agent reports an invalid workspace and returns a fail-closed live result', async t => {
  const f = fixture(t);
  const calls = [];
  const env = { ...f.env, LEVERAGE_WORKSPACE: path.join(f.root, 'missing'), LEVERAGE_ENABLE_LIVE_CODEX: '1' };
  const agent = createAgent({ env, fetchImpl: async (url, options) => {
    const data = options.body && JSON.parse(options.body);
    calls.push({ url: new URL(url).pathname, data });
    return { ok: true, json: async () => new URL(url).pathname === '/api/agent/task'
      ? { job: { id: 'synthetic-job', prompt: 'Do not execute' } } : { ok: true } };
  } });
  await agent.tick();
  assert.equal(calls[0].data.workspaceReady, false);
  assert.equal(calls[2].data.status, 'failed');
  assert.match(calls[2].data.output, /LIVE CODEX BLOCKED/);
});
