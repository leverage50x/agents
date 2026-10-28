import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// This broker reads data, never project code. Limits may be reduced by a caller,
// but cannot be enlarged by configuration or model-supplied tool arguments.
export const REPOSITORY_READ_LIMITS = Object.freeze({
  maxFileBytes: 65536, maxTotalBytes: 524288, maxRequests: 64,
  maxEntries: 100, maxDirectoryEntries: 1000, maxLines: 200, maxOutputBytes: 16384,
});
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json',
  '.md', '.markdown', '.css', '.html', '.yml', '.yaml', '.toml']);
const PLAIN_FILES = new Set(['LICENSE', 'LICENSE.md', 'leverage', '.gitignore', '.editorconfig']);
const PRIVATE_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage',
  'tmp', 'temp', 'logs', 'secrets', 'secret', 'private', 'credentials', 'auth',
  'sessions', 'transcripts', 'history', 'backups', 'personal', 'contacts', 'customers']);
const PRIVATE_FILE = /(?:^|[._ -])(?:auth|credentials?|secrets?|tokens?|passwords?|cookies?|sessions?|history|transcripts?|contacts?|personal|private|service[-_]account)(?:[._ -]|$)|^(?:id_rsa|id_ed25519|authorized_keys|known_hosts)(?:\.|$)|^RAPORT[-_. ]|^comenzi executate agent\.md$/i;
const OPEN_DIR = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const OPEN_FILE = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

class ReadError extends Error {
  constructor(code) { super('Repository read rejected.'); this.code = code; }
}
const reject = code => { throw new ReadError(code); };
const MESSAGES = Object.freeze({
  'repository-closed': 'The repository reader is closed.',
  'repository-invalid-request': 'Invalid repository read request.',
  'repository-path-denied': 'This path is outside the authorized source-file policy.',
  'repository-sensitive': 'This file contains recognizable sensitive data and was withheld.',
  'repository-binary': 'Only valid UTF-8 text source files are readable.',
  'repository-file-too-large': 'This file exceeds the per-file read limit.',
  'repository-budget': 'The repository read budget has been reached.',
  'repository-changed': 'The file changed during the read. Retry after it is stable.',
  'workspace-changed': 'The authorized workspace changed. Start a new approved operation.',
  'repository-unavailable': 'The requested repository data is unavailable.',
});

function segments(input, rootAllowed = false) {
  if (rootAllowed && (input === '.' || input === '')) return [];
  if (typeof input !== 'string' || input.length > 512 || input.startsWith('/') ||
      input.includes('\\') || input.includes('%')) reject('repository-path-denied');
  const result = input.split('/');
  if (result.length > 12 || result.some(part => !/^[A-Za-z0-9._ -]{1,128}$/.test(part) ||
      part === '.' || part === '..' || part.trim() !== part)) reject('repository-path-denied');
  return result;
}

function permitted(parts, directory) {
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const lower = part.toLowerCase();
    const isDirectory = directory || index < parts.length - 1;
    if (lower.startsWith('.env') || PRIVATE_DIRS.has(lower) ||
        (part.startsWith('.') && !(part === '.github' && isDirectory) &&
          !(index === parts.length - 1 && !directory && PLAIN_FILES.has(part)))) return false;
    if (!isDirectory && PRIVATE_FILE.test(part) && !/\.(?:mjs|cjs|js|jsx|ts|tsx)$/i.test(part)) return false;
  }
  if (directory) return true;
  const basename = parts.at(-1);
  return PLAIN_FILES.has(basename) || EXTENSIONS.has(path.posix.extname(basename).toLowerCase());
}

