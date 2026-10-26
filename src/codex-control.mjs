import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import { RESUME_SOURCE_KINDS, matchesResumePickerThread, sanitizeSessionTitle } from './codex-session-metadata.mjs';

// Verified 2026-10-25 with CLI 0.163.0 and an isolated loopback-only synthetic
// Responses provider: the policy exposes only request_user_input, which this
// client denies. No filesystem, shell, MCP or browser tools were exposed.
// This proof is version-bound and cannot be changed by dashboard input or env.
export const CODEX_CONTROL_TOOL_POLICY_VERIFIED = true;

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const METHODS = new Set(['initialize', 'initialized', 'account/read', 'thread/list',
  'thread/start', 'thread/resume', 'turn/start']);
const DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'hooks',
  'multi_agent', 'shell_snapshot', 'goals', 'memories', 'workspace_dependencies', 'skill_search',
  'skill_mcp_dependency_install', 'tool_suggest', 'browser_use', 'browser_use_external',
  'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'view_image', 'image_generation',
  'code_mode', 'code_mode_host', 'stable_environment_tools', 'sleep_tool'];
const FEATURES = Object.fromEntries(DISABLED_FEATURES.map(name => [name, false]));
const POLICY = {
  features: FEATURES, mcp_servers: {}, plugins: {}, apps: { _default: { enabled: false } },
  tools: { view_image: false }, web_search: 'disabled', allow_login_shell: false,
  sandbox_mode: 'read-only', approval_policy: 'on-request', approvals_reviewer: 'user',
  analytics: { enabled: false },
};
const processLocks = new Set();

class ControlError extends Error {
  constructor(code = 'codex-unavailable') { super('Local Codex control unavailable.'); this.code = code; }
}

function scrub(text) {
  return String(text).replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b((?:api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s,;"']{8,}/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function startTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return null; }
}

function descendantOf(pid, ancestor) {
  for (let depth = 0; depth < 16 && pid > 1; depth++) {
    if (pid === ancestor) return true;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!Number.isInteger(parent) || parent === pid) return false;
      pid = parent;
    } catch { return false; }
  }
  return false;
}

