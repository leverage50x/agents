import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { codexHome, listSessionInventory } from './inventory.mjs';
import { RESUME_SOURCE_KINDS, matchesResumePickerThread, sanitizeSessionTitle } from './codex-session-metadata.mjs';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const RPC_METHODS = new Set(['initialize', 'initialized', 'thread/list']);
// The DB-only parameter is a privacy requirement, not an optional optimization.
// Older servers may ignore unknown parameters. Only this schema-verified build
// is enabled until another version has been checked against its generated schema.
const VERIFIED_VERSION = '0.163.0';

class InventoryError extends Error {
  constructor(reason = 'app-server-unavailable') {
    super('Codex metadata inventory unavailable.');
    this.reason = reason;
  }
}

function optionsFor({ home = codexHome(), workspace, limit = 40, command = 'codex',
  timeoutMs = 5000, maxOutputBytes = 2097152, spawnImpl = spawn } = {}) {
  if (!Number.isInteger(limit) || limit < 0 || limit > 40 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000 ||
      !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 8388608 ||
      typeof home !== 'string' || !path.isAbsolute(home)) {
    throw new RangeError('Invalid Codex inventory options.');
  }
  // Do not invoke a shell, scripts, command strings, or Windows executables.
  if (command !== 'codex' && !(path.isAbsolute(command) && path.basename(command) === 'codex' &&
      !/^\/mnt\/[a-z]\//i.test(command))) throw new RangeError('Invalid Codex executable.');
  if (workspace !== undefined) {
    try {
      if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error();
      workspace = fs.realpathSync(workspace);
      if (!fs.statSync(workspace).isDirectory()) throw new Error();
    } catch { throw new RangeError('Invalid Codex inventory workspace.'); }
  }
  const env = { CODEX_HOME: home };
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { home, workspace, limit, command, timeoutMs, maxOutputBytes, spawnImpl, env };
}

function childProcess(options, args) {
  try {
    return options.spawnImpl(options.command, args, {
      cwd: options.home, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
  } catch { throw new InventoryError(); }
}

/** Always close/reap the short-lived child, including errors and timeouts. */
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(hardKill);
      clearTimeout(deadline);
      child.removeListener('close', finish);
      resolve();
    };
    const hardKill = setTimeout(() => child.kill('SIGKILL'), 250);
    const deadline = setTimeout(finish, 1000);
    child.once('close', finish);
    child.stdin?.end();
    child.kill('SIGTERM');
  });
}

async function checkVersion(options) {
  const child = childProcess(options, ['--version']);
  let output = '';
  let size = 0;
  let timer;
  try {
    await new Promise((resolve, reject) => {
      const fail = () => reject(new InventoryError());
      timer = setTimeout(fail, options.timeoutMs);
      child.once('error', fail);
      child.stdout.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > 4096) return fail();
        output += chunk.toString();
      });
      // Consume diagnostics without storing or printing them.
      child.stderr.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > 4096) fail();
      });
      child.once('close', code => code === 0 ? resolve() : fail());
    });
    if (output.trim() !== `codex-cli ${VERIFIED_VERSION}`) {
      throw new InventoryError('app-server-incompatible');
    }
  } finally {
    clearTimeout(timer);
    output = '';
    await stopChild(child);
  }
}

function projectName(cwd) {
  if (typeof cwd !== 'string' || cwd.length > 4096 || !path.isAbsolute(cwd)) return;
  const name = path.basename(cwd);
  if (/^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(name)) return name;
}

function sessionMetadata(thread, workspace) {
  if (!matchesResumePickerThread(thread, workspace)) return;
  if (!thread || typeof thread !== 'object' || !UUID.test(thread.id) ||
      !Number.isSafeInteger(thread.updatedAt) || thread.updatedAt < 0) return;
  const timestamp = new Date(thread.updatedAt * 1000);
  if (!Number.isFinite(timestamp.getTime())) return;
  const modified = timestamp.toISOString();
  const project = projectName(thread.cwd);
  // A fresh App Server cannot establish whether another Codex process is live.
  // Keep only an explicitly named, sanitized title; never use a preview.
  const title = sanitizeSessionTitle(thread.name);
  return { id: thread.id.toLowerCase(), modified, lastActivity: modified,
    ...(project ? { project } : {}), ...(title ? { title } : {}), activity: 'discovered', source: 'app-server' };
}

/**
 * Read-only, DB-only metadata via stdio. No thread is resumed or started.
 * The protocol includes preview/name fields: they can briefly enter child/JSON
 * parsing memory; previews are discarded, and optional names are sanitized.
 */
