import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRepositoryReader, REPOSITORY_READ_LIMITS } from '../src/repository-reader.mjs';

function fixture(t, limits) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leverage-reader-'));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const write = (name, value) => {
    const filename = path.join(workspace, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, value);
    return filename;
  };
  const reader = createRepositoryReader({ workspace, limits });
  t.after(() => { reader.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, write, reader };
}
const denied = (result, code = 'repository-path-denied') => {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.deepEqual(Object.keys(result), ['ok', 'error']);
};

test('repository reader lists and reads authorized source, tests and nonsecret CI on demand', t => {
  const f = fixture(t);
  f.write('src/a.mjs', 'export function square(n) {\n  return n * n;\n}\n');
  f.write('test/a.test.mjs', 'import { test } from "node:test";\n');
  f.write('package.json', '{"type":"module"}\n');
  f.write('.github/workflows/ci.yml', 'name: CI\njobs:\n  test:\n    runs-on: ubuntu-latest\n');
  assert.equal(f.reader.stats().bytesRead, 0);
  const listing = f.reader.list({ path: '.' });
  assert.equal(listing.ok, true);
  assert.equal(f.reader.stats().bytesRead, 0, 'listing must not eagerly load file content');
  assert.deepEqual(new Set(listing.entries.map(entry => entry.name)), new Set(['src', 'test', 'package.json', '.github']));
  const result = f.reader.read({ path: 'src/a.mjs', startLine: 2, endLine: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.content, '2:   return n * n;\n3: }');
  assert.equal(result.totalLines, 3);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.truncated, false);
  assert.equal(f.reader.read({ path: '.github/workflows/ci.yml' }).ok, true);
  assert.equal(f.reader.read({ path: 'package.json' }).ok, true);
  const stats = f.reader.stats();
  assert.equal(stats.files.length, 3);
  assert.deepEqual(stats.files[0], { path: 'src/a.mjs', startLine: 2, endLine: 3, bytes: 46 });
  assert.ok(!JSON.stringify(stats).includes('return n * n'));
  stats.files[0].path = 'tampered';
  assert.equal(f.reader.stats().files[0].path, 'src/a.mjs');
});

test('repository reader hides sensitive/generated paths and blocks direct access before opening', t => {
  const f = fixture(t);
  const hidden = ['.env', '.env.example', '.env.production', '.git/config', '.local-run/agent.json',
    '.codex/auth.json', '.aws/config', '.ssh/id_rsa', '.vscode/settings.json',
    'node_modules/example/package.json', 'dist/bundle.js', 'private/notes.md', 'personal/info.json',
    'credentials.json', 'auth.json', 'secrets.yaml', 'token.json', 'config.private.json', 'my-passwords.json',
    'service-account.json', 'id_rsa', 'key.pem',
    'comenzi executate agent.md', 'RAPORT-CURATENIE.md', 'sessions/log.jsonl', 'output.log', 'image.png'];
  for (const filename of hidden) f.write(filename, 'PRIVATE_SENTINEL');
  f.write('src/credentials.mjs', 'export function checkCredential(value) { return !!value; }');
  const open = fs.openSync;
  const calls = [];
  const mocked = t.mock.method(fs, 'openSync', (filename, ...rest) => {
    calls.push(filename); return open(filename, ...rest);
  });
  for (const filename of hidden) denied(f.reader.read({ path: filename }));
  assert.equal(calls.length, 0, 'denied paths must not be opened');
  mocked.mock.restore();
  const listing = f.reader.list();
  assert.deepEqual(listing.entries, [{ name: 'src', type: 'directory' }]);
  assert.equal(f.reader.read({ path: 'src/credentials.mjs' }).ok, true);
});

test('repository reader rejects traversal, absolute, encoded, malformed and extra arguments', t => {
  const f = fixture(t);
  for (const value of ['../x.mjs', 'src/../x.mjs', '/etc/passwd', 'src//x.mjs',
    'src\\x.mjs', '%2e%2e/x.mjs', 'src/%61.mjs', 'src/./x.mjs', 'a\u0000.mjs',
    ' file.js', 'file.js ', 'é.js', 'a/'.repeat(14) + 'x.js', 'x'.repeat(513)]) {
    denied(f.reader.read({ path: value }));
  }
  for (const args of [null, [], { path: 'x.mjs', command: 'delete' }, { path: 'x.mjs', startLine: 0 },
    { path: 'x.mjs', startLine: 1, endLine: 201 }, { path: 'x.mjs', endLine: 0 }]) {
    denied(f.reader.read(args), 'repository-invalid-request');
  }
  denied(f.reader.list({ path: '.', cursor: -1 }), 'repository-invalid-request');
  denied(f.reader.list({ path: '.', cursor: 1000 }), 'repository-invalid-request');
  denied(f.reader.list({ path: '.', cwd: '/other' }), 'repository-invalid-request');
});

