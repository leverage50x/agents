import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createHub } from '../src/hub.mjs';
import { createAgent } from '../src/agent.mjs';
import { fixture } from '../test-support/fixtures.mjs';

test('loopback HTTP hub and agent require real-turn confirmation and preserve New/Resume without legacy routes', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const server = createHub({ token: f.token, credentialStore: f.store,
    localControl: { deviceId: f.device.deviceId, workspace: f.workspace } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const threadId = '11111111-1111-4111-8111-111111111111';
  const turns = [];
  let loaded = false;
  const agent = createAgent({ env: { ...f.env, LEVERAGE_URL: url, LEVERAGE_LOCAL_READONLY: '1' },
    controlFactory: () => ({
      accountStatus: async () => ({ status: 'authenticated' }),
      listSessions: async () => ({ status: 'available', source: 'app-server', truncated: false,
        sessions: loaded ? [{ id: threadId, modified: '2026-10-27T08:00:00.000Z',
          lastActivity: '2026-10-27T08:00:00.000Z', source: 'app-server', eligibility: 'confirmed' }] : [] }),
      run: async (job, onEvent) => {
        assert.equal(job.confirmed, true);
        assert.equal(job.policy, 'local-read-only');
        if (job.mode === 'resume') assert.equal(job.threadId, threadId);
        turns.push(job.mode); loaded = true;
        onEvent({ type: 'progress', message: 'Synthetic protocol progress.' });
        return { status: 'completed', threadId, output: 'Synthetic protocol result; no model or file changes.' };
      },
      close: async () => {}
    }) });
  t.after(async () => { await agent.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function call(method, endpoint, body) {
    const response = await fetch(url + endpoint, {
      method, headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(2000)
    });
    assert.ok(response.ok);
    return response.json();
  }
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /READ-ONLY/);
  assert.doesNotMatch(html, /DEMO|Propose demo instruction|DEMO tasks and approvals/i);
  const css = await fetch(url + '/app.css');
  assert.match(css.headers.get('content-type'), /text\/css/);
  const oversized = await fetch(url + '/api/local/task', {
    method: 'POST', headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'ă'.repeat(10001) }), signal: AbortSignal.timeout(2000)
  });
  assert.equal(oversized.status, 413);
  await oversized.json();
  await agent.tick();
  const state = await call('GET', '/api/state');
  assert.equal(Object.hasOwn(state, 'jobs'), false);
  assert.equal(state.devices[0].executionMode, 'local-read-only');
  const request = { deviceId: agent.deviceId, mode: 'new', workspaceId: 'project',
    prompt: 'Inspect the synthetic project without changing files.', confirmed: true };
  const unapproved = await fetch(url + '/api/local/task', { method: 'POST',
    headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, confirmed: false }) });
  assert.equal(unapproved.status, 400);
  await unapproved.json();
  await agent.tick();
  assert.deepEqual(turns, []);
  for (const mode of ['new', 'resume']) {
    const proposed = await call('POST', '/api/local/task', { ...request, mode,
      ...(mode === 'resume' ? { threadId } : {}) });
    await agent.tick();
    await agent.waitForIdle();
    const completed = (await call('GET', '/api/state')).readonlyJobs.find(j => j.id === proposed.job.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.threadId, threadId);
    await agent.tick();
  }
  assert.deepEqual(turns, ['new', 'resume']);
  for (const endpoint of ['/api/task', '/api/task/approve', '/api/task/reject']) {
    const removed = await fetch(url + endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + f.token,
      'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(removed.status, 404);
    await removed.json();
  }
  assert.equal(fs.existsSync(path.join(f.workspace, '.git')), false);
  assert.deepEqual(fs.readdirSync(f.workspace), []);
});
