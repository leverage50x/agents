import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const UUID = /([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$/i;

export function codexHome() {
  return process.env.LEVERAGE_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Extract server names without exposing environment variables, commands or auth. */
export function parseMcpNames(toml) {
  const found = new Set();
  let multiline = null;
  for (const line of toml.split(/\r?\n/)) {
    const section = line.match(/^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/);
    if (!multiline && section) {
      const name = section[1] || section[2] || section[3];
      if (name.length <= 80) found.add(name);
    }
    // Ignore apparent table headers inside TOML multiline string values.
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      if (multiline) {
        if (multiline === '"""' && line[i] === '\\') { i++; continue; }
        if (line.startsWith(multiline, i)) { i += 2; multiline = null; }
      } else if (quote) {
        if (quote === '"' && line[i] === '\\') { i++; continue; }
        if (line[i] === quote) quote = null;
      } else {
        if (line[i] === '#') break;
        if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
          multiline = line.slice(i, i + 3); i += 2;
        } else if (line[i] === '"' || line[i] === "'") quote = line[i];
      }
    }
  }
  return [...found].sort().slice(0, 100);
}

export function listMcp(home = codexHome()) {
  const file = path.join(home, 'config.toml');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) {
      return { status: 'unavailable', servers: [] };
    }
    const contents = fs.readFileSync(file, 'utf8');
    return { status: 'configured-only', servers: parseMcpNames(contents) };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'no-config' : 'unavailable', servers: [] };
  }
}

/** Reads filenames only, never user prompts, chat history or stored secrets. */
export function listSessionInventory(home = codexHome(), limit = 40, { maxEntries = 10000 } = {}) {
  if (!Number.isInteger(limit) || limit < 0 || limit > 40 ||
      !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000) {
    throw new RangeError('Invalid session inventory limit.');
  }
  const root = path.join(home, 'sessions');
  try {
    if (!fs.lstatSync(root).isDirectory()) return { status: 'unavailable', truncated: false, sessions: [] };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'missing' : 'unavailable', truncated: false, sessions: [] };
  }
  const result = new Map();
  const dirs = [{ dirname: root, depth: 0 }];
  let scanned = 0;
  let truncated = false;
  let partial = false;
  while (dirs.length && scanned < maxEntries) {
    const { dirname, depth } = dirs.pop();
    let dir;
    try {
      dir = fs.opendirSync(dirname);
      let entry;
      while (scanned < maxEntries && (entry = dir.readSync())) {
        scanned++;
        const f = path.join(dirname, entry.name);
        if (entry.isDirectory()) {
          if (depth < 5) dirs.push({ dirname: f, depth: depth + 1 });
          else truncated = true;
        } else if (entry.isFile()) {
          const match = UUID.exec(entry.name);
          if (match) {
            try {
              const stat = fs.lstatSync(f);
              if (!stat.isFile()) continue;
              const id = match[1].toLowerCase();
              if (!result.has(id) || result.get(id) < stat.mtimeMs) result.set(id, stat.mtimeMs);
            } catch { partial = true; }
          }
        }
      }
      if (scanned >= maxEntries) truncated = true;
    } catch {
      if (dirname === root) return { status: 'unavailable', truncated: false, sessions: [] };
      partial = true;
    }
    finally { if (dir) dir.closeSync(); }
  }
  const sessions = [...result].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
    .map(([id, modified]) => ({ id, modified: new Date(modified).toISOString() }));
  return { status: partial ? 'partial' : 'available', truncated: truncated || result.size > limit, sessions };
}

/** Compatibility helper: metadata is available from listSessionInventory. */
export function listSessionIds(home = codexHome(), limit = 40) {
  return listSessionInventory(home, limit).sessions;
}
