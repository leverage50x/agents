import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESUME_SOURCE_KINDS, matchesResumePickerThread, sanitizeSessionTitle } from '../src/codex-session-metadata.mjs';

test('CLI resume filter uses interactive source and archive metadata independently of runtime status', () => {
  assert.deepEqual(RESUME_SOURCE_KINDS, ['cli', 'vscode']);
  for (const source of RESUME_SOURCE_KINDS) for (const type of ['notLoaded', 'idle', 'active', 'systemError']) {
    assert.equal(matchesResumePickerThread({ source, cwd: '/synthetic/project', status: { type } }, '/synthetic/project'), true);
  }
  for (const source of ['exec', 'appServer', 'unknown', 'subAgent', { subAgent: 'review' }, { custom: 'integration' }, undefined]) {
    assert.equal(matchesResumePickerThread({ source, cwd: '/synthetic/project' }, '/synthetic/project'), false);
  }
});

test('Cwd, archived, parent and ephemeral metadata exclude mismatched or auxiliary sessions', () => {
  const base = { source: 'cli', cwd: '/synthetic/project' };
  for (const patch of [{ cwd: '/synthetic/other' }, { cwd: '/synthetic/project/nested' }, { cwd: undefined },
    { archived: true }, { parentThreadId: 'synthetic-parent' }, { ephemeral: true }]) {
    assert.equal(matchesResumePickerThread({ ...base, ...patch }, '/synthetic/project'), false);
  }
  assert.equal(matchesResumePickerThread({ ...base, archived: false, parentThreadId: null }), true);
});

test('official title sanitizer preserves plain names, bounds UTF-8 and does not invent missing titles', () => {
  for (const value of [undefined, null, '', '   ', 7]) assert.equal(sanitizeSessionTitle(value), undefined);
  assert.equal(sanitizeSessionTitle('  Project   session  '), 'Project session');
  for (const value of ['a'.repeat(200), 'Ședință '.repeat(50), '😀'.repeat(80)]) {
    const title = sanitizeSessionTitle(value);
    assert.ok(Buffer.byteLength(title) <= 120);
    assert.ok(title.endsWith('…'));
    assert.equal(title, title.toWellFormed());
  }
});

test('titles containing personal paths, credentials, email or control characters are omitted', () => {
  const invalid = ['person@example.com', '/synthetic/private', 'workspace=/synthetic/private',
    'cwd:C:\\synthetic\\private', 'open ~/private', 'token=' + 'x'.repeat(32),
    'Bearer ' + 'x'.repeat(32), 'sk-' + 'x'.repeat(32), 'title\nprivate', 'title\u202eprivate', '\ud800'];
  for (const value of invalid) assert.equal(sanitizeSessionTitle(value), undefined);
});
