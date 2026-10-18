import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

export function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leverage50xagents-stage1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'codex');
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  const token = randomBytes(32).toString('hex');
  return { root, workspace, home, token, env: {
    LEVERAGE_TOKEN: token, LEVERAGE_DEVICE: 'synthetic-device',
    LEVERAGE_WORKSPACE: workspace, LEVERAGE_CODEX_HOME: home
  } };
}

export function dispatch(server, token, { method = 'GET', endpoint = '/api/state', body, raw, chunks, authorization } = {}) {
  const input = chunks || [Buffer.from(raw === undefined ? (body === undefined ? '' : JSON.stringify(body)) : raw)];
  const req = Readable.from(input);
  req.method = method;
  req.url = endpoint;
  req.headers = { authorization: authorization === undefined ? 'Bearer ' + token : authorization };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('In-memory API timed out.')), 2000);
    const res = {
      destroyed: false, writableEnded: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(content) {
        clearTimeout(timer);
        this.writableEnded = true;
        const text = String(content);
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        resolve({ status: this.status, headers: this.headers, body });
      }
    };
    server.emit('request', req, res);
  });
}

export const device = {
  deviceId: 'a'.repeat(20), name: 'synthetic-device', platform: 'linux',
  mcp: { status: 'configured-only', servers: ['synthetic-docs'] }, sessions: [], workspaceReady: true
};

export async function register(call) {
  const result = await call({ method: 'POST', endpoint: '/api/agent/heartbeat', body: device });
  if (result.status !== 200) throw new Error('Synthetic registration failed.');
}
