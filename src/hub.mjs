import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { loopbackHost, validateToken, workspaceReady } from './local-config.mjs';
import { createCredentialStore } from './credentials.mjs';
import { sanitizeSessionTitle } from './codex-session-metadata.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const assets = { '/': ['ui.html', 'text/html'], '/app.js': ['ui.mjs', 'text/javascript'], '/app.css': ['ui.css', 'text/css'] };
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDevice = value => typeof value === 'string' && UUID.test(value);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireValue(condition, message) {
  if (!condition) throw new HttpError(400, message);
}

export function validToken(auth, secret) {
  if (typeof auth !== 'string' || !/^Bearer \S+$/i.test(auth) || typeof secret !== 'string' || !secret) return false;
  const a = Buffer.from(auth.slice(7), 'utf8');
  const b = Buffer.from(secret, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let oversized = false;
    req.on('data', part => {
      if (oversized) return;
      size += part.length;
      if (size > 20000) {
        oversized = true;
        chunks = [];
        reject(new HttpError(413, 'Payload too large (max 20000 bytes).'));
      } else chunks.push(part);
    });
    req.on('end', () => {
      if (oversized) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requireValue(isObject(body), 'JSON object required.');
        resolve(body);
      } catch (error) {
        reject(error instanceof HttpError ? error : new HttpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'Unable to read request.')));
    req.on('aborted', () => reject(new HttpError(400, 'Request aborted.')));
  });
}

function inventory(body, local) {
  const mcp = body.mcp === undefined ? { status: 'unavailable', servers: [] } : body.mcp;
  requireValue(isObject(mcp) && ['configured-only', 'no-config', 'unavailable'].includes(mcp.status) &&
    Array.isArray(mcp.servers) && mcp.servers.length <= 100 &&
    mcp.servers.every(x => typeof x === 'string' && x.length > 0 && x.length <= 80), 'Invalid MCP inventory.');
  const sessions = body.sessions === undefined ? [] : body.sessions;
  requireValue(Array.isArray(sessions) && sessions.length <= 40 && sessions.every(x =>
    isObject(x) && typeof x.id === 'string' && UUID.test(x.id) &&
    typeof x.modified === 'string' && x.modified.length <= 40 && Number.isFinite(Date.parse(x.modified))),
  'Invalid session inventory.');
  const meta = body.sessionInventory === undefined ? { status: 'unknown', truncated: false } : body.sessionInventory;
  requireValue(isObject(meta) && ['available', 'missing', 'unavailable', 'partial', 'unknown'].includes(meta.status) &&
    typeof meta.truncated === 'boolean', 'Invalid session inventory metadata.');
  return {
    mcp: { status: mcp.status, servers: [...new Set(mcp.servers)] },
    sessions: sessions.map(x => {
      const title = x.source === 'app-server' ? sanitizeSessionTitle(x.title) : undefined;
      return {
        id: x.id, modified: new Date(x.modified).toISOString(),
        ...(x.source === 'app-server' && typeof x.lastActivity === 'string' && Number.isFinite(Date.parse(x.lastActivity))
          ? { lastActivity: new Date(x.lastActivity).toISOString() } : {}),
        ...(typeof x.project === 'string' && /^[\p{L}\p{N}_. -]{1,100}$/u.test(x.project) ? { project: x.project } : {}),
        ...(title ? { title } : {}),
        activity: 'discovered', source: x.source === 'app-server' ? 'app-server' : 'files',
        eligibility: local && x.eligibility === 'busy' ? 'busy' : 'discovered'
      };
    }),
    sessionInventory: { status: meta.status, truncated: meta.truncated,
      source: meta.source === 'app-server' ? 'app-server' : 'files',
      ...(['app-server-unavailable', 'app-server-incompatible'].includes(meta.reason) ? { reason: meta.reason } : {}) }
  };
}

