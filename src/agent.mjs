import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { codexHome, listMcp } from './inventory.mjs';
import { discoverCodexSessions } from './codex-app-server.mjs';
import { createCodexControl } from './codex-control.mjs';
import { localHubUrl, validateToken, workspaceReady } from './local-config.mjs';

// Count serialized UTF-8 bytes, including JSON escapes, without splitting a
// Unicode code point. This is also stricter than the Hub's character limits.
function boundedText(value, budget) {
  const pieces = [];
  let bytes = 0;
  for (const character of value.toWellFormed()) {
    const cost = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + cost > budget) break;
    bytes += cost;
    pieces.push(character);
  }
  return pieces.join('');
}

export function createAgent({ env = process.env, fetchImpl = fetch, controlFactory = createCodexControl,
  now = Date.now, recoveryDelayMs = 5000 } = {}) {
  if (typeof now !== 'function' || !Number.isInteger(recoveryDelayMs) || recoveryDelayMs < 50 || recoveryDelayMs > 30000) {
    throw new Error('Invalid local controller recovery configuration.');
  }
  env = Object.freeze({ ...env });
  // Validate the destination before constructing or sending authorization headers.
  const url = localHubUrl(env.LEVERAGE_URL || 'http://127.0.0.1:8765');
  const token = validateToken(env.LEVERAGE_AGENT_TOKEN);
  const name = env.LEVERAGE_DEVICE || os.hostname();
  if (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid local device name.');
  const deviceId = env.LEVERAGE_AGENT_ID;
  if (typeof deviceId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(deviceId)) {
    throw new Error('Enroll this agent first and load its private credential file.');
  }
  const home = env.LEVERAGE_CODEX_HOME || env.CODEX_HOME || codexHome();
  const source = env.LEVERAGE_SESSION_SOURCE || 'app-server';
  if (!['app-server', 'files'].includes(source)) throw new Error('Invalid session inventory source.');
  const localMode = env.LEVERAGE_LOCAL_READONLY === '1' && env.LEVERAGE_ENABLE_LIVE_CODEX !== '1';
  if (localMode && !workspaceReady(env.LEVERAGE_WORKSPACE)) throw new Error('An authorized local workspace is required.');
  const controlOptions = Object.freeze({ workspace: env.LEVERAGE_WORKSPACE, home });
  let control = localMode ? controlFactory(controlOptions) : null;
  const workspaceBinding = localMode ? createHash('sha256').update(fs.realpathSync(env.LEVERAGE_WORKSPACE)).digest('hex') : null;
  let activeRun = null;
  let account = 'unavailable';
  let cachedInventory;
  let closing = false;
  let shutdown;
  let controlClose;
  let recoveryWork;
  let nextRecoveryAt = null;
  let recoveryDelay = recoveryDelayMs;
  const stopCurrentControl = () => {
    const current = control;
    return controlClose ||= Promise.resolve().then(() => current?.close());
  };
  const closeControl = () => {
    closing = true; account = 'unavailable';
    // Share one immediately handled shutdown, including synchronous failures.
    shutdown ||= stopCurrentControl().catch(() => {});
    return shutdown;
  };
  const failClosed = () => {
    if (control) void closeControl();
  };
  const recoveryState = () => {
    try { return control?.recoveryState?.() || { recoverable: false, errorCode: null }; }
    catch { return { recoverable: false, errorCode: 'recovery-state-unavailable' }; }
  };
  const unavailableInventory = () => ({ status: 'unavailable', source: 'app-server', truncated: false, sessions: [] });
  const scheduleRecovery = () => { nextRecoveryAt ??= now() + recoveryDelay; };
  async function recoverIdleControl() {
    if (recoveryWork) return recoveryWork;
    if (!control || activeRun || closing || recoveryState().recoverable !== true) return;
    scheduleRecovery();
    if (now() < nextRecoveryAt) return;
    recoveryWork = (async () => {
      try {
        await stopCurrentControl();
        if (closing || activeRun) return;
        // A fresh factory must redo its own version, initialization and policy checks.
        // It receives the original immutable workspace/home, never dashboard input.
        control = controlFactory(controlOptions);
        controlClose = undefined;
        account = 'unavailable'; cachedInventory = unavailableInventory();
        nextRecoveryAt = null;
        recoveryDelay = Math.min(30000, recoveryDelay * 2);
      } catch {
        await closeControl();
        throw new Error('Local controller recovery failed safely; restart after checking authorization.');
      }
    })();
    try { await recoveryWork; } finally { recoveryWork = undefined; }
  }

  async function request(method, endpoint, data, signal) {
    const timeout = AbortSignal.timeout(14000);
    let response;
    try { response = await fetchImpl(url + endpoint, {
      method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    }); } catch (error) { if (activeRun) failClosed(); throw error; }
    if (response.status === 401 || response.status === 403 || (!response.ok && activeRun)) failClosed();
    if (!response.ok) throw new Error('Local hub request failed (HTTP ' + response.status + ').');
    try { return await response.json(); }
    catch (error) { if (activeRun) failClosed(); throw error; }
  }

  async function executeReadonly(job, signal) {
    const runControl = control;
    const events = [];
    let stream = '';
    let streamTruncated = false;
    let lastUpdate = -Infinity;
    let updates = Promise.resolve();
    let acceptingEvents = true;
    let trailingTimer;
    let dirty = false;
    let sending = false;
    const update = body => {
      const payload = { deviceId, jobId: job.id, ...body,
        output: boundedText(body.output || '', 8000),
        events: (body.events || []).slice(-20).map(event => ({
          type: event.type, message: boundedText(event.message, 160)
        })) };
      // Preserve terminal identity/status fields. If unexpected metadata grows,
      // trim presentation fields first and fail closed rather than overflow.
      while (payload.events.length && Buffer.byteLength(JSON.stringify({ ...payload, output: '' })) >= 18000) payload.events.shift();
      const remaining = 17999 - Buffer.byteLength(JSON.stringify({ ...payload, output: '' }));
      if (remaining < 0) { failClosed(); return Promise.reject(new Error('Local update metadata exceeded its safe limit.')); }
      payload.output = boundedText(payload.output, remaining);
      payload.outputTruncated = body.outputTruncated === true || payload.output !== (body.output || '');
      if (Buffer.byteLength(JSON.stringify(payload)) >= 18000) {
        failClosed(); return Promise.reject(new Error('Local update exceeded its safe limit.'));
      }
      return request('POST', '/api/agent/local/update', payload, signal);
    };
    function scheduleUpdate() {
      if (closing || !acceptingEvents || !dirty || sending) return;
      const remaining = Math.max(0, 300 - (Date.now() - lastUpdate));
      if (remaining === 0) { flushUpdate(); return; }
      trailingTimer ||= setTimeout(() => { trailingTimer = undefined; flushUpdate(); }, remaining);
    }
    function flushUpdate() {
      if (closing || !acceptingEvents || !dirty || sending) return;
      clearTimeout(trailingTimer); trailingTimer = undefined;
      dirty = false; sending = true; lastUpdate = Date.now();
      const snapshot = { status: 'running', output: stream, outputTruncated: streamTruncated,
        events: events.map(event => ({ ...event })) };
      updates = Promise.resolve().then(() => closing ? undefined : update(snapshot)).catch(() => {}).finally(() => {
        sending = false;
        scheduleUpdate();
      });
    }
    const onEvent = event => {
      if (closing || !acceptingEvents) return;
      const type = ['progress', 'output', 'error', 'completed'].includes(event?.type) ? event.type : 'progress';
      const message = typeof event?.message === 'string' ? event.message : '';
      // Output events are complete sanitized replacement snapshots, not deltas.
      if (type === 'output') {
        stream = boundedText(message, 8000);
        streamTruncated = event.outputTruncated === true || stream !== message;
      }
      if (type !== 'output' || events.at(-1)?.type !== 'output') {
        events.push({ type, message: type === 'output' ? 'Codex response received.' : boundedText(message, 160) });
      }
      if (events.length > 20) events.shift();
      dirty = true;
      scheduleUpdate();
    };
    let result;
    try { result = await runControl.run(job, onEvent); }
    catch {
      result = { status: 'failed', output: '', errorCode: 'controller-unavailable' };
      events.push({ type: 'error', message: 'Local READ-ONLY operation failed safely.' });
      if (events.length > 20) events.shift();
    } finally {
      acceptingEvents = false; dirty = false;
      clearTimeout(trailingTimer); trailingTimer = undefined;
    }
    await updates.catch(() => {});
    const status = ['completed', 'failed', 'interrupted'].includes(result?.status) ? result.status : 'failed';
    const output = typeof result?.output === 'string'
      ? (status !== 'completed' && !result.output ? stream : boundedText(result.output, 8000)) : stream;
    await update({ status, output, outputTruncated: result?.outputTruncated === true ||
      (typeof result?.output === 'string' && output !== result.output) ||
      (status !== 'completed' && !result?.output && streamTruncated),
      ...(typeof result?.threadId === 'string' ? { threadId: result.threadId } : {}),
      ...(typeof result?.errorCode === 'string' ? { errorCode: result.errorCode } : {}), events });
  }

  async function tick({ signal } = {}) {
    if (closing) throw new Error('Local controller stopped safely; restart after checking authorization.');
    await recoverIdleControl();
    if (closing) throw new Error('Local controller stopped safely; restart after checking authorization.');
    let discovered;
    if (control) {
      if (!activeRun) {
        if (recoveryState().recoverable !== true) {
          try {
            account = (await control.accountStatus()).status;
            cachedInventory = await control.listSessions();
          } catch { account = 'unavailable'; }
        }
        const recovery = recoveryState();
        if (recovery.recoverable === true) {
          account = 'unavailable'; cachedInventory = unavailableInventory(); scheduleRecovery();
        } else if (!recovery.errorCode && cachedInventory?.status === 'available' &&
            ['authenticated', 'not-authenticated'].includes(account)) {
          nextRecoveryAt = null; recoveryDelay = recoveryDelayMs;
        }
      }
      discovered = cachedInventory || await discoverCodexSessions({ home, source: 'files' });
    } else discovered = await discoverCodexSessions({ home, source,
      ...(env.LEVERAGE_WORKSPACE && source === 'app-server' ? { workspace: env.LEVERAGE_WORKSPACE } : {}) });
    const { sessions: listed, ...sessionInventory } = discovered;
    const sessions = env.LEVERAGE_REPORT_PROJECT === '0'
      ? listed.map(({ project, ...metadata }) => metadata) : listed;
    const heartbeat = {
      deviceId, name, platform: process.platform, mcp: listMcp(home), sessions, sessionInventory,
      localControl: Boolean(control), workspaceBinding, codexAuth: account,
      sandbox: 'no-execution', workspaceReady: workspaceReady(env.LEVERAGE_WORKSPACE),
      executionMode: control ? 'local-read-only' : 'inventory-only'
    };
    // Titles are optional presentation metadata. Preserve the existing body
    // limit and the core inventory/authentication if they exhaust its budget.
    if (Buffer.byteLength(JSON.stringify(heartbeat)) >= 19000 && sessions.some(session => session.title)) {
      heartbeat.sessions = sessions.map(({ title, ...metadata }) => metadata);
    }
    await request('POST', '/api/agent/heartbeat', heartbeat, signal);
    if (control && !activeRun && !closing) {
      const next = await request('GET', '/api/agent/local/task?deviceId=' + deviceId, undefined, signal);
      if (next.job) {
        activeRun = executeReadonly(next.job, signal).catch(() => {}).finally(() => { activeRun = null; });
      }
    }
  }
  async function close() {
    await closeControl();
    await activeRun?.catch(() => {});
  }
  return { tick, deviceId, close, waitForIdle: async () => { await activeRun; } };
}

export async function runAgent({ signal, ...options } = {}) {
  const agent = createAgent(options);
  console.log('Leverage50xAgents agent started; remote execution disabled; local control requires explicit READ-ONLY authorization.');
  try { while (!signal?.aborted) {
    try { await agent.tick({ signal }); }
    catch { if (!signal?.aborted) console.error('Local hub request failed; retrying. No credentials or private data logged.'); }
    try { await delay(5000, undefined, { signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  } } finally { await agent.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try { await runAgent({ signal: controller.signal }); }
  catch { console.error('Agent startup failed. Check local credentials and workspace configuration.'); process.exitCode = 1; }
  finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}
