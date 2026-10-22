import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCredentialStore } from '../src/credentials.mjs';
import { runManagement } from '../src/manage.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leverage-credentials-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'agents.json') };
}

test('per-agent credentials survive restart and revoke immediately across store instances', t => {
  const { file, directory } = fixture(t);
  let time = Date.parse('2026-10-22T12:00:00.000Z');
  const first = createCredentialStore({ file, now: () => time });
  const a = first.enroll('same-name');
  const b = first.enroll('same-name');
  assert.notEqual(a.deviceId, b.deviceId);
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^[a-f0-9]{64}$/);
  const content = fs.readFileSync(file, 'utf8');
  assert.equal(content.includes(a.token), false);
  assert.equal(content.includes(b.token), false);
  assert.ok(content.includes(createHash('sha256').update(a.token).digest('hex')));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  const restarted = createCredentialStore({ file, now: () => time });
  assert.equal(restarted.authenticate(a.token).id, a.deviceId);
  assert.equal(restarted.hasToken(a.token), true);
  assert.equal(restarted.hasToken(b.token), true);
  assert.equal(restarted.hasToken('synthetic-unrecognized-secret'), false);
  assert.equal(restarted.hasToken('short'), false);
  assert.equal(restarted.authenticate('invalid'.repeat(5)), null);
  assert.equal(restarted.authenticate('short'), null);
  assert.equal(restarted.authenticate(a.token + '\n'), null);
  assert.equal('tokenHash' in restarted.list()[0], false);
  time += 1000;
  assert.equal(first.revoke(a.deviceId), true);
  assert.equal(restarted.authenticate(a.token), null);
  assert.equal(restarted.hasToken(a.token), true);
  assert.equal(restarted.authenticate(b.token).id, b.deviceId);
  assert.equal(restarted.list()[0].revokedAt, new Date(time).toISOString());
  assert.equal(first.revoke(a.deviceId), false);
});

test('registry rejects corrupt, plaintext, duplicate and unsafe stored credentials', t => {
  const { file } = fixture(t);
  const store = createCredentialStore({ file });
  store.enroll('fixture');
  const valid = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const contents of ['{', JSON.stringify({ version: 2, agents: [] }),
    JSON.stringify({ ...valid, agents: [valid.agents[0], valid.agents[0]] }),
    JSON.stringify({ ...valid, agents: [{ ...valid.agents[0], token: 'synthetic-not-a-real-token' }] }),
    JSON.stringify({ ...valid, agents: [{ ...valid.agents[0], tokenHash: 'short' }] })]) {
    fs.writeFileSync(file, contents, { mode: 0o600 });
    assert.throws(() => createCredentialStore({ file }));
  }
  fs.writeFileSync(file, JSON.stringify(valid), { mode: 0o600 });
  fs.chmodSync(file, 0o644);
  assert.throws(() => createCredentialStore({ file }), /private/);
});

test('registry refuses symlink credentials and notices unsafe edits before authentication', t => {
  const { file, directory } = fixture(t);
  const store = createCredentialStore({ file });
  const enrolled = store.enroll('fixture');
  const original = path.join(directory, 'original.json');
  fs.renameSync(file, original);
  fs.symlinkSync(original, file);
  assert.throws(() => createCredentialStore({ file }), /symbolic/);
  assert.throws(() => store.authenticate(enrolled.token), /symbolic/);
});

test('deleting the registry immediately removes all cached agent authorization', t => {
  const { file } = fixture(t);
  const store = createCredentialStore({ file });
  const enrolled = store.enroll('fixture');
  assert.equal(store.authenticate(enrolled.token).id, enrolled.deviceId);
  fs.unlinkSync(file);
  assert.equal(store.authenticate(enrolled.token), null);
  assert.equal(store.hasToken(enrolled.token), false);
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(file), false);
});

