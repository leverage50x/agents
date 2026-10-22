import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { localHubUrl, validateToken } from './local-config.mjs';
import { assertNewSecretFile, resolveLocalSecretPath, validateDeviceName, writeNewSecretFile } from './credentials.mjs';

class ManagementError extends Error {}

function options(args, allowed) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.includes(key) || values[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new ManagementError('Invalid command options.');
    }
    values[key] = args[i + 1];
  }
  return values;
}

async function boundedJSON(response) {
  if (!response.ok) throw new ManagementError('Hub request failed with HTTP status ' + response.status + '.');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 65536) throw new ManagementError('Hub response exceeded the safe limit.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ManagementError('Hub returned invalid JSON.'); }
}

export async function runManagement(args, { env = process.env, cwd = process.cwd(), fetchImpl = fetch, log = console.log } = {}) {
  const [command, ...rest] = args;
  if (command === 'init') {
    options(rest, []);
    const file = resolveLocalSecretPath('.local-run/hub.env', { cwd });
    writeNewSecretFile(file, [
      'LEVERAGE_OPERATOR_TOKEN=' + randomBytes(32).toString('hex'),
      'LEVERAGE_CREDENTIAL_STORE=.local-run/agents.json',
      'LEVERAGE_HOST=127.0.0.1',
      'LEVERAGE_PORT=8765',
      'LEVERAGE_URL=http://127.0.0.1:8765',
      'LEVERAGE_ENABLE_LIVE_CODEX=0',
      ''
    ].join('\n'));
    log('Hub configuration created in .local-run/hub.env with private permissions. No secrets were printed.');
    return;
  }
  if (!['enroll', 'revoke', 'list'].includes(command)) {
    throw new ManagementError('Use init, enroll --name NAME --out .local-run/agent.env, revoke --device UUID, or list.');
  }
  const selected = options(rest, command === 'enroll' ? ['--name', '--out'] : command === 'revoke' ? ['--device'] : []);
  // Resolve and constrain the destination before attaching an operator credential.
  const origin = localHubUrl(env.LEVERAGE_URL);
  const token = validateToken(env.LEVERAGE_OPERATOR_TOKEN || env.LEVERAGE_TOKEN);
  const request = async (endpoint, body) => {
    let response;
    try {
      response = await fetchImpl(origin + endpoint, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(5000)
      });
    } catch { throw new ManagementError('Could not contact the authenticated loopback Hub.'); }
    return boundedJSON(response);
  };
  if (command === 'enroll') {
    const name = validateDeviceName(selected['--name']);
    if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) throw new ManagementError('CLI device names may contain letters, numbers, spaces, dots, underscores and hyphens.');
    const out = resolveLocalSecretPath(selected['--out'], { cwd });
    assertNewSecretFile(out);
    const enrolled = await request('/api/admin/agents', { name });
    if (!enrolled || !/^[0-9a-f-]{36}$/.test(enrolled.deviceId) || !/^[0-9a-f]{64}$/.test(enrolled.token) || enrolled.name !== name) {
      throw new ManagementError('Hub returned invalid enrollment credentials; no output was written.');
    }
    try {
      writeNewSecretFile(out, [
        'LEVERAGE_AGENT_ID=' + enrolled.deviceId,
        'LEVERAGE_AGENT_TOKEN=' + enrolled.token,
        'LEVERAGE_DEVICE=' + name,
        'LEVERAGE_URL=' + origin,
        'LEVERAGE_ENABLE_LIVE_CODEX=0',
        ''
      ].join('\n'));
    } catch {
      try { await request('/api/admin/agents/revoke', { deviceId: enrolled.deviceId }); }
      catch { throw new ManagementError('Credential output failed and automatic revocation failed; list and revoke the new device before retrying.'); }
      throw new ManagementError('Credential output failed; the new device credential was revoked.');
    }
    log('Agent enrolled: ' + enrolled.deviceId + '. Credentials saved privately; no token was printed.');
  } else if (command === 'revoke') {
    const deviceId = selected['--device'];
    if (!/^[0-9a-f-]{36}$/.test(deviceId || '')) throw new ManagementError('Provide a device UUID.');
    await request('/api/admin/agents/revoke', { deviceId });
    log('Agent revoked: ' + deviceId + '.');
  } else {
    const state = await request('/api/state');
    if (!Array.isArray(state.agents)) throw new ManagementError('Hub returned invalid public agent metadata.');
    log(JSON.stringify(state.agents.map(({ id, name, createdAt, revokedAt }) => ({ id, name, createdAt, revokedAt })), null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runManagement(process.argv.slice(2)).catch(error => {
    console.error(error instanceof ManagementError ? error.message : 'Management command failed. Check local configuration, private file permissions and command options.');
    process.exitCode = 1;
  });
}