export function createHub({ token, credentialStore = createCredentialStore(), now = Date.now, localControl } = {}) {
  validateToken(token);
  if (credentialStore.hasToken(token)) throw new Error('Operator and agent credentials must be separate.');
  const devices = new Map();
  const readonlyJobs = new Map();
  const localDeviceId = localControl?.deviceId;
  const localEnabled = Boolean(isDevice(localDeviceId) && workspaceReady(localControl?.workspace));
  const authorizedWorkspace = localEnabled ? fs.realpathSync(localControl.workspace) : null;
  const workspaceBinding = localEnabled ? createHash('sha256').update(authorizedWorkspace).digest('hex') : null;
  const online = device => device && now() - device.lastSeen < 15000;
  const localAgent = identity => localEnabled && identity?.id === localDeviceId;
  const safeAuth = value => ['authenticated', 'not-authenticated', 'unavailable'].includes(value) ? value : 'unavailable';
  const failJob = (job, errorCode) => {
    job.status = 'failed'; job.errorCode = errorCode; job.finishedAt = new Date(now()).toISOString();
  };
  const expireDisconnected = () => {
    for (const job of readonlyJobs.values()) {
      if (['queued', 'running'].includes(job.status) && !online(devices.get(job.deviceId))) {
        failJob(job, 'agent-disconnected');
      }
    }
  };

  async function route(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && Object.hasOwn(assets, u.pathname)) {
      const [file, type] = assets[u.pathname];
      const content = fs.readFileSync(path.join(directory, file));
      res.writeHead(200, {
        'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'"
      });
      return res.end(content);
    }
    const authorization = req.headers.authorization;
    const operator = validToken(authorization, token) && !credentialStore.hasToken(token);
    const bearer = typeof authorization === 'string' && /^Bearer \S+$/i.test(authorization) ? authorization.slice(7) : '';
    const agent = operator ? null : credentialStore.authenticate(bearer);
    if (!operator && !agent) return send(res, 401, { error: 'Unauthorized' });
    const agentEndpoint = u.pathname.startsWith('/api/agent/');
    if ((agentEndpoint && !agent) || (!agentEndpoint && !operator)) {
      return send(res, 403, { error: 'Credential role is not permitted on this endpoint.' });
    }
    if (req.method === 'GET' && u.pathname === '/api/state') {
      expireDisconnected();
      const agents = credentialStore.list();
      const credentialsById = new Map(agents.map(credential => [credential.id, credential]));
      return send(res, 200, {
        agents,
        localControl: { enabled: localEnabled, deviceId: localEnabled ? localDeviceId : null,
          workspaces: localEnabled ? [{ id: 'project', label: path.basename(authorizedWorkspace) }] : [] },
        readonlyJobs: [...readonlyJobs.values()].slice(-40).reverse(),
        devices: [...devices.values()].map(d => {
          const credential = credentialsById.get(d.id);
          const revokedAt = credential?.revokedAt || null;
          return { ...d, revokedAt, online: !revokedAt && Boolean(credential && online(d)) };
        })
      });
    }
    if (req.method === 'POST' && u.pathname === '/api/admin/agents') {
      const b = await readJson(req);
      requireValue(typeof b.name === 'string' && b.name.trim().length > 0 && b.name.length <= 64 &&
        !/[\x00-\x1f\x7f]/.test(b.name), 'Invalid agent name.');
      const enrolled = credentialStore.enroll(b.name.trim());
      if (validToken('Bearer ' + enrolled.token, token)) {
        credentialStore.revoke(enrolled.deviceId);
        throw new HttpError(500, 'Credential generation failed.');
      }
      return send(res, 201, enrolled);
    }
    if (req.method === 'POST' && u.pathname === '/api/admin/agents/revoke') {
      const b = await readJson(req);
      requireValue(isDevice(b.deviceId), 'Invalid device.');
      if (!credentialStore.revoke(b.deviceId)) return send(res, 404, { error: 'Unknown agent.' });
      for (const job of readonlyJobs.values()) {
        if (job.deviceId === b.deviceId && ['queued', 'running'].includes(job.status)) {
          failJob(job, 'agent-revoked');
        }
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/agent/heartbeat') {
      const b = await readJson(req);
      if (!credentialStore.authenticate(bearer)) return send(res, 401, { error: 'Unauthorized' });
      requireValue(isDevice(b.deviceId), 'Invalid device.');
      if (b.deviceId !== agent.id) return send(res, 403, { error: 'Agent identity mismatch.' });
      requireValue(typeof b.name === 'string' && b.name.trim().length > 0 && b.name.length <= 64 &&
        !/[\x00-\x1f\x7f]/.test(b.name), 'Invalid device name.');
      requireValue(typeof b.platform === 'string' && b.platform.length <= 30, 'Invalid platform.');
      requireValue(b.workspaceReady === undefined || typeof b.workspaceReady === 'boolean', 'Invalid workspace readiness.');
      const local = localAgent(agent) && b.localControl === true && b.workspaceBinding === workspaceBinding;
      const discovered = inventory(b, local);
      expireDisconnected();
      devices.set(b.deviceId, {
        id: agent.id, name: agent.name, platform: b.platform, sandbox: 'no-execution',
        workspaceReady: b.workspaceReady === true, executionMode: local ? 'local-read-only' : 'inventory-only',
        ...discovered, localControl: local, codexAuth: local ? safeAuth(b.codexAuth) : 'unavailable', lastSeen: now()
      });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/local/task') {
      expireDisconnected();
      const b = await readJson(req);
      requireValue(localEnabled && b.deviceId === localDeviceId, 'Local control is restricted to the configured primary agent.');
      const device = devices.get(localDeviceId);
      const registered = credentialStore.list().find(x => x.id === localDeviceId);
      requireValue(registered && !registered.revokedAt && online(device) && device.localControl &&
        device.codexAuth === 'authenticated', 'Local agent is offline, unavailable or not authenticated.');
      requireValue(b.confirmed === true, 'Explicit READ-ONLY confirmation is required.');
      requireValue(['new', 'resume'].includes(b.mode) && b.workspaceId === 'project', 'Select an authorized mode and workspace.');
      requireValue(typeof b.prompt === 'string' && b.prompt.trim() && b.prompt.length <= 2000, 'Instruction required (max 2000 chars).');
      requireValue(!['shell', 'command', 'sandbox', 'approvalPolicy', 'cwd', 'path', 'model'].some(key => Object.hasOwn(b, key)),
        'Execution policy cannot be supplied by a request.');
      if (b.mode === 'resume') {
        requireValue(typeof b.threadId === 'string' && UUID.test(b.threadId) &&
          device.sessions.some(x => x.id === b.threadId && x.eligibility !== 'busy'), 'Select an available session from this device.');
      } else requireValue(b.threadId === undefined || b.threadId === null || b.threadId === '', 'New mode cannot select an existing thread.');
      if ([...readonlyJobs.values()].some(j => ['queued', 'running'].includes(j.status))) {
        return send(res, 409, { error: 'A local READ-ONLY instruction is already queued or running.' });
      }
      // The active-job guard above leaves only terminal history, in insertion order.
      if (readonlyJobs.size >= 100) readonlyJobs.delete(readonlyJobs.keys().next().value);
      const job = { id: randomUUID(), deviceId: localDeviceId, mode: b.mode,
        threadId: b.mode === 'resume' ? b.threadId : null, workspaceId: 'project', prompt: b.prompt,
        confirmed: true, policy: 'local-read-only', status: 'queued', output: '', outputTruncated: false, events: [], createdAt: new Date(now()).toISOString() };
      readonlyJobs.set(job.id, job);
      return send(res, 201, { job });
    }
    if (req.method === 'GET' && u.pathname === '/api/agent/local/task') {
      expireDisconnected();
      if (!localAgent(agent) || u.searchParams.get('deviceId') !== agent.id) return send(res, 403, { error: 'Local agent identity required.' });
      requireValue(online(devices.get(agent.id)), 'Local device offline.');
      const job = [...readonlyJobs.values()].find(j => j.status === 'queued' && j.deviceId === agent.id);
      if (job) {
        const device = devices.get(agent.id);
        if (!device.localControl || device.codexAuth !== 'authenticated' || now() - Date.parse(job.createdAt) > 120000 ||
            (job.mode === 'resume' && !device.sessions.some(s => s.id === job.threadId && s.eligibility !== 'busy'))) {
          failJob(job, 'selection-no-longer-available');
          return send(res, 200, { job: null });
        }
      }
      if (job) { job.status = 'running'; job.startedAt = new Date(now()).toISOString(); }
      return send(res, 200, { job: job || null });
    }
    if (req.method === 'POST' && u.pathname === '/api/agent/local/update') {
      const b = await readJson(req);
      if (!credentialStore.authenticate(bearer)) return send(res, 401, { error: 'Unauthorized' });
      if (!localAgent(agent) || b.deviceId !== agent.id) return send(res, 403, { error: 'Local agent identity required.' });
      // An expired heartbeat cannot be revived by a late response, even if the
      // dashboard has not polled or the request body crossed the TTL boundary.
      expireDisconnected();
      const job = readonlyJobs.get(b.jobId);
      if (!job || job.deviceId !== agent.id || job.status !== 'running') return send(res, 409, { error: 'No matching running job.' });
      requireValue(['running', 'completed', 'failed', 'interrupted'].includes(b.status), 'Invalid READ-ONLY job state.');
      requireValue(b.output === undefined || (typeof b.output === 'string' && b.output.length <= 8000), 'Output limit exceeded.');
      requireValue(b.outputTruncated === undefined || typeof b.outputTruncated === 'boolean', 'Invalid output truncation flag.');
      requireValue(b.threadId == null || (typeof b.threadId === 'string' && UUID.test(b.threadId) &&
        (!job.threadId || b.threadId === job.threadId)), 'Thread identity mismatch.');
      requireValue(b.events === undefined || (Array.isArray(b.events) && b.events.length <= 20 && b.events.every(e =>
        isObject(e) && ['progress', 'output', 'error', 'completed'].includes(e.type) && typeof e.message === 'string' && e.message.length <= 160)), 'Invalid progress events.');
      job.status = b.status;
      if (b.output !== undefined) job.output = b.output;
      if (b.outputTruncated !== undefined) job.outputTruncated = b.outputTruncated;
      if (b.threadId) job.threadId = b.threadId;
      if (b.events) job.events = b.events.map(({ type, message }) => ({ type, message }));
      if (typeof b.errorCode === 'string' && /^[a-z-]{1,60}$/.test(b.errorCode)) job.errorCode = b.errorCode;
      if (job.status !== 'running') job.finishedAt = new Date(now()).toISOString();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      if (res.destroyed || res.writableEnded) return;
      send(res, error instanceof HttpError ? error.status : 500,
        { error: error instanceof HttpError ? error.message : 'Internal server error.' });
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

export function startHub(env = process.env) {
  const host = loopbackHost(env.LEVERAGE_HOST || '127.0.0.1');
  const port = Number(env.LEVERAGE_PORT || 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid hub port.');
  const server = createHub({ token: env.LEVERAGE_OPERATOR_TOKEN || env.LEVERAGE_TOKEN,
    credentialStore: createCredentialStore({ file: env.LEVERAGE_CREDENTIAL_STORE || '.local-run/agents.json' }),
    localControl: env.LEVERAGE_ENABLE_LIVE_CODEX === '1' ? undefined : {
      deviceId: env.LEVERAGE_LOCAL_DEVICE_ID, workspace: env.LEVERAGE_LOCAL_WORKSPACE } });
  server.listen(port, host, () => {
    console.log('Leverage50xAgents hub listening on loopback port ' + port + '.');
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    startHub().on('error', () => { console.error('Hub could not listen on the configured local port.'); process.exitCode = 1; });
  } catch { console.error('Hub startup failed. Check loopback settings and private credential configuration.'); process.exitCode = 1; }
}
