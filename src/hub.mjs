import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { loopbackHost, validateToken } from './local-config.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDevice = value => typeof value === 'string' && /^[a-f0-9]{20}$/.test(value);
const isThread = value => value == null || value === '' || (typeof value === 'string' && UUID.test(value));

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

function inventory(body) {
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
    sessions: sessions.map(x => ({ id: x.id, modified: new Date(x.modified).toISOString() })),
    sessionInventory: { status: meta.status, truncated: meta.truncated }
  };
}

export function createHub({ token, now = Date.now } = {}) {
  validateToken(token);
  const devices = new Map();
  const jobs = new Map();
  const online = device => device && now() - device.lastSeen < 15000;

  async function route(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const assets = { '/': ['ui.html', 'text/html'], '/app.js': ['ui.mjs', 'text/javascript'], '/app.css': ['ui.css', 'text/css'] };
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
    if (!validToken(req.headers.authorization, token)) return send(res, 401, { error: 'Unauthorized' });
    if (req.method === 'GET' && u.pathname === '/api/state') {
      return send(res, 200, {
        devices: [...devices.values()].map(d => ({ ...d, online: Boolean(online(d)) })),
        jobs: [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40)
      });
    }
    if (req.method === 'POST' && u.pathname === '/api/agent/heartbeat') {
      const b = await readJson(req);
      requireValue(isDevice(b.deviceId), 'Invalid device.');
      requireValue(typeof b.name === 'string' && b.name.trim().length > 0 && b.name.length <= 64, 'Invalid device name.');
      requireValue(typeof b.platform === 'string' && b.platform.length <= 30, 'Invalid platform.');
      requireValue(b.workspaceReady === undefined || typeof b.workspaceReady === 'boolean', 'Invalid workspace readiness.');
      const discovered = inventory(b);
      devices.set(b.deviceId, {
        id: b.deviceId, name: b.name, platform: b.platform, sandbox: 'no-execution',
        workspaceReady: b.workspaceReady === true, executionMode: 'demo-only',
        ...discovered, lastSeen: now()
      });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/task') {
      const b = await readJson(req);
      requireValue(isDevice(b.deviceId) && online(devices.get(b.deviceId)), 'Device offline or unknown.');
      requireValue(typeof b.prompt === 'string' && b.prompt.trim().length > 0 && b.prompt.length <= 2000,
        'Prompt required (max 2000 chars).');
      requireValue(isThread(b.threadId), 'Invalid Codex thread ID.');
      const job = {
        id: randomUUID(), deviceId: b.deviceId, threadId: b.threadId || null, prompt: b.prompt,
        status: 'pending_approval', output: '', createdAt: new Date(now()).toISOString()
      };
      jobs.set(job.id, job);
      return send(res, 201, { job });
    }
    if (req.method === 'POST' && ['/api/task/approve', '/api/task/reject'].includes(u.pathname)) {
      const b = await readJson(req);
      const job = jobs.get(b.jobId);
      if (!job || job.status !== 'pending_approval') {
        return send(res, 409, { error: 'Job is missing or no longer pending approval.' });
      }
      if (u.pathname.endsWith('/approve')) {
        job.status = 'queued';
        job.approvedAt = new Date(now()).toISOString();
      } else {
        job.status = 'rejected';
        job.finishedAt = new Date(now()).toISOString();
      }
      return send(res, 200, { ok: true, status: job.status });
    }
    if (req.method === 'GET' && u.pathname === '/api/agent/task') {
      const deviceId = u.searchParams.get('deviceId');
      requireValue(isDevice(deviceId) && online(devices.get(deviceId)), 'Device offline or unknown.');
      const job = [...jobs.values()].find(j => j.deviceId === deviceId && j.status === 'queued');
      if (job) { job.status = 'running'; job.startedAt = new Date(now()).toISOString(); }
      return send(res, 200, { job: job || null });
    }
    if (req.method === 'POST' && u.pathname === '/api/agent/result') {
      const b = await readJson(req);
      const job = jobs.get(b.jobId);
      requireValue(job && job.deviceId === b.deviceId && job.status === 'running', 'Job mismatch.');
      requireValue(['completed', 'failed'].includes(b.status) && typeof b.output === 'string' &&
        b.output.length <= 12000 && isThread(b.threadId), 'Invalid demo result.');
      job.status = b.status;
      job.output = b.output;
      job.resultThreadId = b.threadId || job.threadId;
      job.finishedAt = new Date(now()).toISOString();
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
  const server = createHub({ token: env.LEVERAGE_TOKEN });
  server.listen(port, host, () => {
    console.log('Leverage50xAgents hub listening on loopback port ' + port + ' (DEMO ONLY).');
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    startHub().on('error', () => { console.error('Hub could not listen on the configured local port.'); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
