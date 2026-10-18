import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createHub } from '../src/hub.mjs';
import { createAgent } from '../src/agent.mjs';
import { fixture } from '../test-support/fixtures.mjs';

test('real localhost HTTP hub and agent complete an approved demo without Git', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const server = createHub({ token: f.token });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const agent = createAgent({ env: { ...f.env, LEVERAGE_URL: url } });
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
  assert.match(await page.text(), /DEMO/);
  const css = await fetch(url + '/app.css');
  assert.match(css.headers.get('content-type'), /text\/css/);
  const oversized = await fetch(url + '/api/task', {
    method: 'POST', headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'ă'.repeat(10001) }), signal: AbortSignal.timeout(2000)
  });
  assert.equal(oversized.status, 413);
  await oversized.json();
  await agent.tick();
  const proposed = await call('POST', '/api/task', { deviceId: agent.deviceId, prompt: 'Simulate repository summary' });
  await agent.tick();
  assert.equal((await call('GET', '/api/state')).jobs[0].status, 'pending_approval');
  await call('POST', '/api/task/approve', { jobId: proposed.job.id });
  await agent.tick();
  const completed = (await call('GET', '/api/state')).jobs[0];
  assert.equal(completed.status, 'completed');
  assert.match(completed.output, /DEMO ONLY/);
  assert.equal(fs.existsSync(path.join(f.workspace, '.git')), false);
  assert.deepEqual(fs.readdirSync(f.workspace), []);
});