// Recognition is deliberately conservative. It is not a semantic PII detector:
// an arbitrary person's name or confidential prose cannot be reliably inferred.
// Source allowlisting + these whole-file gates prevent known credential formats,
// credential literals, email addresses and personal host/path metadata escaping.
function sensitive(text, extension) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text) ||
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/.test(text) ||
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(text) ||
      /\bBearer[ \t]+[A-Za-z0-9._~+\/-]{8,}/i.test(text) ||
      /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@/.test(text) ||
      /(?:\/home\/|\/Users\/|[A-Z]:[\\/]Users[\\/])[^\s"'`<>/\\]+/i.test(text) ||
      /\+[1-9][0-9](?:[ ()-]*[0-9]){8,13}\b/.test(text)) return true;
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi)) {
    if (!/^(?:example\.(?:com|org|net)|test\.invalid)$/i.test(match[1])) return true;
  }
  const key = '(?:[A-Za-z_][A-Za-z0-9_]*[_-]?)?(?:api[_-]?key|password|passwd|secret|token|private[_-]?key|access[_-]?key|signing[_-]?key|credential)';
  // A key inside a quoted string such as 'AGENT_TOKEN=' + generate() is
  // application source, not a literal credential. JSON quoted properties and
  // actual unquoted JS assignment names are still checked.
  const property = '(?:(?<![A-Za-z0-9_"\'])' + key + '\\b|["\']' + key + '["\'])';
  const literal = new RegExp(property + '\\s*[:=]\\s*(["\'])([^"\'\\r\\n]+)\\1', 'gi');
  for (const match of text.matchAll(literal)) {
    if (!/^(?:\$\{[^}]+\}|<[^>]+>|\[REDACTED\])$/.test(match[2])) return true;
  }
  if (['.json', '.yaml', '.yml', '.toml'].includes(extension)) {
    const bare = new RegExp(property + '\\s*[:=]\\s*([A-Za-z0-9_./+~-]+)(?:[\\s,;#}]|$)', 'gi');
    for (const match of text.matchAll(bare)) {
      if (!/^(?:process\.env\.|(?:undefined|null|false|true)$)/.test(match[1])) return true;
    }
  }
  for (const match of text.matchAll(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g)) {
    const numbers = match[0].split('.').map(Number);
    if (numbers.some(number => number > 255)) continue;
    const [a, b, c] = numbers;
    if (a === 127 || match[0] === '0.0.0.0' ||
        (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113)) continue;
    return true;
  }
  // Non-loopback IPv6 literals are also withheld; punctuation in ordinary code
  // is not interpreted as an address without multiple colon-separated groups.
  if (/(?:\b[0-9a-f]{1,4}:){3,}[0-9a-f:]+\b/i.test(text)) return true;
  return false;
}

function plainArguments(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(key => !keys.includes(key))) reject('repository-invalid-request');
}

