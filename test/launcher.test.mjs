import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createLauncher } from '../src/launcher.mjs';

const DEVICE_ID = '1e59fe12-249e-4cec-97db-aa6cc773a198';
const OPERATOR = 'launcher-synthetic-operator-only-'.padEnd(64, 'a');
const AGENT = 'launcher-synthetic-agent-only-'.padEnd(64, 'b');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function privateFile(file, content) { fs.writeFileSync(file, content, { mode: 0o600 }); }

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leverage-launcher-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, '.local-run'), { mode: 0o700 });
  const port = await availablePort();
  privateFile(path.join(root, '.local-run/hub.env'), 'LEVERAGE_OPERATOR_TOKEN=' + OPERATOR + '\nLEVERAGE_PORT=' + port + '\n');
  privateFile(path.join(root, '.local-run/laptop1.env'), 'LEVERAGE_AGENT_ID=' + DEVICE_ID + '\nLEVERAGE_AGENT_TOKEN=' + AGENT + '\nLEVERAGE_DEVICE=synthetic\n');
  privateFile(path.join(root, '.local-run/agents.json'), JSON.stringify({ version: 1, agents: [{ id: DEVICE_ID,
    name: 'synthetic', tokenHash: createHash('sha256').update(AGENT).digest('hex'),
    createdAt: '2026-10-23T00:00:00.000Z', revokedAt: null }] }));
  fs.writeFileSync(path.join(root, 'src/hub.mjs'), `import http from 'node:http';
const devices = [];
http.createServer((req,res) => {
  const expected = req.url === '/api/state' ? process.env.LEVERAGE_OPERATOR_TOKEN : '${AGENT}';
  if(req.headers.authorization !== 'Bearer '+expected) {res.writeHead(401); return res.end('{}');}
  res.setHeader('Content-Type','application/json');
  if(req.method === 'POST') {devices[0]={id:'${DEVICE_ID}',online:true,lastSeen:Date.now()}; res.end('{}');}
  else res.end(JSON.stringify({devices:devices.map(device=>({...device,online:Date.now()-device.lastSeen<1000})),secret:'SYNTHETIC_MUST_NOT_LOG'}));
}).listen(Number(process.env.LEVERAGE_PORT),'127.0.0.1');
`);
  fs.writeFileSync(path.join(root, 'src/agent.mjs'), `if(process.env.LEVERAGE_LOCAL_READONLY!=='1') process.exit(1);
const tick=()=>fetch(process.env.LEVERAGE_URL+'/heartbeat',{method:'POST',headers:{Authorization:'Bearer '+process.env.LEVERAGE_AGENT_TOKEN}}).catch(()=>{});
await tick();setInterval(tick,1000);
`);
  const output = [];
  const launcher = createLauncher({ root, env: process.env, log: value => output.push(value), startTimeoutMs: 4000, stopTimeoutMs: 1000 });
  t.after(async () => { await launcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, port, launcher, output };
}

test('launcher starts real owned children, prevents duplicates, reports heartbeat and stops only its children', async t => {
  const f = await fixture(t);
  const first = await f.launcher.start();
  const second = await f.launcher.start();
  assert.equal(first.hubPid, second.hubPid);
  assert.equal(first.agentPid, second.agentPid);
  const status = await f.launcher.status();
  assert.equal(status.hub.ownedRunning, true);
  assert.equal(status.agent.ownedRunning, true);
  assert.equal(status.agent.online, true);
  assert.ok(status.agent.lastHeartbeat);
  await f.launcher.logs();
  const output = f.output.join('\n');
  for (const secret of [OPERATOR, AGENT, 'SYNTHETIC_MUST_NOT_LOG']) assert.equal(output.includes(secret), false);
  const stateFile = path.join(f.root, '.local-run/launcher/state.json');
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(stateFile)).mode & 0o777, 0o700);
  await f.launcher.stop();
  const stopped = await f.launcher.status();
  assert.equal(stopped.hub.ownedRunning, false);
  assert.equal(stopped.agent.ownedRunning, false);
  assert.equal(fs.existsSync(path.join(f.root, '.local-run/hub.env')), true);
  assert.equal(fs.existsSync(path.join(f.root, '.local-run/laptop1.env')), true);
});

test('independent concurrent launchers serialize start and detached children survive their controllers', async t => {
  const f = await fixture(t);
  const wrapper = path.join(f.root, 'controller.mjs');
  const module = new URL('../src/launcher.mjs', import.meta.url).href;
  fs.writeFileSync(wrapper, 'import {createLauncher} from ' + JSON.stringify(module) + ';\n' +
    'try { console.log(JSON.stringify(await createLauncher({root:' + JSON.stringify(f.root) + ',startTimeoutMs:4000}).start())); }' +
    'catch(error) { console.error(error.message); process.exitCode=1; }\n');
  const start = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper], { cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
  const results = await Promise.all([start(), start()]);
  assert.ok(results.some(result => result.code === 0));
  for (const result of results) {
    assert.ok(result.code === 0 || (result.code === 1 && result.output.includes('already running')));
    assert.equal(result.output.includes(OPERATOR), false);
    assert.equal(result.output.includes(AGENT), false);
  }
  const status = await f.launcher.status();
  assert.equal(status.hub.ownedRunning, true);
  assert.equal(status.agent.ownedRunning, true);
  assert.equal(status.agent.online, true);
  const existing = JSON.parse(fs.readFileSync(path.join(f.root, '.local-run/launcher/state.json'), 'utf8'));
  const stable = await f.launcher.start();
  assert.equal(existing.hub.pid, stable.hubPid);
  assert.equal(existing.agent.pid, stable.agentPid);
});

