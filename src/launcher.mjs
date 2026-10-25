import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createCredentialStore, preparePrivateDirectory, resolveLocalSecretPath } from './credentials.mjs';
import { localHubUrl, loopbackHost, validateToken } from './local-config.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENTS = new Set(['start-requested', 'hub-started', 'hub-ready', 'agent-started', 'agent-ready',
  'start-completed', 'already-running', 'start-rollback', 'start-failed', 'agent-stopped',
  'hub-stopped', 'stop-completed', 'stale-record-ignored']);
const HUB_KEYS = new Set(['LEVERAGE_OPERATOR_TOKEN', 'LEVERAGE_TOKEN', 'LEVERAGE_CREDENTIAL_STORE',
  'LEVERAGE_HOST', 'LEVERAGE_PORT', 'LEVERAGE_URL', 'LEVERAGE_ENABLE_LIVE_CODEX']);
const AGENT_KEYS = new Set(['LEVERAGE_AGENT_ID', 'LEVERAGE_AGENT_TOKEN', 'LEVERAGE_DEVICE', 'LEVERAGE_URL',
  'LEVERAGE_WORKSPACE', 'LEVERAGE_CODEX_HOME', 'CODEX_HOME', 'LEVERAGE_SESSION_SOURCE',
  'LEVERAGE_REPORT_PROJECT', 'LEVERAGE_ENABLE_LIVE_CODEX']);

class LauncherError extends Error {}

function safeError(message) { return new LauncherError(message); }

function privateRead(file, maxBytes = 1048576) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 ||
        (stat.mode & 0o177) !== 0 || stat.size > maxBytes) throw safeError('Unsafe private file.');
    const text = fs.readFileSync(fd, 'utf8');
    if (Buffer.byteLength(text) > maxBytes) throw safeError('Private file is too large.');
    return text;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function privateJSON(file) {
  return JSON.parse(privateRead(file));
}

function atomicJSON(file, value) {
  const temporary = file + '.' + process.pid + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try { privateRead(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function procIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const directory = '/proc/' + pid;
    const stat = fs.readFileSync(directory + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    return { pid, startTime: fields[19], uid: fs.statSync(directory).uid,
      executable: fs.readlinkSync(directory + '/exe'), cwd: fs.readlinkSync(directory + '/cwd'),
      command: fs.readFileSync(directory + '/cmdline').toString('utf8').split('\0').filter(Boolean) };
  } catch { return null; }
}

function ownerAlive(owner) {
  const current = procIdentity(owner?.pid);
  return Boolean(current && current.uid === owner.uid && current.startTime === owner.startTime);
}

function safeParent(file, root) {
  resolveLocalSecretPath(file, { cwd: root });
  const local = path.join(root, '.local-run');
  let directory = path.dirname(file);
  while (directory.startsWith(local)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
      throw safeError('Secret directories must be owned and private (mode 700).');
    }
    if (directory === local) break;
    directory = path.dirname(directory);
  }
}

function readEnvironment(file, root, allowed) {
  let parsed;
  try {
    safeParent(file, root);
    parsed = parseEnv(privateRead(file, 65536));
  } catch (error) {
    if (error.code === 'ENOENT') throw safeError('Existing private Hub/agent credential files are required; no credentials were generated.');
    throw error;
  }
  if (Object.keys(parsed).some(key => !allowed.has(key))) throw safeError('Credential files contain unsupported settings.');
  return parsed;
}

function baseEnvironment(env) {
  const selected = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (env[key]) selected[key] = env[key];
  }
  return selected;
}