test('management init and enrollment write private files, redact secrets and never overwrite', async t => {
  const { directory } = fixture(t);
  const logs = [];
  const log = value => logs.push(value);
  await runManagement(['init'], { cwd: directory, log });
  const hubFile = path.join(directory, '.local-run/hub.env');
  const operator = fs.readFileSync(hubFile, 'utf8').match(/^LEVERAGE_OPERATOR_TOKEN=(.+)$/m)[1];
  assert.match(operator, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(hubFile).mode & 0o777, 0o600);
  await assert.rejects(runManagement(['init'], { cwd: directory, log }), /already exists/);
  const synthetic = { deviceId: '1e59fe12-249e-4cec-97db-aa6cc773a198', name: 'laptop-2', token: 'a'.repeat(64) };
  const fetchImpl = async (url, request) => {
    assert.equal(url, 'http://127.0.0.1:8765/api/admin/agents');
    assert.equal(request.headers.Authorization, 'Bearer ' + operator);
    assert.equal(request.redirect, 'error');
    return new Response(JSON.stringify(synthetic));
  };
  const env = { LEVERAGE_OPERATOR_TOKEN: operator };
  await runManagement(['enroll', '--name', 'laptop-2', '--out', '.local-run/laptop2.env'], { cwd: directory, env, fetchImpl, log });
  const output = path.join(directory, '.local-run/laptop2.env');
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(output, 'utf8').includes('LEVERAGE_AGENT_TOKEN=' + synthetic.token));
  assert.equal(logs.join('\n').includes(operator), false);
  assert.equal(logs.join('\n').includes(synthetic.token), false);
  await assert.rejects(runManagement(['enroll', '--name', 'laptop-2', '--out', '.local-run/laptop2.env'], { cwd: directory, env, fetchImpl, log }), /already exists/);
});

test('management rejects remote destinations and unsafe output before sending credentials', async t => {
  const { directory } = fixture(t);
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not be called'); };
  const args = ['enroll', '--name', 'fixture', '--out', '.local-run/agent.env'];
  const env = { LEVERAGE_OPERATOR_TOKEN: 'synthetic-operator-secret-for-tests-only' };
  await assert.rejects(runManagement(args, { cwd: directory, env: { ...env, LEVERAGE_URL: 'http://example.invalid' }, fetchImpl }));
  await assert.rejects(runManagement(['enroll', '--name', 'fixture', '--out', '../outside.env'], { cwd: directory, env, fetchImpl }));
  const target = path.join(directory, 'target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(directory, '.local-run'));
  await assert.rejects(runManagement(args, { cwd: directory, env, fetchImpl }));
  assert.equal(calls, 0);
});

test('management compensates a failed credential write by revoking enrollment', async t => {
  const { directory } = fixture(t);
  const output = path.join(directory, '.local-run/agent.env');
  const id = '1e59fe12-249e-4cec-97db-aa6cc773a198';
  const endpoints = [];
  const logs = [];
  const fetchImpl = async url => {
    endpoints.push(new URL(url).pathname);
    if (url.endsWith('/revoke')) return new Response(JSON.stringify({ revoked: true }));
    // Simulate a file appearing after preflight and before credentials arrive.
    fs.writeFileSync(output, 'synthetic-existing-file', { mode: 0o600 });
    return new Response(JSON.stringify({ deviceId: id, name: 'fixture', token: 'b'.repeat(64) }));
  };
  await assert.rejects(runManagement(['enroll', '--name', 'fixture', '--out', '.local-run/agent.env'], {
    cwd: directory, env: { LEVERAGE_OPERATOR_TOKEN: 'synthetic-operator-secret-for-tests-only' }, fetchImpl, log: value => logs.push(value)
  }), /credential was revoked/);
  assert.deepEqual(endpoints, ['/api/admin/agents', '/api/admin/agents/revoke']);
  assert.equal(fs.readFileSync(output, 'utf8'), 'synthetic-existing-file');
  assert.equal(logs.length, 0);
});

test('management list emits only public metadata and never response credentials', async t => {
  const logs = [];
  const row = { id: '1e59fe12-249e-4cec-97db-aa6cc773a198', name: 'fixture', createdAt: '2026-10-22T12:00:00.000Z', revokedAt: null };
  await runManagement(['list'], {
    env: { LEVERAGE_OPERATOR_TOKEN: 'synthetic-operator-secret-for-tests-only' },
    fetchImpl: async () => new Response(JSON.stringify({ agents: [{ ...row, token: 'SYNTHETIC_SECRET_MUST_NOT_PRINT', tokenHash: 'c'.repeat(64) }] })),
    log: value => logs.push(value)
  });
  assert.deepEqual(JSON.parse(logs[0]), [row]);
  assert.equal(logs[0].includes('SYNTHETIC_SECRET'), false);
  assert.equal(logs[0].includes('tokenHash'), false);
});
