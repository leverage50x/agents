import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESUME_SOURCE_KINDS, matchesResumePickerThread, sanitizeSessionTitle, resumeSessionMetadata,
  compareSessionActivity } from '../src/codex-session-metadata.mjs';

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

test('shared official metadata accepts bounded UUID/time and never reads or returns private fields', () => {
  const thread = { id: 'ABCDEF12-1111-4111-8111-111111111111', source: 'cli', updatedAt: 1700000000,
    cwd: '/synthetic/project', name: 'Named session', status: { type: 'active' } };
  for (const key of ['preview', 'turns', 'gitInfo', 'account']) Object.defineProperty(thread, key,
    { get() { assert.fail('Private field must not be read: ' + key); } });
  const metadata = resumeSessionMetadata(thread, '/synthetic/project');
  assert.deepEqual(metadata, { id: thread.id.toLowerCase(), modified: '2023-11-14T22:13:20.000Z',
    lastActivity: '2023-11-14T22:13:20.000Z', project: 'project', title: 'Named session',
    activity: 'discovered', source: 'app-server' });
  assert.equal(resumeSessionMetadata(thread, '/synthetic/other'), undefined);
  for (const updatedAt of [-1, 1.5, '1700000000', NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.equal(resumeSessionMetadata({ ...thread, updatedAt }), undefined);
  }
  for (const id of [undefined, null, 7, 'invalid']) assert.equal(resumeSessionMetadata({ ...thread, id }), undefined);
  assert.equal(resumeSessionMetadata({ ...thread, cwd: '/synthetic/private@example.com' }).project, undefined);
});

test('shared activity ordering uses latest metadata and stable UUID ties', () => {
  const rows = [{ id: 'b', modified: '2024-01-01T00:00:00.000Z' },
    { id: 'c', modified: '2023-01-01T00:00:00.000Z' }, { id: 'a', modified: '2024-01-01T00:00:00.000Z' }];
  assert.deepEqual(rows.sort(compareSessionActivity).map(row => row.id), ['a', 'b', 'c']);
});