/** Linux/WSL-only, pinned to one workspace generation; no filesystem mutation. */
export function createRepositoryReader({ workspace, limits: requested = {} } = {}) {
  let canonical;
  let root;
  let identity;
  const limits = { ...REPOSITORY_READ_LIMITS };
  try {
    if (process.platform !== 'linux' || typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error();
    canonical = fs.realpathSync(workspace);
    if (canonical === path.parse(canonical).root || fs.lstatSync(workspace).isSymbolicLink()) throw new Error();
    plainArguments(requested, Object.keys(limits));
    for (const [name, value] of Object.entries(requested)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > limits[name]) throw new Error();
      limits[name] = value;
    }
    root = fs.openSync(canonical, OPEN_DIR);
    identity = fs.fstatSync(root);
    if (!identity.isDirectory()) throw new Error();
    // A platform without working procfs descriptor anchors fails closed.
    if (fs.realpathSync('/proc/self/fd/' + root) !== canonical) throw new Error();
  } catch {
    if (root !== undefined) fs.closeSync(root);
    throw new Error('Invalid repository reader workspace or limits.');
  }
  let closed = false;
  let requests = 0;
  let bytesRead = 0;
  let bytesReturned = 0;
  let entriesScanned = 0;
  let denied = 0;
  const files = [];

  const assertWorkspace = descriptor => {
    try {
      const current = fs.lstatSync(workspace);
      if (current.isSymbolicLink() || fs.realpathSync(workspace) !== canonical ||
          current.dev !== identity.dev || current.ino !== identity.ino) throw new Error();
      if (descriptor !== undefined) {
        const resolved = fs.realpathSync('/proc/self/fd/' + descriptor);
        if (resolved !== canonical && !resolved.startsWith(canonical + path.sep)) throw new Error();
        const actual = fs.statSync(resolved);
        const opened = fs.fstatSync(descriptor);
        if (actual.dev !== opened.dev || actual.ino !== opened.ino) throw new Error();
      }
    } catch { reject('workspace-changed'); }
  };
  const walk = (parts, directory) => {
    let descriptor = root;
    try {
      for (let index = 0; index < parts.length; index++) {
        const next = fs.openSync('/proc/self/fd/' + descriptor + '/' + parts[index],
          directory || index < parts.length - 1 ? OPEN_DIR : OPEN_FILE);
        if (descriptor !== root) fs.closeSync(descriptor);
        descriptor = next;
      }
      assertWorkspace(descriptor);
      return descriptor;
    } catch (error) {
      if (descriptor !== root) fs.closeSync(descriptor);
      if (error instanceof ReadError) throw error;
      if (['ELOOP', 'ENOTDIR'].includes(error.code)) reject('repository-path-denied');
      reject('repository-unavailable');
    }
  };
  const operation = fn => {
    try {
      if (closed) reject('repository-closed');
      if (++requests > limits.maxRequests) reject('repository-budget');
      assertWorkspace();
      return fn();
    } catch (error) {
      denied++;
      const code = error instanceof ReadError ? error.code : 'repository-unavailable';
      return { ok: false, error: { code, message: MESSAGES[code] } };
    }
  };
  const list = (args = {}) => operation(() => {
    plainArguments(args, ['path', 'cursor']);
    const parts = segments(args.path ?? '.', true);
    if (!permitted(parts, true)) reject('repository-path-denied');
    const cursor = args.cursor ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= limits.maxDirectoryEntries) reject('repository-invalid-request');
    const descriptor = walk(parts, true);
    let directory;
    try {
      directory = fs.opendirSync('/proc/self/fd/' + descriptor);
      const entries = [];
      let scanned = 0;
      let reachedEnd = false;
      while (scanned < limits.maxDirectoryEntries && entries.length < limits.maxEntries) {
        const entry = directory.readSync();
        if (!entry) { reachedEnd = true; break; }
        scanned++;
        entriesScanned++;
        if (scanned <= cursor || !/^[A-Za-z0-9._ -]{1,128}$/.test(entry.name) || entry.isSymbolicLink()) continue;
        const isDirectory = entry.isDirectory();
        if ((!isDirectory && !entry.isFile()) || !permitted([...parts, entry.name], isDirectory)) continue;
        // Dirent type is only a hint; don't advertise hardlinked source files.
        const stat = fs.lstatSync('/proc/self/fd/' + descriptor + '/' + entry.name);
        if (stat.isSymbolicLink() || (!isDirectory && (!stat.isFile() || stat.nlink !== 1)) ||
            (isDirectory && !stat.isDirectory())) continue;
        entries.push({ name: entry.name, type: isDirectory ? 'directory' : 'file' });
      }
      assertWorkspace(descriptor);
      const truncated = !reachedEnd;
      return { ok: true, path: parts.join('/') || '.', entries,
        truncated, ...(truncated && scanned < limits.maxDirectoryEntries ? { nextCursor: scanned } : {}) };
    } finally {
      directory?.closeSync();
      if (descriptor !== root) fs.closeSync(descriptor);
    }
  });
  const read = args => operation(() => {
    plainArguments(args, ['path', 'startLine', 'endLine']);
    const parts = segments(args.path);
    if (!permitted(parts, false)) reject('repository-path-denied');
    const startLine = args.startLine ?? 1;
    const endLine = args.endLine ?? startLine + limits.maxLines - 1;
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
        startLine < 1 || endLine < startLine || endLine - startLine >= limits.maxLines) reject('repository-invalid-request');
    const descriptor = walk(parts, false);
    try {
      const before = fs.fstatSync(descriptor);
      if (!before.isFile() || before.nlink !== 1) reject('repository-path-denied');
      if (before.size > limits.maxFileBytes) reject('repository-file-too-large');
      if (bytesRead + before.size + 1 > limits.maxTotalBytes) reject('repository-budget');
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
        bytesRead += count;
      }
      const after = fs.fstatSync(descriptor);
      assertWorkspace(descriptor);
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs || after.nlink !== 1) reject('repository-changed');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
      catch { reject('repository-binary'); }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)) reject('repository-binary');
      if (sensitive(text, path.posix.extname(parts.at(-1)).toLowerCase())) reject('repository-sensitive');
      const lines = text.split(/\r?\n/);
      if (lines.at(-1) === '' && text.endsWith('\n')) lines.pop();
      const totalLines = text.length ? lines.length : 0;
      if (totalLines && startLine > totalLines) reject('repository-invalid-request');
      const selected = [];
      let outputBytes = 0;
      let line = startLine;
      for (; line <= Math.min(endLine, totalLines); line++) {
        const value = line + ': ' + lines[line - 1];
        const amount = Buffer.byteLength(value) + (selected.length ? 1 : 0);
        if (outputBytes + amount > limits.maxOutputBytes) break;
        selected.push(value); outputBytes += amount;
      }
      if (!selected.length && totalLines) reject('repository-file-too-large');
      bytesReturned += outputBytes;
      const lastLine = selected.length ? line - 1 : 0;
      const record = { path: parts.join('/'), startLine: totalLines ? startLine : 0,
        endLine: lastLine, bytes: length };
      files.push(record);
      return { ok: true, path: record.path, startLine: record.startLine, endLine: lastLine, totalLines,
        content: selected.join('\n'), sha256: createHash('sha256').update(buffer.subarray(0, length)).digest('hex'),
        truncated: lastLine < totalLines, ...(lastLine < totalLines ? { nextLine: lastLine + 1 } : {}) };
    } finally { if (descriptor !== root) fs.closeSync(descriptor); }
  });
  return Object.freeze({ list, read,
    stats: () => ({ requests, bytesRead, bytesReturned, entriesScanned, denied,
      files: files.map(item => ({ ...item })), limits: { ...limits } }),
    close: () => { if (!closed) { closed = true; fs.closeSync(root); } },
  });
}