export async function listAppServerSessions(input = {}) {
  const options = optionsFor(input);
  if (options.limit === 0) return { status: 'available', truncated: false, sessions: [], source: 'app-server' };
  await checkVersion(options);
  const child = childProcess(options, ['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false']);
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  let bytes = 0;
  let stopped = false;
  let failure;
  let timer;
  const fail = () => {
    failure ||= new InventoryError();
    for (const { reject } of pending.values()) reject(failure);
    pending.clear();
  };
  const write = message => {
    if (message.method && !RPC_METHODS.has(message.method)) throw new InventoryError();
    if (failure) throw failure;
    child.stdin.write(JSON.stringify(message) + '\n');
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    try { write({ id, method, params }); }
    catch { pending.delete(id); reject(new InventoryError()); }
  });
  child.once('error', fail);
  child.stdin.on('error', fail);
  child.once('close', () => { if (!stopped) fail(); });
  child.stderr.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > options.maxOutputBytes) fail();
  });
  child.stdout.on('data', chunk => {
    if (failure) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > options.maxOutputBytes) return fail();
    buffer += chunk.toString();
    let newline;
    while (!failure && (newline = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(); break; }
      line = '';
      if (!message || typeof message !== 'object' || Array.isArray(message)) { fail(); break; }
      if (typeof message.method === 'string') {
        // Never service tool/approval requests, including unsolicited requests.
        if (Object.hasOwn(message, 'id')) fail();
        continue;
      }
      const waiting = pending.get(message.id);
      if (!waiting) { fail(); break; }
      pending.delete(message.id);
      if (message.error || !Object.hasOwn(message, 'result')) waiting.reject(new InventoryError());
      else waiting.resolve(message.result);
      message = null;
    }
  });
  timer = setTimeout(fail, options.timeoutMs);
  try {
    await request('initialize', { clientInfo: { name: 'leverage50xagents_inventory', version: '0.2.0' },
      capabilities: { experimentalApi: false } });
    write({ method: 'initialized' });
    const found = new Map();
    let cursor;
    let truncated = false;
    let partial = false;
    const cursors = new Set();
    for (let page = 0; page < 8; page++) {
      let result = await request('thread/list', { useStateDbOnly: true, limit: options.limit - found.size,
        sortKey: 'updated_at', sortDirection: 'desc', archived: false, sourceKinds: RESUME_SOURCE_KINDS,
        ...(options.workspace ? { cwd: options.workspace } : {}),
        ...(cursor ? { cursor } : {}) });
      if (!result || !Array.isArray(result.data) || result.data.length > 100 ||
          (result.nextCursor != null && (typeof result.nextCursor !== 'string' || result.nextCursor.length > 4096))) {
        throw new InventoryError();
      }
      for (const thread of result.data) {
        if (!matchesResumePickerThread(thread, options.workspace)) continue;
        const metadata = sessionMetadata(thread, options.workspace);
        if (!metadata) { partial = true; continue; }
        if (found.size < options.limit || found.has(metadata.id)) found.set(metadata.id, metadata);
        else truncated = true;
      }
      cursor = result.nextCursor;
      result = null;
      if (!cursor) break;
      if (found.size >= options.limit || cursors.has(cursor) || page === 7) { truncated = true; break; }
      cursors.add(cursor);
    }
    const sessions = [...found.values()].sort((a, b) => b.modified.localeCompare(a.modified) || a.id.localeCompare(b.id));
    return { status: partial ? 'partial' : 'available', truncated, sessions, source: 'app-server' };
  } catch { throw failure || new InventoryError(); }
  finally {
    stopped = true;
    clearTimeout(timer);
    buffer = '';
    pending.clear();
    await stopChild(child);
  }
}

/** Filename fallback never opens a session transcript. App Server is opt-in. */
export async function discoverCodexSessions({ source = 'files', ...input } = {}) {
  if (!['files', 'app-server'].includes(source)) throw new RangeError('Invalid Codex session source.');
  const options = optionsFor(input);
  let reason;
  if (source === 'app-server') {
    try { return await listAppServerSessions(input); }
    catch (error) { reason = error instanceof InventoryError ? error.reason : 'app-server-unavailable'; }
    // A filename cannot establish Cwd, source kind or archive status. When the
    // operator selected a workspace, keep that filtered view unavailable.
    if (options.workspace) return { status: 'unavailable', sessions: [], truncated: false, source: 'app-server', reason };
  }
  const result = listSessionInventory(options.home, options.limit);
  return { ...result, sessions: result.sessions.map(session => ({ ...session,
    activity: 'discovered', source: 'files' })), source: 'files', ...(reason ? { reason } : {}) };
}