/** Metadata only: do not read command lines, transcripts, environment or auth. */
function externalActivity({ workspace, threadId, childPid }) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return 'unknown';
  let entries;
  try { entries = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)); } catch { return 'unknown'; }
  if (entries.length > 4096) return 'unknown';
  for (const entry of entries) {
    const pid = Number(entry);
    if (pid === process.pid || pid === childPid) continue;
    try {
      if (fs.statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
      const executable = fs.readlinkSync(`/proc/${pid}/exe`);
      if (!/^codex(?:[-_.].*)?$/.test(path.basename(executable))) continue;
      // npm's codex launcher can be a Node parent of the native stdio server.
      if (childPid && descendantOf(pid, childPid)) continue;
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === workspace) return 'busy';
      const descriptors = fs.readdirSync(`/proc/${pid}/fd`);
      if (descriptors.length > 512) return 'unknown';
      for (const descriptor of descriptors) {
        try {
          const target = fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`);
          if (target.includes(threadId) && /\/(?:sessions|archived_sessions)\//.test(target)) return 'busy';
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) return 'unknown'; }
      }
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) return 'unknown';
    }
  }
  return 'clear';
}

function lease(workspace, key) {
  const processKey = workspace + ':' + key;
  if (processLocks.has(processKey)) throw new ControlError('codex-busy');
  const directory = path.join(workspace, '.local-run');
  const locks = path.join(directory, 'codex-control-locks');
  for (const dirname of [directory, locks]) {
    try { fs.mkdirSync(dirname, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw new ControlError(); }
    const stat = fs.lstatSync(dirname);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new ControlError();
  }
  const filename = path.join(locks, key + '.lock');
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor;
    try {
      descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, start: startTicks(process.pid), nonce }));
      fs.closeSync(descriptor); descriptor = undefined;
      processLocks.add(processKey);
      return () => {
        processLocks.delete(processKey);
        try {
          const stat = fs.lstatSync(filename);
          if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 1024 &&
              JSON.parse(fs.readFileSync(filename, 'utf8')).nonce === nonce) fs.unlinkSync(filename);
        } catch { /* A missing/replaced lease is never removed by guessing. */ }
      };
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (error.code !== 'EEXIST' || attempt) throw new ControlError('codex-busy');
      try {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 || (stat.mode & 0o077) ||
            (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new ControlError('codex-busy');
        const existing = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (!Number.isInteger(existing.pid) || existing.pid < 1) throw new ControlError('codex-busy');
        let dead = false;
        try { process.kill(existing.pid, 0); } catch (check) { if (check.code === 'ESRCH') dead = true; }
        const current = startTicks(existing.pid);
        if (!dead && !(current && existing.start && current !== existing.start)) throw new ControlError('codex-busy');
        fs.unlinkSync(filename);
      } catch { throw new ControlError('codex-busy'); }
    }
  }
  throw new ControlError('codex-busy');
}

function snapshot(workspace) {
  const names = fs.readdirSync(workspace, { withFileTypes: true }).filter(entry => entry.isFile() &&
    /^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(entry.name) && !/\.(?:env|pem|key|pfx|p12)$/i.test(entry.name))
    .map(entry => entry.name).sort().slice(0, 100);
  let readme = '';
  let descriptor;
  try {
    descriptor = fs.openSync(path.join(workspace, 'README.md'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 65536) throw new ControlError('workspace-context-unavailable');
    readme = fs.readFileSync(descriptor, 'utf8');
    if (scrub(readme) !== readme) throw new ControlError('workspace-context-sensitive');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new ControlError('workspace-context-unavailable');
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  return 'Authorized project context (snapshot; no filesystem tools):\nTop-level files: ' + names.join(', ') +
    '\nREADME.md:\n' + (readme || '(not present)');
}

function toml(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return '{' + Object.entries(value).map(([key, item]) => JSON.stringify(key) + '=' + toml(item)).join(',') + '}';
  }
  return JSON.stringify(value);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(kill); clearTimeout(deadline); resolve(); };
    const kill = setTimeout(() => child.kill('SIGKILL'), 300);
    const deadline = setTimeout(finish, 1500);
    child.once('close', finish); child.stdin?.end(); child.kill('SIGTERM');
  });
}

/** Local-only, one explicitly configured workspace, never a remote executor. */
export function createCodexControl({ workspace, home, command = 'codex', spawnImpl = spawn,
  rpcTimeoutMs = 10000, turnTimeoutMs = 120000, externalActivityCheck = externalActivity, now = () => performance.now() } = {}) {
  let canonical;
  let identity;
  try {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error();
    canonical = fs.realpathSync(workspace); identity = fs.statSync(canonical);
    if (!identity.isDirectory()) throw new Error();
  } catch { throw new Error('Invalid local Codex workspace.'); }
  if ((command !== 'codex' && !(path.isAbsolute(command) && path.basename(command) === 'codex' && !/^\/mnt\/[a-z]\//i.test(command))) ||
      (home !== undefined && (typeof home !== 'string' || !path.isAbsolute(home))) ||
      !Number.isInteger(rpcTimeoutMs) || rpcTimeoutMs < 50 || rpcTimeoutMs > 30000 ||
      !Number.isInteger(turnTimeoutMs) || turnTimeoutMs < 50 || turnTimeoutMs > 300000 ||
      typeof now !== 'function') throw new Error('Invalid local Codex configuration.');
  const env = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
  env.CODEX_HOME = home || process.env.LEVERAGE_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  let child;
  let startup;
  let closed = false;
  let broken;
  let sequence = 0;
  let active;
  let buffer = '';
  let received = 0;
  let lastTrafficTime;
  const trafficBuckets = [];
  let killDeadline;
  const decoder = new StringDecoder('utf8');
  const pending = new Map();
  const loaded = new Set();
  const assertWorkspace = () => {
    try {
      const current = fs.statSync(canonical);
      if (fs.realpathSync(workspace) !== canonical || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error();
    } catch { throw new ControlError('workspace-changed'); }
  };
  const emit = (type, message) => { try { active?.onEvent?.({ type, message: scrub(message).slice(0, 8000) }); } catch { /* UI callbacks cannot grant permissions. */ } };
  const fail = (code = 'codex-unavailable') => {
    broken ||= new ControlError(code);
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(broken); }
    pending.clear();
    active?.finish?.({ status: closed ? 'interrupted' : 'failed', errorCode: broken.code });
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      killDeadline ||= setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 300);
    }
  };
  const accountTraffic = bytes => {
    let time;
    try { time = now(); } catch { fail('codex-clock-error'); return false; }
    if (!Number.isFinite(time) || (lastTrafficTime !== undefined && time < lastTrafficTime)) {
      fail('codex-clock-error'); return false;
    }
    lastTrafficTime = time;
    // Keep at most 61 one-second buckets. Expire a bucket only after its END
    // leaves the rolling minute, conservatively enforcing the 32 MiB limit.
    while (trafficBuckets.length && (trafficBuckets[0].second + 1) * 1000 <= time - 60000) {
      received -= trafficBuckets.shift().bytes;
    }
    const second = Math.floor(time / 1000);
    if (trafficBuckets.at(-1)?.second === second) trafficBuckets.at(-1).bytes += bytes;
    else trafficBuckets.push({ second, bytes });
    received += bytes;
    if (received > 33554432) { fail('codex-output-limit'); return false; }
    return true;
  };
  const write = message => {
    if (message.method && !METHODS.has(message.method)) throw new ControlError('method-blocked');
    if (closed || broken || !child) throw broken || new ControlError();
    child.stdin.write(JSON.stringify(message) + '\n');
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => fail('codex-timeout'), rpcTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { write({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  const finishNotification = params => {
    if (!active || params.threadId !== active.threadId || !params.turn || typeof params.turn.id !== 'string') return;
    const result = { status: ['completed', 'failed', 'interrupted'].includes(params.turn.status) ? params.turn.status : 'failed', turnId: params.turn.id };
    if (active.turnId && active.turnId === result.turnId) active.finish(result);
    else if (!active.turnId) active.earlyCompletion = result;
  };
  const notification = message => {
    const params = message.params;
    if (!params || typeof params !== 'object') return;
    if (message.method === 'turn/completed') return finishNotification(params);
    if (!active || params.threadId !== active.threadId) return;
    if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string' && typeof params.turnId === 'string') {
      if (active.chunks.size >= 4 && !active.chunks.has(params.turnId)) return fail('unexpected-turn');
      const prior = active.chunks.get(params.turnId) || '';
      active.chunks.set(params.turnId, (prior + params.delta).slice(0, 32000));
    } else if (message.method === 'item/started' && params.item &&
        !['userMessage', 'agentMessage', 'reasoning', 'contextCompaction'].includes(params.item.type)) {
      fail('tool-use-blocked');
    }
  };
  const spawnChild = args => {
    try { return spawnImpl(command, args, { cwd: canonical, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false }); }
    catch { throw new ControlError(); }
  };
  const version = async () => {
    const probe = spawnChild(['--version']); let output = ''; let bytes = 0; let timer;
    try {
      await new Promise((resolve, reject) => {
        const bad = () => reject(new ControlError());
        timer = setTimeout(bad, rpcTimeoutMs); probe.once('error', bad); probe.stdin.on('error', bad);
        probe.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) bad(); else output += chunk.toString(); });
        probe.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) bad(); });
        probe.once('close', code => code === 0 ? resolve() : bad());
      });
      if (output.trim() !== 'codex-cli 0.163.0') throw new ControlError('codex-version-unsupported');
    } finally { clearTimeout(timer); output = ''; await stop(probe); }
  };
  const ensure = () => startup ||= (async () => {
    if (closed) throw new ControlError(); assertWorkspace(); await version();
    if (closed) throw new ControlError();
    const overrides = Object.entries(POLICY).flatMap(([key, value]) => ['-c', key + '=' + toml(value)]);
    child = spawnChild(['app-server', '--listen', 'stdio://', ...overrides]);
    child.once('error', () => fail()); child.once('close', () => { clearTimeout(killDeadline); fail(); }); child.stdin.on('error', () => fail());
    child.stderr.on('data', chunk => { if (!broken && !closed) accountTraffic(chunk.length); });
    child.stdout.on('data', chunk => {
      if (broken || closed) return;
      if (!accountTraffic(chunk.length)) return;
      buffer += decoder.write(chunk); if (Buffer.byteLength(buffer) > 2097152) return fail('codex-output-limit');
      let newline;
      while (!broken && (newline = buffer.indexOf('\n')) >= 0) {
        let message;
        try { message = JSON.parse(buffer.slice(0, newline)); } catch { return fail('codex-protocol-error'); }
        buffer = buffer.slice(newline + 1);
        if (!message || typeof message !== 'object' || Array.isArray(message)) return fail('codex-protocol-error');
        if (typeof message.method === 'string') {
          if (Object.hasOwn(message, 'id')) {
            if ((typeof message.id === 'number' && Number.isSafeInteger(message.id)) ||
                (typeof message.id === 'string' && message.id.length <= 128)) {
              try { write({ id: message.id, error: { code: -32000, message: 'Local control denies tool and permission requests.' } }); } catch { /* Fail closed below. */ }
            }
            return fail('approval-denied');
          }
          notification(message); continue;
        }
        const waiter = pending.get(message.id);
        if (!waiter) return fail('codex-protocol-error');
        pending.delete(message.id); clearTimeout(waiter.timer);
        if (message.error || !Object.hasOwn(message, 'result')) waiter.reject(new ControlError('codex-request-rejected'));
        else waiter.resolve(message.result);
        message = null;
      }
    });
    await request('initialize', { clientInfo: { name: 'leverage50xagents_local_control', version: '0.3.0' }, capabilities: { experimentalApi: false } });
    write({ method: 'initialized' });
  })().catch(error => {
    fail(error instanceof ControlError ? error.code : 'codex-unavailable');
    throw broken;
  });
  const accountStatus = async () => {
    try {
      await ensure();
      let result = await request('account/read', { refreshToken: false });
      const authenticated = ['chatgpt', 'apiKey'].includes(result?.account?.type);
      const status = authenticated ? 'authenticated' : (result?.account == null ? 'not-authenticated' : 'unavailable');
      result = null;
      return { status };
    } catch (error) {
      fail(error instanceof ControlError ? error.code : 'codex-unavailable');
      return { status: 'unavailable' };
    }
  };
  const listSessions = async () => {
    try {
      await ensure(); assertWorkspace();
      const found = new Map();
      const cursors = new Set();
      let cursor;
      let truncated = false;
      for (let page = 0; page < 8; page++) {
        let result = await request('thread/list', { cwd: canonical, useStateDbOnly: true, limit: 40 - found.size,
          archived: false, sourceKinds: RESUME_SOURCE_KINDS, sortKey: 'updated_at', sortDirection: 'desc',
          ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result?.data) || result.data.length > 100 ||
            (result.nextCursor != null && (typeof result.nextCursor !== 'string' || result.nextCursor.length > 4096))) {
          throw new ControlError('codex-protocol-error');
        }
        for (const thread of result.data) {
          if (!matchesResumePickerThread(thread, canonical) || typeof thread.id !== 'string' || !UUID.test(thread.id) ||
              !Number.isSafeInteger(thread.updatedAt)) continue;
          const timestamp = new Date(thread.updatedAt * 1000); if (!Number.isFinite(timestamp.getTime())) continue;
          const id = thread.id.toLowerCase();
          const modified = timestamp.toISOString();
          if (found.has(id) && found.get(id).modified >= modified) continue;
          const busy = active?.threadId === id || thread.status?.type === 'active' || processLocks.has(canonical + ':' + id);
          const title = sanitizeSessionTitle(thread.name);
          found.set(id, { id, modified, lastActivity: modified, ...(title ? { title } : {}),
            project: path.basename(canonical), source: 'app-server', activity: active?.threadId === id ? 'confirmed' : 'discovered',
            eligibility: busy ? 'busy' : (loaded.has(id) ? 'confirmed' : 'discovered') });
        }
        cursor = result.nextCursor;
        result = null;
        if (found.size > 40) truncated = true;
        if (!cursor) break;
        if (found.size >= 40 || cursors.has(cursor) || page === 7) { truncated = true; break; }
        cursors.add(cursor);
      }
      const sessions = [...found.values()].sort((a, b) => b.modified.localeCompare(a.modified) || a.id.localeCompare(b.id)).slice(0, 40);
      return { status: 'available', source: 'app-server', truncated, sessions };
    } catch (error) {
      fail(error instanceof ControlError ? error.code : 'codex-unavailable');
      return { status: 'unavailable', source: 'app-server', truncated: false, sessions: [] };
    }
  };
  const run = async (input, onEvent) => {
    if (!input || !['new', 'resume'].includes(input.mode) || input.workspaceId !== 'project' || input.confirmed !== true ||
        typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 2000 ||
        (input.mode === 'resume' ? !UUID.test(input.threadId) : input.threadId != null)) {
      return { status: 'failed', output: '', errorCode: 'invalid-local-request' };
    }
    if (!CODEX_CONTROL_TOOL_POLICY_VERIFIED) return { status: 'failed', output: '', errorCode: 'tool-policy-unverified' };
    if (active || closed) return { status: 'failed', output: '', errorCode: active ? 'codex-busy' : 'codex-unavailable' };
    const releases = [];
    let timer;
    let state;
    try {
      assertWorkspace(); releases.push(lease(canonical, 'workspace'));
      const context = snapshot(canonical);
      state = { onEvent, chunks: new Map(), threadId: null, turnId: null };
      active = state; emit('progress', 'Preparing a local read-only Codex session.');
      if ((await accountStatus()).status !== 'authenticated') throw new ControlError('codex-not-authenticated');
      if (input.mode === 'resume') {
        const inventory = await listSessions();
        const selected = inventory.sessions.find(session => session.id === input.threadId);
        if (!selected) throw new ControlError('session-unavailable');
        if (selected.eligibility === 'busy') throw new ControlError('codex-busy');
        releases.push(lease(canonical, input.threadId));
        const other = await externalActivityCheck({ workspace: canonical, threadId: input.threadId, childPid: child?.pid });
        if (other !== 'clear') throw new ControlError(other === 'busy' ? 'codex-busy' : 'session-activity-unverified');
      }
      assertWorkspace();
      let started = await request(input.mode === 'new' ? 'thread/start' : 'thread/resume', {
        cwd: canonical, sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user', config: POLICY,
        ...(input.mode === 'resume' ? { threadId: input.threadId, excludeTurns: true } : {}),
      });
      const thread = started?.thread;
      if (started?.sandbox?.type !== 'readOnly' || started.sandbox.networkAccess !== false || started.approvalPolicy !== 'on-request' ||
          started.approvalsReviewer !== 'user' || started.cwd !== canonical || !thread || !UUID.test(thread.id) ||
          thread.cwd !== canonical || (input.mode === 'resume' && thread.id !== input.threadId)) throw new ControlError('codex-policy-mismatch');
      if (thread.status?.type === 'active') throw new ControlError('codex-busy');
      state.threadId = thread.id;
      if (input.mode === 'new') releases.push(lease(canonical, state.threadId));
      loaded.add(state.threadId); started = null;
      const completion = new Promise(resolve => { state.finish = resolve; });
      timer = setTimeout(() => fail('codex-timeout'), turnTimeoutMs);
      emit('progress', 'Codex is generating a response with read-only restrictions.');
      const turn = await request('turn/start', { threadId: state.threadId, cwd: canonical,
        approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false },
        input: [{ type: 'text', text: input.prompt + '\n\n' + context }] });
      if (typeof turn?.turn?.id !== 'string' || turn.turn.id.length > 128) throw new ControlError('codex-protocol-error');
      state.turnId = turn.turn.id;
      if (state.earlyCompletion?.turnId === state.turnId) state.finish(state.earlyCompletion);
      else if (['completed', 'failed', 'interrupted'].includes(turn.turn.status)) state.finish({ status: turn.turn.status });
      const result = await completion;
      const output = scrub(state.chunks.get(state.turnId) || '').slice(0, 8000);
      const status = ['completed', 'interrupted'].includes(result.status) ? result.status : 'failed';
      if (output) emit('output', output);
      emit(status === 'completed' ? 'completed' : 'error', status === 'completed' ? 'Local read-only Codex turn completed.' : 'Local Codex turn stopped.');
      return { status, output, threadId: state.threadId, ...(result.errorCode ? { errorCode: result.errorCode } : {}) };
    } catch (error) {
      if (error instanceof ControlError && ['codex-policy-mismatch', 'codex-protocol-error',
        'method-blocked', 'workspace-changed'].includes(error.code)) fail(error.code);
      emit('error', 'Local Codex request could not be completed safely.');
      return { status: closed ? 'interrupted' : 'failed', output: '', ...(state?.threadId ? { threadId: state.threadId } : {}),
        errorCode: error instanceof ControlError ? error.code : 'codex-unavailable' };
    } finally {
      clearTimeout(timer); if (active === state) active = null;
      for (const release of releases.reverse()) release();
    }
  };
  const recoveryState = () => ({
    recoverable: !closed && !active && ['codex-unavailable', 'codex-timeout'].includes(broken?.code),
    errorCode: closed ? 'codex-closed' : broken?.code || null,
  });
  return { accountStatus, listSessions, run, recoveryState, async close() {
    closed = true; fail('codex-closed'); buffer = ''; loaded.clear(); await stop(child); clearTimeout(killDeadline);
  } };
}