function configuration(root, env) {
  const hubFile = resolveLocalSecretPath('.local-run/hub.env', { cwd: root });
  const hub = readEnvironment(hubFile, root, HUB_KEYS);
  let agentFile;
  if (env.LEVERAGE_AGENT_ENV) agentFile = resolveLocalSecretPath(env.LEVERAGE_AGENT_ENV, { cwd: root });
  else {
    for (const name of ['laptop1.env', 'agent.env', 'laptop-1.env']) {
      const candidate = resolveLocalSecretPath('.local-run/' + name, { cwd: root });
      try { fs.lstatSync(candidate); agentFile = candidate; break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  if (!agentFile) throw safeError('Existing local agent credentials are required; no credentials were generated.');
  const agent = readEnvironment(agentFile, root, AGENT_KEYS);
  const operator = validateToken(hub.LEVERAGE_OPERATOR_TOKEN || hub.LEVERAGE_TOKEN);
  const agentToken = validateToken(agent.LEVERAGE_AGENT_TOKEN);
  if (!UUID.test(agent.LEVERAGE_AGENT_ID || '') || agentToken === operator) throw safeError('Local credential identities must be distinct and valid.');
  const host = loopbackHost(hub.LEVERAGE_HOST || '127.0.0.1');
  const port = Number(hub.LEVERAGE_PORT || 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw safeError('Invalid local Hub port.');
  const origin = localHubUrl('http://' + (host === '::1' ? '[::1]' : host) + ':' + port);
  if ((hub.LEVERAGE_URL && localHubUrl(hub.LEVERAGE_URL) !== origin) ||
      (agent.LEVERAGE_URL && localHubUrl(agent.LEVERAGE_URL) !== origin)) throw safeError('Local agent and Hub origins must match.');
  if (hub.LEVERAGE_ENABLE_LIVE_CODEX === '1' || agent.LEVERAGE_ENABLE_LIVE_CODEX === '1') {
    throw safeError('Real instruction execution remains disabled.');
  }
  const registry = resolveLocalSecretPath(hub.LEVERAGE_CREDENTIAL_STORE || '.local-run/agents.json', { cwd: root });
  safeParent(registry, root);
  privateRead(registry);
  const store = createCredentialStore({ file: registry });
  if (store.hasToken(operator) || store.authenticate(agentToken)?.id !== agent.LEVERAGE_AGENT_ID) {
    throw safeError('Local agent credentials are missing, revoked or inconsistent with the Hub registry.');
  }
  const base = baseEnvironment(env);
  return { host, port, origin, operator, deviceId: agent.LEVERAGE_AGENT_ID,
    hubEnv: { ...base, ...hub, LEVERAGE_HOST: host, LEVERAGE_PORT: String(port), LEVERAGE_CREDENTIAL_STORE: registry,
      LEVERAGE_LOCAL_DEVICE_ID: agent.LEVERAGE_AGENT_ID, LEVERAGE_LOCAL_WORKSPACE: root, LEVERAGE_ENABLE_LIVE_CODEX: '0' },
    agentEnv: { ...base, ...agent, LEVERAGE_URL: origin, LEVERAGE_WORKSPACE: root,
      LEVERAGE_LOCAL_READONLY: '1', LEVERAGE_ENABLE_LIVE_CODEX: '0' } };
}

async function portOpen(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', error => error.code === 'ECONNREFUSED' ? finish(false) : reject(safeError('Unable to inspect the loopback port; check sandbox permissions.')));
    socket.setTimeout(1000, () => { socket.destroy(); reject(safeError('The loopback port check timed out.')); });
  });
}

async function stateRequest(config) {
  let response;
  try {
    response = await fetch(config.origin + '/api/state', { headers: { Authorization: 'Bearer ' + config.operator },
      signal: AbortSignal.timeout(1500), redirect: 'error' });
  } catch { return null; }
  if (response.status === 401 || response.status === 403) throw safeError('The running Hub rejected the existing operator credentials.');
  if (!response.ok) return null;
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 1048576) throw safeError('Hub readiness response exceeded the safe limit.');
    chunks.push(chunk);
  }
  try {
    const state = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return Array.isArray(state.devices) ? state : null;
  } catch { return null; }
}

