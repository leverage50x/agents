import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCodexJob } from '../src/codex-runner.mjs';
import { fixture } from '../test-support/fixtures.mjs';

test('demo uses a directory without Git and leaves the workspace untouched', async t => {
  const f = fixture(t);
  const threadId = '01a0f2f7-6fa5-7f72-999c-8522c8196a4f';
  const result = await runCodexJob({ prompt: 'Create a file named SHOULD_NOT_EXIST', threadId }, f.env);
  assert.match(result.output, /DEMO ONLY/);
  assert.equal(result.threadId, threadId);
  assert.equal(fs.existsSync(path.join(f.workspace, '.git')), false);
  assert.deepEqual(fs.readdirSync(f.workspace), []);
});

test('live activation is blocked before workspace or job validation', async () => {
  await assert.rejects(runCodexJob(null, { LEVERAGE_ENABLE_LIVE_CODEX: '1' }), /LIVE CODEX BLOCKED/);
});

test('demo rejects missing, relative and non-directory workspaces', async t => {
  const f = fixture(t);
  const file = path.join(f.root, 'file');
  fs.writeFileSync(file, '');
  for (const workspace of [undefined, 'relative', path.join(f.root, 'missing'), file]) {
    await assert.rejects(runCodexJob({ prompt: 'demo' }, { LEVERAGE_WORKSPACE: workspace }), /absolute directory/);
  }
});

test('demo rejects invalid instructions', async t => {
  const f = fixture(t);
  for (const job of [null, {}, { prompt: null }, { prompt: '' }, { prompt: ' ' }, { prompt: 'x'.repeat(2001) }]) {
    await assert.rejects(runCodexJob(job, f.env), /instruction/);
  }
});