test('repository reader never follows file/ancestor symlinks or hardlinked private files', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'outside.mjs'), 'PRIVATE_SENTINEL');
  fs.symlinkSync(outside, path.join(f.workspace, 'link-dir'));
  fs.symlinkSync(path.join(outside, 'outside.mjs'), path.join(f.workspace, 'link.mjs'));
  fs.linkSync(path.join(outside, 'outside.mjs'), path.join(f.workspace, 'hard.mjs'));
  denied(f.reader.read({ path: 'link-dir/outside.mjs' }));
  denied(f.reader.read({ path: 'link.mjs' }));
  denied(f.reader.read({ path: 'hard.mjs' }));
  assert.deepEqual(f.reader.list().entries, []);
  assert.equal(f.reader.stats().bytesRead, 0);
});

test('descriptor traversal resists ancestor replacement by a symlink between component opens', t => {
  const f = fixture(t);
  f.write('src/nested/a.mjs', 'export const allowed = true;');
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(path.join(outside, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'nested/a.mjs'), 'PRIVATE_SENTINEL');
  const original = fs.openSync;
  let replaced = false;
  t.mock.method(fs, 'openSync', (filename, ...rest) => {
    if (!replaced && typeof filename === 'string' && filename.endsWith('/nested')) {
      replaced = true;
      fs.renameSync(path.join(f.workspace, 'src'), path.join(f.root, 'moved-src'));
      fs.symlinkSync(outside, path.join(f.workspace, 'src'));
    }
    return original(filename, ...rest);
  });
  const result = f.reader.read({ path: 'src/nested/a.mjs' });
  denied(result, 'workspace-changed');
  assert.equal(replaced, true);
  assert.equal(f.reader.stats().bytesRead, 0, 'no private content may be read after ancestry moves');
  assert.ok(!JSON.stringify(result).includes(f.root));
});

test('workspace replacement rejects reads even if the same path now has valid-looking files', t => {
  const f = fixture(t);
  f.write('a.mjs', 'export const original = true;');
  fs.renameSync(f.workspace, path.join(f.root, 'old-project'));
  fs.mkdirSync(f.workspace);
  f.write('a.mjs', 'export const replacement = true;');
  denied(f.reader.read({ path: 'a.mjs' }), 'workspace-changed');
  denied(f.reader.list(), 'workspace-changed');
});

test('whole-file sensitive detection withholds credentials and recognizable PII even outside requested lines', t => {
  const f = fixture(t);
  const privateData = [
    '-----BEGIN ' + 'PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----',
    'const key = "sk-' + 'z'.repeat(32) + '";',
    'const key = "ghp_' + 'z'.repeat(32) + '";',
    'const key = "AKIA' + 'Z'.repeat(16) + '";',
    'const key = "eyJ' + 'a'.repeat(12) + '.abc.def";',
    'Authorization: Bearer ' + 'a'.repeat(32),
    'const password = "' + 'a'.repeat(16) + '";',
    '{"agent_token":"' + 'a'.repeat(16) + '"}',
    '{"agentToken":"abc"}',
    'const clientSecret = "abc";',
    'Database: postgres://user:' + 'synthetic-password@127.0.0.1/db',
    'Contact: person@' + 'private.invalid',
    'Home: /home/' + 'synthetic-user/project',
    'Home: C:\\Users\\' + 'synthetic-user\\project',
    'Telephone: +' + '373' + '12345678',
    'Host: ' + '10.23.45.67',
    'Host: ' + '2001:db8:abcd:1234:5678:abcd:1234:5678',
  ];
  for (const [index, value] of privateData.entries()) {
    f.write('file' + index + '.md', 'Public first line\n' + value);
    const result = f.reader.read({ path: 'file' + index + '.md', startLine: 1, endLine: 1 });
    denied(result, 'repository-sensitive');
    assert.ok(!JSON.stringify(result).includes(value));
  }
  assert.equal(f.reader.stats().files.length, 0);
  f.write('config.yml', 'access_token: ' + 'a'.repeat(16));
  denied(f.reader.read({ path: 'config.yml' }), 'repository-sensitive');
  f.write('safe.json', '{"host":"127.0.0.1", "token":"<local-placeholder>"}');
  assert.equal(f.reader.read({ path: 'safe.json' }).ok, true);
  f.write('variables.mjs', "const token = generate();\nconst config = { token: env.OPERATOR_TOKEN };\nconst line = 'AGENT_TOKEN=' + generate();");
  assert.equal(f.reader.read({ path: 'variables.mjs' }).ok, true, 'source expressions are not literal credentials');
});

