import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_BYTES = 1024 * 1024;

function owned(stat) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function rejectSymlinkAncestors(value) {
  let current = path.parse(value).root;
  for (const part of value.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Credential paths must not contain symbolic links.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export function preparePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  rejectSymlinkAncestors(resolved);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) {
    throw new Error('The credential directory must be an owned regular directory.');
  }
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(resolved, 0o700);
  return resolved;
}

export function resolveLocalSecretPath(value, { cwd = process.cwd() } = {}) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid local secret path.');
  const root = path.resolve(cwd, '.local-run');
  const resolved = path.resolve(cwd, value);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Secret files must be inside the workspace .local-run directory.');
  }
  rejectSymlinkAncestors(resolved);
  return resolved;
}

function validateFileStat(stat) {
  if (!stat.isFile() || !owned(stat) || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > MAX_BYTES) {
    throw new Error('The credential file must be private, owned, bounded and regular.');
  }
}

export function assertNewSecretFile(file) {
  rejectSymlinkAncestors(file);
  preparePrivateDirectory(path.dirname(file));
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('The secret output file already exists; it will not be overwritten.');
}

export function writeNewSecretFile(file, content) {
  assertNewSecretFile(file);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.unlinkSync(file); } catch { /* The caller still receives the original failure. */ }
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

export function validateDeviceName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error('Device names must be non-empty, at most 64 characters and contain no control characters.');
  }
  return name.trim();
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function decode(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('The credential registry is corrupt.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1 ||
      Object.keys(parsed).sort().join(',') !== 'agents,version' || !Array.isArray(parsed.agents) || parsed.agents.length > 10000) {
    throw new Error('The credential registry has an invalid format.');
  }
  const ids = new Set();
  const hashes = new Set();
  for (const agent of parsed.agents) {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent) ||
        Object.keys(agent).sort().join(',') !== 'createdAt,id,name,revokedAt,tokenHash' ||
        !UUID.test(agent.id) || !HASH.test(agent.tokenHash) || !isTimestamp(agent.createdAt) ||
        (agent.revokedAt !== null && (!isTimestamp(agent.revokedAt) || agent.revokedAt < agent.createdAt)) ||
        ids.has(agent.id) || hashes.has(agent.tokenHash)) {
      throw new Error('The credential registry contains invalid or duplicate credentials.');
    }
    validateDeviceName(agent.name);
    ids.add(agent.id);
    hashes.add(agent.tokenHash);
  }
  return parsed.agents;
}

function publicAgent(agent) {
  return { id: agent.id, name: agent.name, createdAt: agent.createdAt, revokedAt: agent.revokedAt };
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createCredentialStore({ file, now = Date.now } = {}) {
  const resolved = file === undefined ? undefined : path.resolve(file);
  let agents = [];
  if (resolved) preparePrivateDirectory(path.dirname(resolved));

  function load() {
    if (!resolved) return;
    rejectSymlinkAncestors(resolved);
    let fd;
    try {
      fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === 'ENOENT') { agents = []; return; }
      throw new Error('The private credential registry cannot be read safely.');
    }
    try {
      validateFileStat(fs.fstatSync(fd));
      const data = fs.readFileSync(fd, 'utf8');
      if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('The credential registry is too large.');
      agents = decode(data);
    } finally { fs.closeSync(fd); }
  }

  function save() {
    const temporary = resolved + '.' + randomUUID() + '.tmp';
    const serialized = JSON.stringify({ version: 1, agents }) + '\n';
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('The credential registry is full.');
    try {
      writeNewSecretFile(temporary, serialized);
      // The lock serializes writers; reject an unsafe replacement before publishing.
      try { validateFileStat(fs.lstatSync(resolved)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.renameSync(temporary, resolved);
      const fd = fs.openSync(path.dirname(resolved), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  function mutate(change) {
    if (!resolved) return change();
    rejectSymlinkAncestors(resolved);
    const lock = resolved + '.lock';
    let fd;
    try { fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch { throw new Error('The credential registry is locked or cannot be written safely.'); }
    try {
      load();
      const result = change();
      if (result !== false) save();
      return result;
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }

  function findToken(token) {
    load();
    if (typeof token !== 'string' || token.length < 24 || token.length > 1024 || /[\s\x00-\x1f\x7f]/.test(token)) return null;
    const digest = Buffer.from(tokenHash(token), 'hex');
    let match = null;
    for (const agent of agents) {
      if (timingSafeEqual(digest, Buffer.from(agent.tokenHash, 'hex'))) match = agent;
    }
    return match;
  }

  load();
  return {
    enroll(name) {
      const safeName = validateDeviceName(name);
      return mutate(() => {
        if (agents.length >= 10000) throw new Error('The credential registry is full.');
        const token = randomBytes(32).toString('hex');
        const id = randomUUID();
        const digest = tokenHash(token);
        if (agents.some(agent => agent.id === id || agent.tokenHash === digest)) {
          throw new Error('A duplicate credential was generated; enrollment was cancelled.');
        }
        agents.push({ id, name: safeName, tokenHash: digest, createdAt: new Date(now()).toISOString(), revokedAt: null });
        return { deviceId: id, name: safeName, token };
      });
    },
    authenticate(token) {
      const match = findToken(token);
      return match?.revokedAt === null ? publicAgent(match) : null;
    },
    // Role separation must also reject a previously revoked agent credential.
    hasToken(token) { return findToken(token) !== null; },
    list() { load(); return agents.map(publicAgent); },
    revoke(deviceId) {
      return mutate(() => {
        const agent = agents.find(value => value.id === deviceId && value.revokedAt === null);
        if (!agent) return false;
        agent.revokedAt = new Date(now()).toISOString();
        return true;
      });
    }
  };
}
