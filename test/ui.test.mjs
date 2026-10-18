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
          if (id === 'device' || id === 'thread') this.value = /<option value="([^"]*)"/.exec(value)?.[1] || '';
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
      calls.push({ endpoint, method: options.method });
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
  id: 'a'.repeat(20), name: '<script>synthetic</script>', platform: 'linux', online: true,
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
