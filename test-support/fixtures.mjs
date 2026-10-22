import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createCredentialStore } from '../src/credentials.mjs';

export function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leverage50xagents-synthetic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'codex');
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  const token = randomBytes(32).toString('hex');
  const credentialFile = path.join(root, 'agents.json');
  const store = createCredentialStore({ file: credentialFile });
  const enrolled = store.enroll('synthetic-device');
  return { root, workspace, home, token, store, agentToken: enrolled.token,
    device: { ...device, deviceId: enrolled.deviceId }, env: {
    LEVERAGE_TOKEN: token, LEVERAGE_OPERATOR_TOKEN: token,
    LEVERAGE_AGENT_ID: enrolled.deviceId, LEVERAGE_AGENT_TOKEN: enrolled.token,
    LEVERAGE_DEVICE: 'synthetic-device', LEVERAGE_CREDENTIAL_STORE: credentialFile,
    LEVERAGE_WORKSPACE: workspace, LEVERAGE_CODEX_HOME: home, LEVERAGE_SESSION_SOURCE: 'files'
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
  deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'synthetic-device', platform: 'linux',
  mcp: { status: 'configured-only', servers: ['synthetic-docs'] }, sessions: [], workspaceReady: true
};

export async function register(call, device) {
  const result = await call({ method: 'POST', endpoint: '/api/agent/heartbeat', body: device });
  if (result.status !== 200) throw new Error('Synthetic registration failed.');
}