test('occupied unmanaged port is diagnosed without adopting or stopping its server', async t => {
  const f = await fixture(t);
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(f.port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(f.launcher.start(), /unmanaged process/);
  assert.equal(server.listening, true);
});

test('missing and unsafe credential files fail without generating replacements or printing secrets', async t => {
  const f = await fixture(t);
  const agentFile = path.join(f.root, '.local-run/laptop1.env');
  fs.chmodSync(agentFile, 0o644);
  await assert.rejects(f.launcher.start(), /private file/);
  fs.unlinkSync(agentFile);
  await assert.rejects(f.launcher.start(), /credentials are required/);
  assert.equal(fs.existsSync(agentFile), false);
  assert.equal(f.output.join('\n').includes(OPERATOR), false);
});

test('failed agent startup rolls back only children created by that start operation', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'src/agent.mjs'), 'process.exit(2);\n');
  await assert.rejects(f.launcher.start(), /owned agent exited/);
  const report = await f.launcher.status();
  assert.equal(report.hub.ownedRunning, false);
  assert.equal(report.agent.ownedRunning, false);
  assert.equal(report.portListening, false);
});

test('failed agent restart preserves an already managed Hub', async t => {
  const f = await fixture(t);
  const initial = await f.launcher.start();
  process.kill(initial.agentPid, 'SIGTERM');
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!(await f.launcher.status()).agent.ownedRunning) break;
    await delay(20);
  }
  // Wait for the synthetic Hub's one-second heartbeat TTL before restarting.
  await delay(1100);
  fs.writeFileSync(path.join(f.root, 'src/agent.mjs'), 'process.exit(2);\n');
  await assert.rejects(f.launcher.start(), /owned agent exited/);
  const report = await f.launcher.status();
  assert.equal(report.hub.ownedRunning, true);
  assert.equal(report.agent.ownedRunning, false);
  assert.equal(report.portListening, true);
  const state = JSON.parse(fs.readFileSync(path.join(f.root, '.local-run/launcher/state.json'), 'utf8'));
  assert.equal(state.hub.pid, initial.hubPid);
});

test('stale or reused PID records cannot cause an unrelated process to be signalled', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, '.local-run/launcher');
  fs.mkdirSync(directory, { mode: 0o700 });
  const state = { version: 1, host: '127.0.0.1', port: f.port, deviceId: DEVICE_ID, hub: null,
    agent: { pid: process.pid, startTime: '0', uid: process.getuid(), executable: fs.realpathSync(process.execPath),
      cwd: f.root, entry: path.join(f.root, 'src/agent.mjs') } };
  privateFile(path.join(directory, 'state.json'), JSON.stringify(state));
  await f.launcher.stop();
  assert.equal(process.kill(process.pid, 0), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8')).agent, null);
});

test('process start-time mismatch prevents signalling even an identical command in the same workspace', async t => {
  const f = await fixture(t);
  const executable = fs.realpathSync(process.execPath);
  const child = spawn(executable, [path.join(f.root, 'src/agent.mjs')], {
    cwd: f.root, env: { LEVERAGE_LOCAL_READONLY: '1' }, stdio: 'ignore'
  });
  await once(child, 'spawn');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  });
  const directory = path.join(f.root, '.local-run/launcher');
  fs.mkdirSync(directory, { mode: 0o700 });
  privateFile(path.join(directory, 'state.json'), JSON.stringify({ version: 1, host: '127.0.0.1', port: f.port,
    deviceId: DEVICE_ID, hub: null, agent: { pid: child.pid, startTime: '0', uid: process.getuid(), executable,
      cwd: f.root, entry: path.join(f.root, 'src/agent.mjs') } }));
  await f.launcher.stop();
  assert.equal(process.kill(child.pid, 0), true);
});

test('logs filter malformed records and injected secret fields', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, '.local-run/launcher');
  fs.mkdirSync(directory, { mode: 0o700 });
  privateFile(path.join(directory, 'operations.jsonl'), JSON.stringify({ at: '2026-10-23T00:00:00.000Z',
    event: 'hub-ready', rawOutput: OPERATOR }) + '\n' + AGENT + '\n');
  const rows = await f.launcher.logs();
  assert.equal(rows.length, 1);
  assert.equal(f.output.join('\n').includes(OPERATOR), false);
  assert.equal(f.output.join('\n').includes(AGENT), false);
});
