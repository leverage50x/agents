import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseMcpNames, listMcp, listSessionIds, listSessionInventory} from '../src/inventory.mjs';
import fs from 'node:fs';
import {fixture} from '../test-support/fixtures.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';import os from 'node:os';
test('MCP inventory extracts names but not secrets, commands or env',()=>{
  const names=parseMcpNames('[mcp_servers.burp]\ncommand="java"\npassword="secret"\n[mcp_servers."dev docs"]\nurl="https://docs.example.org/mcp"\n');
  assert.deepEqual(names,['burp','dev docs']);
});

test('MCP names exclude multiline values, deduplicate and remain configured-only', t => {
  const f = fixture(t);
  const text = 'notes = """\n[mcp_servers.fake]\n"""\n[mcp_servers.real]\n[mcp_servers."dev docs"] # comment\n[mcp_servers.real]\n';
  assert.deepEqual(parseMcpNames(text), ['dev docs', 'real']);
  assert.deepEqual(listMcp(f.home), { status: 'no-config', servers: [] });
  fs.writeFileSync(path.join(f.home, 'config.toml'), text);
  assert.deepEqual(listMcp(f.home), { status: 'configured-only', servers: ['dev docs', 'real'] });
  fs.unlinkSync(path.join(f.home, 'config.toml'));
  fs.symlinkSync(path.join(f.root, 'missing'), path.join(f.home, 'config.toml'));
  assert.equal(listMcp(f.home).status, 'unavailable');
});

test('session scan distinguishes missing and invalid roots and ignores symlinks', t => {
  const f = fixture(t);
  assert.equal(listSessionInventory(f.home).status, 'missing');
  fs.symlinkSync(f.workspace, path.join(f.home, 'sessions'));
  assert.equal(listSessionInventory(f.home).status, 'unavailable');
  assert.throws(() => listSessionInventory(f.home, -1), /limit/);
  assert.throws(() => listSessionInventory(f.home, 41), /limit/);
});

test('sessions deduplicate UUIDs, sort metadata and never read transcript contents', t => {
  const f = fixture(t);
  const sessions = path.join(f.home, 'sessions');
  fs.mkdirSync(sessions);
  const id = '01a0f2f7-6fa5-7f72-999c-8522c8196a4f';
  const older = path.join(sessions, 'old-' + id + '.jsonl');
  const newer = path.join(sessions, 'new-' + id.toUpperCase() + '.jsonl');
  fs.writeFileSync(older, 'PRIVATE_SYNTHETIC_TRANSCRIPT');
  fs.writeFileSync(newer, 'PRIVATE_SYNTHETIC_TRANSCRIPT');
  fs.utimesSync(older, 1000, 1000);
  fs.utimesSync(newer, 2000, 2000);
  fs.symlinkSync(older, path.join(sessions, 'link-00000000-0000-0000-0000-000000000000.jsonl'));
  const read = t.mock.method(fs, 'readFileSync', () => { throw new Error('Transcript content must not be read.'); });
  const result = listSessionInventory(f.home);
  assert.equal(read.mock.callCount(), 0);
  assert.deepEqual(result.sessions, [{ id, modified: new Date(2000000).toISOString() }]);
  assert.equal(result.status, 'available');
  assert.equal(result.truncated, false);
  assert.deepEqual(listSessionIds(f.home, 0), []);
});

test('session scan considers more than 500 files and reports bounded scans', t => {
  const f = fixture(t);
  const sessions = path.join(f.home, 'sessions');
  fs.mkdirSync(sessions);
  let newest;
  for (let i = 0; i < 510; i++) {
    const id = i.toString(16).padStart(8, '0') + '-0000-0000-0000-000000000000';
    const file = path.join(sessions, 'rollout-' + id + '.jsonl');
    fs.writeFileSync(file, '');
    fs.utimesSync(file, 1000 + i, 1000 + i);
    newest = id;
  }
  assert.equal(listSessionIds(f.home, 1)[0].id, newest);
  assert.equal(listSessionInventory(f.home).sessions.length, 40);
  assert.equal(listSessionInventory(f.home).truncated, false);
  assert.equal(listSessionInventory(f.home, 40, { maxEntries: 2 }).truncated, true);
});

test('scan reports unreadable subdirectories without claiming a complete inventory', t => {
  const f = fixture(t);
  const sessions = path.join(f.home, 'sessions');
  const blocked = path.join(sessions, 'blocked');
  fs.mkdirSync(blocked, { recursive: true });
  const original = fs.opendirSync;
  t.mock.method(fs, 'opendirSync', function (name, ...args) {
    if (name === blocked) throw Object.assign(new Error('Synthetic permission error'), { code: 'EACCES' });
    return original.call(this, name, ...args);
  });
  assert.equal(listSessionInventory(f.home).status, 'partial');
  t.mock.restoreAll();
  t.mock.method(fs, 'opendirSync', () => { throw Object.assign(new Error('Synthetic root permission error'), { code: 'EACCES' }); });
  assert.equal(listSessionInventory(f.home).status, 'unavailable');
});
test('sessions inventory reads filenames only',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'leverage50xagents-'));
  try{
    mkdirSync(path.join(root,'sessions','2026','10','14'),{recursive:true});
    writeFileSync(path.join(root,'config.toml'),'[mcp_servers.burp]\nsecret="NEVER_EXPOSE"');
    const id='01a0f2f7-6fa5-7f72-999c-8522c8196a4f';
    writeFileSync(path.join(root,'sessions','2026','10','14',`rollout-test-${id}.jsonl`),'secret payload');
    assert.deepEqual(listMcp(root).servers,['burp']);
    assert.equal(listSessionIds(root)[0].id,id);
    assert.equal(JSON.stringify(listSessionIds(root)).includes('secret payload'),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
