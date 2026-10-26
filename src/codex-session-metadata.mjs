// Codex CLI 0.163.0 resume picker, include_non_interactive=false:
// sourceKinds=[cli,vscode], Cwd=current workspace, Active=archived:false.
// Runtime status is independent of the archive filter.
export const RESUME_SOURCE_KINDS = Object.freeze(['cli', 'vscode']);

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
