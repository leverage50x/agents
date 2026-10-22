import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/ui.mjs', import.meta.url), 'utf8');
function browser(initial) {
  const elements = new Map();
  const calls = [];
  let polling;
  let fail = false;
  let current = initial;
  const classes = () => {
    const values = new Set();
    return { add: x => values.add(x), remove: x => values.delete(x), contains: x => values.has(x) };
  };
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '', disabled: false, textContent: '', className: '', classList: classes(), handlers: {},
        addEventListener(name, callback) { this.handlers[name] = callback; },
        set innerHTML(value) {
          this.html = value;
          if (id === 'device' || id === 'thread' || id === 'inventory-device') this.value = /<option value="([^"]*)"/.exec(value)?.[1] || '';
        },
        get innerHTML() { return this.html || ''; }
      });
    }
    return elements.get(id);
  };
  vm.runInNewContext(source, {
    document: { getElementById: element, querySelectorAll: () => [] }, AbortSignal,
    confirm: () => false,
    setInterval: callback => { polling = callback; },
    fetch: async (endpoint, options) => {
      calls.push({ endpoint, method: options.method, body: options.body });
      if (fail) throw new Error('Synthetic network error');
      return { ok: true, json: async () => current };
    }
  });
  return {
    element, calls, poll: () => polling(), fail: value => { fail = value; },
    state: value => { current = value; },
    login: async () => { element('token').value = 'synthetic-browser-token-not-a-real-secret'; await element('login').handlers.click(); }
  };
}
const device = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '<script>synthetic</script>', platform: 'linux', online: true,
  lastSeen: 1700000000000,
  workspaceReady: true, mcp: { status: 'configured-only', servers: ['<b>server</b>'] },
  sessions: [], sessionInventory: { status: 'available', truncated: true }
};

test('UI blocks submission until connected and after a network failure', async () => {
  const b = browser({ devices: [device], jobs: [] });
  assert.equal(b.element('submit').disabled, true);
  await b.element('form').handlers.submit({ preventDefault() {} });
  assert.equal(b.calls.length, 0);
  await b.login();
  assert.equal(b.element('submit').disabled, false);
  assert.equal(b.element('token').value, '');
  b.fail(true);
  await b.poll();
  assert.equal(b.element('submit').disabled, true);
  const before = b.calls.length;
  await b.element('form').handlers.submit({ preventDefault() {} });
  assert.equal(b.calls.length, before);
  b.fail(false);
  await b.poll();
  assert.equal(b.element('submit').disabled, false);
});

test('UI escapes inventory and marks incomplete scans; offline devices disable submission', async () => {
  const b = browser({ devices: [device], jobs: [] });
  await b.login();
  assert.equal(b.element('devices').innerHTML.includes('<script>'), false);
  assert.ok(b.element('devices').innerHTML.includes('&lt;script&gt;'));
  assert.ok(b.element('devices').innerHTML.includes('&lt;b&gt;server&lt;/b&gt;'));
  assert.ok(b.element('devices').innerHTML.includes('scan incomplete'));
  b.state({ devices: [{ ...device, online: false }], jobs: [] });
  await b.poll();
  assert.equal(b.element('submit').disabled, true);
});

test('UI sends no approval when the explicit confirmation is declined', async () => {
  const job = { id: 'synthetic-job', deviceId: device.id, prompt: 'Demo', status: 'pending_approval', createdAt: 'synthetic', output: '' };
  const b = browser({ devices: [device], jobs: [job] });
  await b.login();
  const button = { dataset: { id: job.id }, classList: { contains: name => name === 'approve-job' } };
  await b.element('jobs').handlers.click({ target: { closest: () => button } });
  assert.equal(b.calls.filter(x => x.method === 'POST').length, 0);
});

test('UI scopes read-only sessions by persistent ID even when devices have identical names', async () => {
  const first = { ...device, name: 'Laptop', sessions: [{ id: 'thread-one', activity: 'discovered', source: 'app-server', project: 'project-one', modified: '2026-10-21T10:00:00Z', lastActivity: '2026-10-21T09:59:00Z' }] };
  const second = { ...device, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Laptop', sessions: [{ id: 'thread-two', activity: 'discovered', source: 'files', modified: '2026-10-20T08:00:00Z' }] };
  const b = browser({ devices: [first, second], jobs: [] });
  await b.login();
  assert.ok(b.element('inventory-device').innerHTML.includes(first.id));
  assert.ok(b.element('inventory-device').innerHTML.includes(second.id));
  assert.ok(b.element('sessions').innerHTML.includes('thread-one'));
  assert.equal(b.element('sessions').innerHTML.includes('thread-two'), false);
  assert.ok(b.element('sessions').innerHTML.includes('project-one'));
  assert.ok(b.element('sessions').innerHTML.includes('2026-10-21T09:59:00.000Z'));
  assert.ok(b.element('sessions').innerHTML.includes('Discovered only — activity unconfirmed'));
  b.element('inventory-device').value = second.id;
  b.element('inventory-device').handlers.change();
  assert.ok(b.element('sessions').innerHTML.includes('thread-two'));
  assert.equal(b.element('sessions').innerHTML.includes('thread-one'), false);
  assert.ok(b.element('sessions').innerHTML.includes('Session filename inventory'));
  assert.ok(b.element('sessions').innerHTML.includes('Last known activity</dt><dd>Unknown'));
  await b.poll();
  assert.equal(b.element('inventory-device').value, second.id);
  assert.ok(b.element('sessions').innerHTML.includes('thread-two'));
  assert.equal(b.calls.filter(x => x.method === 'POST').length, 0);
});

test('UI escapes scoped session fields and preserves offline inventory without enabling tasks', async () => {
  const session = { id: '<img src=x onerror=alert(1)>', project: '<script>project</script>', source: 'files', modified: 'not-a-time' };
  const b = browser({ devices: [{ ...device, online: false, sessions: [session] }], jobs: [] });
  await b.login();
  assert.equal(b.element('submit').disabled, true);
  assert.equal(b.element('inventory-device').disabled, false);
  assert.ok(b.element('inventory-status').textContent.includes('Offline — last reported inventory'));
  assert.ok(b.element('inventory-status').textContent.includes('2023-11-14T22:13:20.000Z'));
  assert.equal(b.element('sessions').innerHTML.includes('<img'), false);
  assert.equal(b.element('sessions').innerHTML.includes('<script>'), false);
  assert.ok(b.element('sessions').innerHTML.includes('&lt;script&gt;project&lt;/script&gt;'));
  assert.ok(b.element('sessions').innerHTML.includes('&lt;img'));
  assert.ok(b.element('sessions').innerHTML.includes('Last modified metadata</dt><dd>Unknown'));
  b.fail(true);
  await b.poll();
  assert.equal(b.element('inventory-device').disabled, true);
  assert.ok(b.element('inventory-status').textContent.includes('Hub disconnected — last reported inventory'));
});

test('UI excludes revoked devices from DEMO tasks while retaining their read-only inventory', async () => {
  const revoked = { ...device, revokedAt: '2026-10-22T08:00:00Z', sessions: [{ id: 'old-thread', activity: 'discovered' }] };
  const b = browser({ devices: [revoked], jobs: [] });
  await b.login();
  assert.equal(b.element('device').innerHTML, '');
  assert.equal(b.element('submit').disabled, true);
  assert.ok(b.element('inventory-status').textContent.includes('Revoked'));
  assert.ok(b.element('sessions').innerHTML.includes('old-thread'));
  await b.element('form').handlers.submit({ preventDefault() {} });
  assert.equal(b.calls.filter(x => x.method === 'POST').length, 0);
});
