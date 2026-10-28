import path from 'node:path';

// Codex CLI 0.163.0 resume picker, include_non_interactive=false:
// sourceKinds=[cli,vscode], Cwd=current workspace, Active=archived:false.
// Runtime status is independent of the archive filter.
export const RESUME_SOURCE_KINDS = Object.freeze(['cli', 'vscode']);
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function matchesResumePickerThread(thread, workspace) {
  return Boolean(thread && typeof thread === 'object' && !Array.isArray(thread) &&
    RESUME_SOURCE_KINDS.includes(thread.source) && thread.archived !== true &&
    thread.ephemeral !== true && thread.parentThreadId == null &&
    (workspace === undefined || thread.cwd === workspace));
}

// Thread.name is optional official metadata. Never derive titles from preview,
// transcript contents, path, project name or first user message.
export function sanitizeSessionTitle(value) {
  if (typeof value !== 'string' || value.length > 4096 || value !== value.toWellFormed() ||
      /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value)) return;
  const text = value.trim().replace(/\s+/gu, ' ');
  if (!text || /-----BEGIN .*PRIVATE KEY-----|\b(?:gh[pousr]_|github_pat_|sk-|AKIA|ASIA)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\bBearer\s+\S+|\b(?:api[_-]?key|password|secret|token)\s*[=:]|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:^|[\s"'(:=])(?:\/(?!\s)|~[\\/]|[A-Z]:[\\/])/iu.test(text)) return;
  if (Buffer.byteLength(text) <= 120) return text;
  let title = '';
  for (const character of text) {
    if (Buffer.byteLength(title + character) > 117) break;
    title += character;
  }
  return title.trimEnd() + '…';
}
/** Official metadata only: never return cwd, preview, history or account data. */
export function resumeSessionMetadata(thread, workspace) {
  if (!matchesResumePickerThread(thread, workspace) || typeof thread.id !== 'string' || !UUID.test(thread.id) ||
      !Number.isSafeInteger(thread.updatedAt) || thread.updatedAt < 0) return;
  const timestamp = new Date(thread.updatedAt * 1000);
  if (!Number.isFinite(timestamp.getTime())) return;
  const modified = timestamp.toISOString();
  const basename = typeof thread.cwd === 'string' && thread.cwd.length <= 4096 && path.isAbsolute(thread.cwd)
    ? path.basename(thread.cwd) : '';
  const project = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(basename) ? basename : undefined;
  const title = sanitizeSessionTitle(thread.name);
  return { id: thread.id.toLowerCase(), modified, lastActivity: modified,
    ...(project ? { project } : {}), ...(title ? { title } : {}), activity: 'discovered', source: 'app-server' };
}

export function compareSessionActivity(a, b) {
  return b.modified.localeCompare(a.modified) || a.id.localeCompare(b.id);
}

// Both metadata clients use the same bounded, DB-only resume picker. The
// controller may decorate sanitized rows with eligibility; raw rows never leave
// this scan. Sorting before the final cap also handles an unordered server page.
export async function listResumeSessions(request, { workspace, limit = 40, decorate = metadata => metadata } = {}) {
  const found = new Map();
  const cursors = new Set();
  let cursor;
  let truncated = false;
  let partial = false;
  for (let page = 0; page < 8; page++) {
    let result = await request('thread/list', { useStateDbOnly: true, limit: limit - found.size,
      sortKey: 'updated_at', sortDirection: 'desc', archived: false, sourceKinds: RESUME_SOURCE_KINDS,
      ...(workspace ? { cwd: workspace } : {}), ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data) || result.data.length > 100 ||
        (result.nextCursor != null && (typeof result.nextCursor !== 'string' || result.nextCursor.length > 4096))) {
      throw Object.assign(new Error('Invalid session metadata page.'), { code: 'codex-protocol-error' });
    }
    for (const thread of result.data) {
      const metadata = resumeSessionMetadata(thread, workspace);
      if (!metadata) {
        // Excluded rows are normal; malformed eligible rows make inventory partial.
        if (matchesResumePickerThread(thread, workspace)) partial = true;
        continue;
      }
      if (found.has(metadata.id) && found.get(metadata.id).modified >= metadata.modified) continue;
      found.set(metadata.id, decorate(metadata, thread));
    }
    cursor = result.nextCursor;
    result = null;
    if (found.size > limit) truncated = true;
    if (!cursor) break;
    if (found.size >= limit || cursors.has(cursor) || page === 7) { truncated = true; break; }
    cursors.add(cursor);
  }
  return { status: partial ? 'partial' : 'available', source: 'app-server', truncated,
    sessions: [...found.values()].sort(compareSessionActivity).slice(0, limit) };
}