test('binary and invalid UTF-8 files cannot masquerade as JavaScript', t => {
  const f = fixture(t);
  for (const [index, value] of [Buffer.from([0xff, 0xfe]), Buffer.from('secret\u0000data'),
    Buffer.from('escape\u001b[31m'), Buffer.from('bidi\u202edata')].entries()) {
    f.write('binary' + index + '.js', value);
    denied(f.reader.read({ path: 'binary' + index + '.js' }), 'repository-binary');
  }
});

test('file/total/request budgets are enforced, including repeated denied attempts', t => {
  const f = fixture(t, { maxFileBytes: 30, maxTotalBytes: 50, maxRequests: 5 });
  f.write('large.mjs', 'x'.repeat(31));
  f.write('safe.mjs', 'export const value = true;');
  denied(f.reader.read({ path: 'large.mjs' }), 'repository-file-too-large');
  assert.equal(f.reader.stats().bytesRead, 0);
  assert.equal(f.reader.read({ path: 'safe.mjs' }).ok, true);
  denied(f.reader.read({ path: 'safe.mjs' }), 'repository-budget');
  denied(f.reader.read({ path: '.env' }));
  denied(f.reader.read({ path: '.env' }));
  denied(f.reader.read({ path: 'safe.mjs' }), 'repository-budget');
  assert.equal(f.reader.stats().requests, 6);
  assert.equal(f.reader.stats().bytesRead, 26);
  assert.equal(f.reader.stats().denied, 5);
});

test('bounded directory listing and line pages indicate incomplete data explicitly', t => {
  const f = fixture(t, { maxEntries: 2, maxDirectoryEntries: 5, maxLines: 2, maxOutputBytes: 32 });
  for (let index = 0; index < 8; index++) f.write('file' + index + '.mjs', 'line one\nline two\nline three\n');
  const first = f.reader.list();
  assert.equal(first.entries.length, 2);
  assert.equal(first.truncated, true);
  assert.equal(first.nextCursor, 2);
  const second = f.reader.list({ cursor: first.nextCursor });
  assert.equal(second.entries.length, 2);
  assert.equal(second.nextCursor, 4);
  const last = f.reader.list({ cursor: second.nextCursor });
  assert.equal(last.entries.length, 1);
  assert.equal(last.truncated, true);
  assert.equal(last.nextCursor, undefined, 'scan cap cannot be enlarged through pagination');
  const page = f.reader.read({ path: 'file0.mjs' });
  assert.equal(page.content, '1: line one\n2: line two');
  assert.equal(page.truncated, true);
  assert.equal(page.nextLine, 3);
  assert.equal(f.reader.read({ path: 'file0.mjs', startLine: 3 }).truncated, false);
});

test('a growing or replaced file is rejected and read results are never cached across calls', t => {
  const f = fixture(t);
  const file = f.write('a.mjs', 'export const before = true;');
  const original = fs.readSync;
  let changed = false;
  const mock = t.mock.method(fs, 'readSync', (descriptor, ...args) => {
    const result = original(descriptor, ...args);
    if (!changed) { changed = true; fs.appendFileSync(file, '\nexport const extra = true;'); }
    return result;
  });
  denied(f.reader.read({ path: 'a.mjs' }), 'repository-changed');
  mock.mock.restore();
  const after = f.reader.read({ path: 'a.mjs' });
  assert.equal(after.ok, true);
  assert.ok(after.content.includes('extra'));
  fs.writeFileSync(file, 'export const replaced = true;');
  const replaced = f.reader.read({ path: 'a.mjs' });
  assert.ok(replaced.content.includes('replaced'));
  assert.notEqual(after.sha256, replaced.sha256);
});

test('reader closure is idempotent and configuration cannot enlarge hard limits', t => {
  const f = fixture(t);
  f.reader.close(); f.reader.close();
  denied(f.reader.list(), 'repository-closed');
  for (const limits of [{ maxFileBytes: REPOSITORY_READ_LIMITS.maxFileBytes + 1 },
    { maxRequests: 0 }, { unknown: 3 }]) {
    assert.throws(() => createRepositoryReader({ workspace: f.workspace, limits }), /Invalid repository/);
  }
  assert.throws(() => createRepositoryReader({ workspace: '/' }), /Invalid repository/);
  assert.throws(() => createRepositoryReader({ workspace: 'relative' }), /Invalid repository/);
});
