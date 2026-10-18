import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

test('CLI hub authenticates, approves demo dispatch and accepts a mocked result', { timeout: 10000 }, async () => {
  const port = await freePort();
  const token = 'test-only-secret-that-is-at-least-24-characters-long';
  const child = spawn(process.execPath, ['src/hub.mjs'], {
    cwd: process.cwd(), env: { ...process.env, LEVERAGE_TOKEN: token, LEVERAGE_PORT: String(port), LEVERAGE_HOST: '127.0.0.1' },
    stdio: ['ignore','pipe','pipe']
  });
  async function call(method, endpoint, data, authorization = token) {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method, headers: { Authorization: `Bearer ${authorization}`, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    let ready = false;
    for (let i=0;i<25;i++) {
      try { await call('GET','/api/state'); ready = true; break; } catch { await wait(40); }
    }
    assert.ok(ready, 'hub started');
    assert.equal((await call('GET','/api/state',undefined,'wrong-secret')).status,401);
    const deviceId = 'a'.repeat(20);
    const joined = await call('POST','/api/agent/heartbeat',{
      deviceId,name:'test-unit',platform:'linux',mcp:{status:'configured-only',servers:['docs']},sessions:[],sandbox:'no-execution',workspaceReady:true
    });
    assert.equal(joined.status,200);
    const queued = await call('POST','/api/task',{deviceId,prompt:'Summarize this personal repository'});
    assert.equal(queued.status,201);
    assert.equal(queued.body.job.status,'pending_approval');
    const premature=await call('GET',`/api/agent/task?deviceId=${deviceId}`);
    assert.equal(premature.body.job,null,'unapproved jobs are not delivered');
    const unauthorizedApproval=await call('POST','/api/task/approve',{jobId:queued.body.job.id},'wrong-secret');
    assert.equal(unauthorizedApproval.status,401);
    const approved=await call('POST','/api/task/approve',{jobId:queued.body.job.id});
    assert.equal(approved.body.status,'queued');
    const claimed = await call('GET',`/api/agent/task?deviceId=${deviceId}`);
    assert.equal(claimed.body.job.id,queued.body.job.id);
    const completed=await call('POST','/api/agent/result',{
      deviceId,jobId:claimed.body.job.id,status:'completed',output:'MOCK DEMO RESULT — no command executed.'
    });
    assert.equal(completed.status,200);
    const state = await call('GET','/api/state');
    assert.equal(state.body.jobs[0].status,'completed');
    assert.equal(state.body.devices[0].mcp.servers[0],'docs');
    const declined = await call('POST','/api/task',{deviceId,prompt:'Do not run this task'});
    assert.equal(declined.body.job.status,'pending_approval');
    assert.equal((await call('POST','/api/task/reject',{jobId:declined.body.job.id})).body.status,'rejected');
    assert.equal((await call('GET',`/api/agent/task?deviceId=${deviceId}`)).body.job,null);
  } finally {
    if (child.exitCode === null) {
      await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
    }
    child.stdout.destroy();
    child.stderr.destroy();
  }
});
