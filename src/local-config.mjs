import fs from 'node:fs';
import path from 'node:path';

export function loopbackHost(host = '127.0.0.1') {
  if (host === 'localhost') return '127.0.0.1';
  if (host === '127.0.0.1' || host === '::1') return host;
  throw new Error('ETAPA 1 permits loopback hosts only.');
}

export function localHubUrl(value = 'http://127.0.0.1:8765') {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid local hub URL.'); }
  if (url.protocol !== 'http:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTP loopback origin without credentials, path, query or fragment.');
  }
  const host = loopbackHost(url.hostname === '[::1]' ? '::1' : url.hostname);
  url.hostname = host === '::1' ? '[::1]' : host;
  return url.origin;
}

export function validateToken(token) {
  if (typeof token !== 'string' || token.length < 24 || /[\s\x00-\x1f\x7f]/.test(token)) {
    throw new Error('Set LEVERAGE_TOKEN to a long random secret (at least 24 characters, no whitespace).');
  }
  return token;
}

export function workspaceReady(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) return false;
  try {
    if (!fs.statSync(workspace).isDirectory()) return false;
    fs.accessSync(workspace, fs.constants.R_OK);
    return true;
  } catch { return false; }
}