export function createLauncher({ root = DEFAULT_ROOT, env = process.env, log = console.log,
  startTimeoutMs = 20000, stopTimeoutMs = 5000 } = {}) {
  if (process.platform !== 'linux') throw safeError('The launcher currently requires Linux or WSL.');
  root = fs.realpathSync(root);
  const directory = path.join(root, '.local-run', 'launcher');
  const stateFile = path.join(directory, 'state.json');
  const lockFile = path.join(directory, 'lock.json');
  const logFile = path.join(directory, 'operations.jsonl');
  const entry = role => path.join(root, 'src', role + '.mjs');

  function owned(record, role) {
    if (!record || record.entry !== entry(role) || record.cwd !== root || record.uid !== process.getuid()) return false;
    const current = procIdentity(record.pid);
    return Boolean(current && current.startTime === record.startTime && current.uid === record.uid &&
      current.cwd === root && current.executable === record.executable &&
      current.command.length === 2 && current.command[0] === record.executable && current.command[1] === entry(role));
  }

  function readState() {
    try {
      safeParent(stateFile, root);
      const state = privateJSON(stateFile);
      if (state.version !== 1 || !Number.isInteger(state.port) || !['127.0.0.1', '::1'].includes(state.host) ||
          !UUID.test(state.deviceId || '')) throw safeError('Invalid launcher state.');
      for (const role of ['hub', 'agent']) {
        const record = state[role];
        if (record !== null && (!record || !Number.isSafeInteger(record.pid) || record.pid < 1 ||
            !/^\d+$/.test(record.startTime) || record.uid !== process.getuid() || record.cwd !== root ||
            record.entry !== entry(role) || typeof record.executable !== 'string' || path.basename(record.executable) !== 'node')) {
          throw safeError('Invalid launcher process identity.');
        }
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw safeError('Launcher state is unsafe or corrupt; no process was signalled.');
    }
  }

  function event(name, role, pid) {
    if (!EVENTS.has(name)) return;
    const row = { at: new Date().toISOString(), event: name, ...(role ? { role } : {}), ...(pid ? { pid } : {}) };
    let previous = '';
    try { previous = privateRead(logFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const selected = previous.split('\n').filter(Boolean).slice(-499).join('\n');
    const fd = fs.openSync(logFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, (selected ? selected + '\n' : '') + JSON.stringify(row) + '\n'); }
    finally { fs.closeSync(fd); }
  }

  function lock() {
    preparePrivateDirectory(path.join(root, '.local-run'));
    preparePrivateDirectory(directory);
    const self = procIdentity(process.pid);
    if (!self) throw safeError('Cannot verify launcher ownership through /proc.');
    const identity = { pid: self.pid, startTime: self.startTime, uid: self.uid };
    for (let attempt = 0; attempt < 3; attempt++) {
      let fd;
      try {
        fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, JSON.stringify(identity));
        fs.closeSync(fd);
        return () => {
          const current = privateJSON(lockFile);
          if (current.pid === identity.pid && current.startTime === identity.startTime && current.uid === identity.uid) fs.unlinkSync(lockFile);
        };
      } catch (error) {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* Already closed. */ }
        if (error.code !== 'EEXIST') throw safeError('Cannot acquire the private launcher lock.');
        const stat = fs.lstatSync(lockFile);
        const current = privateJSON(lockFile);
        if (!Number.isSafeInteger(current.pid) || current.uid !== process.getuid() || !/^\d+$/.test(current.startTime)) {
          throw safeError('Unsafe launcher lock; no processes were changed.');
        }
        if (ownerAlive(current)) throw safeError('Another launcher operation is already running.');
        if (fs.lstatSync(lockFile).ino === stat.ino) fs.unlinkSync(lockFile);
      }
    }
    throw safeError('Could not acquire the launcher lock; retry after checking status.');
  }

  async function spawnOwned(role, childEnv) {
    const executable = fs.realpathSync(process.execPath);
    const child = spawn(executable, [entry(role)], { cwd: root, env: childEnv, detached: true, stdio: 'ignore', shell: false });
    await once(child, 'spawn');
    child.unref();
    const current = procIdentity(child.pid);
    const record = current && { pid: current.pid, startTime: current.startTime, uid: current.uid,
      executable, cwd: root, entry: entry(role) };
    if (!owned(record, role)) throw safeError('Could not verify ownership of the new ' + role + ' process.');
    return record;
  }

  async function stopOwned(record, role) {
    if (!owned(record, role)) { if (record) event('stale-record-ignored', role); return; }
    process.kill(record.pid, 'SIGTERM');
    const deadline = Date.now() + stopTimeoutMs;
    while (owned(record, role) && Date.now() < deadline) await delay(50);
    if (owned(record, role)) {
      process.kill(record.pid, 'SIGKILL');
      const hardDeadline = Date.now() + 1000;
      while (owned(record, role) && Date.now() < hardDeadline) await delay(25);
    }
    if (owned(record, role)) throw safeError('An owned process did not stop; its identity remains recorded.');
    event(role + '-stopped', role, record.pid);
  }

  async function waitFor(config, state, requireAgent) {
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      if (!owned(state.hub, 'hub')) throw safeError('The owned Hub exited before readiness; see operational logs.');
      if (requireAgent && !owned(state.agent, 'agent')) throw safeError('The owned agent exited before its heartbeat; see operational logs.');
      const response = await stateRequest(config);
      if (response && (!requireAgent || response.devices.some(d => d.id === config.deviceId && d.online === true))) return response;
      await delay(150);
    }
    throw safeError(requireAgent ? 'Timed out waiting for the local agent heartbeat.' : 'Timed out waiting for authenticated Hub readiness.');
  }

  return {
    async start() {
      const release = lock();
      const started = [];
      let state;
      try {
        const config = configuration(root, env);
        state = readState() || { version: 1, host: config.host, port: config.port, deviceId: config.deviceId, hub: null, agent: null };
        if ((owned(state.hub, 'hub') || owned(state.agent, 'agent')) &&
            (state.port !== config.port || state.host !== config.host || state.deviceId !== config.deviceId)) {
          throw safeError('Managed processes use different local configuration; stop them before restarting.');
        }
        state.host = config.host; state.port = config.port; state.deviceId = config.deviceId;
        event('start-requested');
        if (!owned(state.hub, 'hub')) {
          if (await portOpen(config.host, config.port)) {
            throw safeError('Port ' + config.port + ' is occupied by an unmanaged process. It was not killed or adopted.');
          }
          state.hub = await spawnOwned('hub', config.hubEnv);
          started.push('hub');
          atomicJSON(stateFile, state);
          event('hub-started', 'hub', state.hub.pid);
        }
        const ready = await waitFor(config, state, false);
        event('hub-ready');
        if (!owned(state.agent, 'agent')) {
          if (ready.devices.some(d => d.id === config.deviceId && d.online === true)) {
            throw safeError('The local agent is already reporting outside this launcher. It was not adopted or duplicated.');
          }
          state.agent = await spawnOwned('agent', config.agentEnv);
          started.push('agent');
          atomicJSON(stateFile, state);
          event('agent-started', 'agent', state.agent.pid);
        }
        await waitFor(config, state, true);
        event('agent-ready');
        event(started.length ? 'start-completed' : 'already-running');
        log(started.length ? 'Hub and local read-only agent are ready at ' + config.origin + '.' : 'Hub and local read-only agent are already running at ' + config.origin + '.');
        return { url: config.origin, hubPid: state.hub.pid, agentPid: state.agent.pid };
      } catch (error) {
        if (started.length) event('start-rollback');
        for (const role of [...started].reverse()) {
          await stopOwned(state[role], role);
          state[role] = null;
        }
        if (state && started.length) atomicJSON(stateFile, state);
        event('start-failed');
        throw error instanceof LauncherError ? error : safeError('Launcher start failed. Check existing private credentials, permissions and sandbox access; no credentials were generated.');
      } finally { release(); }
    },
    async stop() {
      const release = lock();
      try {
        const state = readState();
        if (state) {
          for (const role of ['agent', 'hub']) {
            await stopOwned(state[role], role);
            state[role] = null;
            atomicJSON(stateFile, state);
          }
        }
        event('stop-completed');
        log('Launcher-owned processes are stopped. Credentials were preserved.');
      } finally { release(); }
    },
    async status() {
      const state = readState();
      let config;
      try { config = configuration(root, env); } catch { /* Status still reports owned processes without secrets. */ }
      const host = state?.host || config?.host || '127.0.0.1';
      const port = state?.port || config?.port || 8765;
      let listening = null;
      try { listening = await portOpen(host, port); } catch { /* Report unavailable rather than infer a stopped port. */ }
      const report = { url: 'http://' + (host === '::1' ? '[::1]' : host) + ':' + port,
        configuration: config ? 'ready' : 'missing-or-invalid', portListening: listening,
        hub: { ownedRunning: owned(state?.hub, 'hub') },
        agent: { ownedRunning: owned(state?.agent, 'agent'), online: false, lastHeartbeat: null } };
      if (config && report.hub.ownedRunning) {
        try {
          const response = await stateRequest(config);
          const device = response?.devices.find(value => value.id === config.deviceId);
          report.agent.online = device?.online === true;
          if (Number.isFinite(device?.lastSeen)) report.agent.lastHeartbeat = new Date(device.lastSeen).toISOString();
        } catch { /* Auth/network failure remains an unconfirmed heartbeat. */ }
      }
      log(JSON.stringify(report, null, 2));
      return report;
    },
    async logs() {
      let content;
      try {
        safeParent(logFile, root);
        content = privateRead(logFile);
      } catch (error) {
        if (error.code === 'ENOENT') { log('No launcher operational events have been recorded.'); return []; }
        throw safeError('Operational log is unsafe or unreadable.');
      }
      const rows = [];
      for (const line of content.split('\n').filter(Boolean).slice(-100)) {
        try {
          const row = JSON.parse(line);
          if (!EVENTS.has(row.event) || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))) continue;
          rows.push({ at: new Date(row.at).toISOString(), event: row.event,
            ...(['hub', 'agent'].includes(row.role) ? { role: row.role } : {}),
            ...(Number.isSafeInteger(row.pid) && row.pid > 0 ? { pid: row.pid } : {}) });
        } catch { /* Never print raw or malformed log lines. */ }
      }
      log('Launcher operational events only; application outputs and Codex diagnostics are not recorded.');
      for (const row of rows) log(JSON.stringify(row));
      return rows;
    }
  };
}

export async function runLauncherCLI(args = process.argv.slice(2), options = {}) {
  try {
    if (args.length !== 1 || !['start', 'stop', 'status', 'logs'].includes(args[0])) throw safeError('Usage: ./leverage start|stop|status|logs');
    await createLauncher(options)[args[0]]();
  } catch (error) {
    console.error(error instanceof LauncherError ? error.message : 'Launcher failed safely. Check local private files and sandbox permissions.');
    process.exitCode = 1;
  }
}
