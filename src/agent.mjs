import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { codexHome, listMcp, listSessionInventory } from './inventory.mjs';
import { runCodexJob } from './codex-runner.mjs';
import { localHubUrl, validateToken, workspaceReady } from './local-config.mjs';

export function createAgent({ env = process.env, fetchImpl = fetch } = {}) {
  // Validate the destination before constructing or sending authorization headers.
  const url = localHubUrl(env.LEVERAGE_URL || 'http://127.0.0.1:8765');
  const token = validateToken(env.LEVERAGE_TOKEN);
  const name = env.LEVERAGE_DEVICE || os.hostname();
  if (typeof name !== 'string' || !name.trim() || name.length > 64) throw new Error('Invalid local device name.');
  const deviceId = createHash('sha256').update(name).digest('hex').slice(0, 20);
  const home = env.LEVERAGE_CODEX_HOME || env.CODEX_HOME || codexHome();

  async function request(method, endpoint, data, signal) {
    const timeout = AbortSignal.timeout(14000);
    const response = await fetchImpl(url + endpoint, {
      method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!response.ok) throw new Error('Local hub request failed (HTTP ' + response.status + ').');
    return response.json();
  }

  async function tick({ signal } = {}) {
    const { sessions, ...sessionInventory } = listSessionInventory(home);
    await request('POST', '/api/agent/heartbeat', {
      deviceId, name, platform: process.platform, mcp: listMcp(home), sessions, sessionInventory,
      sandbox: 'no-execution', workspaceReady: workspaceReady(env.LEVERAGE_WORKSPACE), executionMode: 'demo-only'
    }, signal);
    const response = await request('GET', '/api/agent/task?deviceId=' + deviceId, undefined, signal);
    if (response.job) {
      let result;
      try {
        result = { ...await runCodexJob(response.job, env), status: 'completed' };
      } catch (error) {
        result = { status: 'failed', output: error.message };
      }
      await request('POST', '/api/agent/result', { deviceId, jobId: response.job.id, ...result }, signal);
    }
  }
  return { tick, deviceId };
}

export async function runAgent({ signal, ...options } = {}) {
  const agent = createAgent(options);
  console.log('Leverage50xAgents local agent started; DEMO ONLY; remote Codex execution disabled.');
  while (!signal?.aborted) {
    try { await agent.tick({ signal }); }
    catch { if (!signal?.aborted) console.error('Local hub request failed; retrying. No credentials or private data logged.'); }
    try { await delay(5000, undefined, { signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try { await runAgent({ signal: controller.signal }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}
