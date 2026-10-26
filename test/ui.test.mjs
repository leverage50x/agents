import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/ui.mjs', import.meta.url), 'utf8');
function browser(initial, { now = Date.parse('2026-10-26T10:13:00Z') } = {}) {
  const elements = new Map();
  const calls = [];
  let polling;
  let fail = false;
  let approve = false;
  const confirmations = [];
  let current = initial;
  class BrowserDate extends Date { static now() { return now; } }
  const classes = () => {
    const values = new Set();
    return { add: x => values.add(x), remove: x => values.delete(x), contains: x => values.has(x) };
  };
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '', checked: false, disabled: false, textContent: '', className: '', classList: classes(), handlers: {},
        addEventListener(name, callback) { this.handlers[name] = callback; },
        set innerHTML(value) {
          this.html = value;
          if (['device', 'thread', 'inventory-device', 'local-device', 'local-thread', 'local-workspace'].includes(id)) this.value = /<option value="([^"]*)"/.exec(value)?.[1] || '';
        },
        get innerHTML() { return this.html || ''; }
      });
    }
    return elements.get(id);
  };
  vm.runInNewContext(source, {
    document: { getElementById: element, querySelectorAll: () => [] }, AbortSignal, Date: BrowserDate,
    confirm: message => { confirmations.push(message); return approve; },
    setInterval: callback => { polling = callback; },
    fetch: async (endpoint, options) => {
      calls.push({ endpoint, method: options.method, body: options.body });
      if (fail) throw new Error('Synthetic network error');
      return { ok: true, json: async () => current };
    }
  });
  return {
    element, calls, confirmations, approve: value => { approve = value; }, poll: () => polling(), fail: value => { fail = value; },
    state: value => { current = value; },
    advance: milliseconds => { now += milliseconds; },
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

const localThread = '11111111-1111-4111-8111-111111111111';
const localDevice = { ...device, name: 'Local laptop', localControl: true, codexAuth: 'authenticated',
  sessions: [{ id: localThread, activity: 'discovered', source: 'app-server', eligibility: 'discovered' }] };
const localState = (devices = [localDevice]) => ({ devices, jobs: [], readonlyJobs: [],
  localControl: { enabled: true, deviceId: localDevice.id, workspaces: [{ id: 'project', label: 'Personal project' }] } });
function change(b, id, value) {
  b.element(id).value = value;
  b.element(id).handlers[id === 'local-prompt' ? 'input' : 'change']();
}
function selectLocal(b, { mode = 'new', thread = '' } = {}) {
  change(b, 'local-device', localDevice.id);
  change(b, 'local-mode', mode);
  change(b, 'local-workspace', 'project');
  if (thread) change(b, 'local-thread', thread);
  change(b, 'local-prompt', 'Inspect the project without changing files.');
}
function confirmLocal(b) {
  b.element('local-confirm').checked = true;
  b.element('local-confirm').handlers.change();
}
const submitLocal = b => b.element('local-form').handlers.submit({ preventDefault() {} });
const localRequests = b => b.calls.filter(call => call.endpoint === '/api/local/task');

test('local control never auto-selects device, mode, workspace or session and requires both confirmations', async () => {
  const b = browser(localState());
  await b.login();
  for (const id of ['local-device', 'local-mode', 'local-workspace', 'local-thread']) assert.equal(b.element(id).value, '');
  assert.equal(b.element('local-submit').disabled, true);
  await submitLocal(b);
  assert.equal(localRequests(b).length, 0);
  selectLocal(b);
  assert.equal(b.element('local-thread').disabled, true);
  assert.equal(b.element('local-submit').disabled, true);
  await submitLocal(b);
  assert.equal(b.confirmations.length, 0);
  confirmLocal(b);
  assert.equal(b.element('local-submit').disabled, false);
  await submitLocal(b);
  assert.equal(b.confirmations.length, 1);
  assert.ok(b.confirmations[0].includes('REAL LOCAL READ-ONLY'));
  assert.equal(localRequests(b).length, 0);
  assert.equal(b.element('local-confirm').checked, false);
});

test('local New sends exactly the selected context after explicit approval and clears one-turn confirmation', async () => {
  const b = browser(localState());
  await b.login();
  selectLocal(b);
  confirmLocal(b);
  b.approve(true);
  await submitLocal(b);
  assert.equal(localRequests(b).length, 1);
  assert.deepEqual(JSON.parse(localRequests(b)[0].body), {
    deviceId: localDevice.id, mode: 'new', threadId: null, workspaceId: 'project',
    prompt: 'Inspect the project without changing files.', confirmed: true
  });
  assert.equal(b.element('local-prompt').value, '');
  assert.equal(b.element('local-confirm').checked, false);
  assert.equal(b.element('local-submit').disabled, true);
  assert.ok(b.element('local-message').textContent.includes('Follow progress'));
  assert.equal(b.calls.filter(call => call.method === 'POST' && call.endpoint === '/api/task').length, 0);
});

test('local Resume requires an explicitly chosen device-scoped session and rejects busy or foreign sessions', async () => {
  const remote = { ...device, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Remote laptop',
    codexAuth: 'authenticated', localControl: true, sessions: [{ id: '22222222-2222-4222-8222-222222222222' }] };
  const b = browser(localState([localDevice, remote]));
  await b.login();
  selectLocal(b, { mode: 'resume' });
  assert.equal(b.element('local-thread').value, '');
  assert.ok(b.element('local-thread').innerHTML.includes('Discovered — resume not yet verified'));
  confirmLocal(b);
  await submitLocal(b);
  assert.equal(localRequests(b).length, 0);
  change(b, 'local-thread', remote.sessions[0].id);
  confirmLocal(b);
  await submitLocal(b);
  assert.equal(localRequests(b).length, 0);
  change(b, 'local-thread', localThread);
  confirmLocal(b);
  b.approve(true);
  await submitLocal(b);
  assert.equal(JSON.parse(localRequests(b)[0].body).threadId, localThread);
  assert.ok(b.confirmations[0].includes('Resume ' + localThread));
  change(b, 'local-device', remote.id);
  assert.equal(b.element('local-mode').value, '');
  assert.equal(b.element('local-workspace').value, '');
  assert.equal(b.element('local-thread').value, '');
  assert.equal(b.element('local-submit').disabled, true);
  assert.ok(b.element('local-control-status').textContent.includes('inventory-only'));

  const busy = { ...localDevice, sessions: [{ ...localDevice.sessions[0], eligibility: 'busy' }] };
  b.state(localState([busy]));
  await b.poll();
  selectLocal(b, { mode: 'resume', thread: localThread });
  assert.match(b.element('local-thread').innerHTML, /" disabled(?:\s|>)/);
  confirmLocal(b);
  await submitLocal(b);
  assert.equal(localRequests(b).length, 1);
});

test('local control fails closed for auth changes, offline, revoked, absent capability and disconnected Hub', async () => {
  for (const [patch, label] of [
    [{ codexAuth: 'not-authenticated' }, 'Not authenticated'],
    [{ codexAuth: 'unavailable' }, 'Unavailable'],
    [{ online: false }, 'offline'],
    [{ revokedAt: '2026-10-23T00:00:00Z' }, 'revoked'],
    [{ localControl: false }, 'inventory-only']
  ]) {
    const b = browser(localState([{ ...localDevice, ...patch }]));
    await b.login();
    selectLocal(b);
    confirmLocal(b);
    b.approve(true);
    await submitLocal(b);
    assert.equal(b.element('local-submit').disabled, true);
    assert.ok(b.element('local-control-status').textContent.includes(label));
    assert.equal(localRequests(b).length, 0);
  }
  const b = browser(localState());
  await b.login();
  selectLocal(b);
  confirmLocal(b);
  b.fail(true);
  await b.poll();
  b.approve(true);
  await submitLocal(b);
  assert.equal(localRequests(b).length, 0);
  assert.equal(b.element('local-submit').disabled, true);
  assert.equal(b.element('local-device').disabled, true);
});

test('local control rejects unknown workspaces and changed selections invalidate checkbox approval', async () => {
  const b = browser(localState());
  await b.login();
  selectLocal(b);
  confirmLocal(b);
  change(b, 'local-prompt', 'A changed read-only instruction');
  assert.equal(b.element('local-confirm').checked, false);
  change(b, 'local-workspace', 'not-configured');
  confirmLocal(b);
  b.approve(true);
  await submitLocal(b);
  assert.equal(localRequests(b).length, 0);
  b.state({ ...localState(), localControl: { ...localState().localControl, enabled: false } });
  await b.poll();
  assert.equal(b.element('local-submit').disabled, true);
  assert.ok(b.element('local-control-status').textContent.includes('disabled'));
});

test('local progress, final answers, authentication labels and session eligibility render safely', async () => {
  const initial = localState();
  initial.readonlyJobs = [{ id: 'local-job', deviceId: localDevice.id, mode: 'resume', threadId: localThread,
    workspaceId: 'project', prompt: '<script>instruction</script>', status: 'running', createdAt: 'synthetic',
    events: [{ type: '<b>progress</b>', message: '<img src=x onerror=alert(1)>' }], output: '' }];
  const b = browser(initial);
  await b.login();
  assert.ok(b.element('devices').innerHTML.includes('Codex authenticated'));
  assert.ok(b.element('local-jobs').innerHTML.includes('running'));
  assert.equal(b.element('local-jobs').innerHTML.includes('<script>'), false);
  assert.equal(b.element('local-jobs').innerHTML.includes('<img'), false);
  assert.ok(b.element('local-jobs').innerHTML.includes('&lt;b&gt;progress&lt;/b&gt;'));
  const final = { ...initial, readonlyJobs: [{ ...initial.readonlyJobs[0], status: 'completed', output: '<script>final answer</script>' }] };
  b.state(final);
  await b.poll();
  assert.ok(b.element('local-jobs').innerHTML.includes('completed'));
  assert.ok(b.element('local-jobs').innerHTML.includes('&lt;script&gt;final answer&lt;/script&gt;'));
  assert.equal(b.element('local-jobs').innerHTML.includes('<script>'), false);
  b.state({ ...initial, readonlyJobs: [{ ...initial.readonlyJobs[0], status: 'failed', errorCode: 'agent-revoked' }] });
  await b.poll();
  assert.ok(b.element('local-jobs').innerHTML.includes('Error: <code>agent-revoked</code>'));
  b.state({ ...initial, readonlyJobs: [{ ...initial.readonlyJobs[0], status: 'failed', errorCode: '<script>controller-unavailable</script>' }] });
  await b.poll();
  assert.ok(b.element('local-jobs').innerHTML.includes('&lt;script&gt;controller-unavailable&lt;/script&gt;'));
  assert.equal(b.element('local-jobs').innerHTML.includes('<script>'), false);
  assert.ok(b.element('sessions').innerHTML.includes('Discovered — resume not yet verified'));
  b.state(localState([{ ...localDevice, codexAuth: 'not-authenticated', sessions: [{ ...localDevice.sessions[0], eligibility: 'confirmed' }] }]));
  await b.poll();
  assert.ok(b.element('devices').innerHTML.includes('Not authenticated'));
  assert.ok(b.element('sessions').innerHTML.includes('Not authenticated — Resume unavailable'));
  b.state(localState([{ ...localDevice, codexAuth: 'unavailable' }]));
  await b.poll();
  assert.ok(b.element('devices').innerHTML.includes('Unavailable'));
});

test('session inventory shows metadata title and relative activity with project, full ID and absolute time in details', async () => {
  const reported = { ...localDevice, sessions: [{ ...localDevice.sessions[0], title: '<script>README review</script>', project: '<b>Personal project</b>',
    lastActivity: '2026-10-26T09:15:00Z', modified: '2026-10-26T09:16:00Z' }] };
  const b = browser(localState([reported]));
  await b.login();
  const html = b.element('sessions').innerHTML;
  assert.ok(html.includes('&lt;b&gt;Personal project&lt;/b&gt;'));
  assert.equal(html.includes('<b>Personal project</b>'), false);
  assert.ok(html.includes('&lt;script&gt;README review&lt;/script&gt;'));
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('<span class="session-age">58m ago</span>'));
  assert.ok(html.includes('aria-label="Full session ID: ' + localThread + '"'));
  assert.ok(html.includes('<summary>Session details</summary>'));
  assert.ok(html.indexOf('<details') < html.indexOf('<dt>Session ID</dt>'));
  assert.ok(html.indexOf('<details') < html.indexOf('2026-10-26T09:15:00.000Z'));
  assert.ok(html.includes('2026-10-26T09:15:00.000Z'));
  assert.ok(html.includes('Discovered — resume not yet verified'));
  b.state(localState([{ ...reported, online: false }]));
  await b.poll();
  assert.ok(b.element('sessions').innerHTML.includes('Device offline or revoked — Resume unavailable'));
  b.state({ devices: [{ ...reported, localControl: false }], jobs: [] });
  await b.poll();
  assert.ok(b.element('sessions').innerHTML.includes('Inventory only — local Resume unavailable'));
});

test('Resume choices show metadata title and relative time without selecting any session after polling', async () => {
  const reported = { ...localDevice, sessions: [{ ...localDevice.sessions[0], title: 'Review <README>', project: 'Personal project',
    eligibility: 'confirmed', lastActivity: '2026-10-26T09:15:00Z' }] };
  const b = browser(localState([reported]));
  await b.login();
  selectLocal(b, { mode: 'resume' });
  let options = b.element('local-thread').innerHTML;
  assert.ok(options.includes('Review &lt;README&gt; · 58m ago'));
  assert.ok(options.includes('Full session ID: ' + localThread));
  assert.ok(options.includes('Loaded by this app — Resume will be rechecked'));
  assert.equal(b.element('local-thread').value, '');
  await b.poll();
  assert.equal(b.element('local-thread').value, '');
  b.advance(120000);
  await b.poll();
  assert.ok(b.element('local-thread').innerHTML.includes('Review &lt;README&gt; · 1h ago'));
  assert.equal(b.element('local-thread').value, '');
  change(b, 'local-thread', localThread);
  assert.ok(b.element('local-selection-summary').textContent.includes('Review <README> · 1h ago'));
  assert.ok(b.element('local-selection-summary').textContent.includes('Resume will be rechecked'));
  change(b, 'local-mode', 'new');
  await b.poll();
  assert.equal(b.element('local-thread').value, '');
  assert.ok(b.element('local-selection-summary').textContent.includes('no existing session will be resumed'));
  assert.equal(localRequests(b).length, 0);
});

test('relative labels handle recent, hourly, missing and future timestamps without inventing session titles', async () => {
  const now = Date.parse('2026-10-26T10:13:00Z');
  const sessions = [
    { id: 'recent', title: 'Just arrived', lastActivity: new Date(now - 30000).toISOString() },
    { id: 'minutes', title: 'Earlier review', lastActivity: new Date(now - 58 * 60000).toISOString() },
    { id: 'hours', title: 'Older review', lastActivity: new Date(now - 2 * 3600000).toISOString() },
    { id: 'missing', project: 'Do not use project as title', preview: 'SYNTHETIC_PREVIEW_MUST_NOT_RENDER', modified: new Date(now).toISOString() },
    { id: 'invalid', title: ' ', lastActivity: 'invalid' },
    { id: 'future', title: 'Future metadata', lastActivity: new Date(now + 60000).toISOString() }
  ];
  const b = browser(localState([{ ...localDevice, sessions }]), { now });
  await b.login();
  const html = b.element('sessions').innerHTML;
  assert.ok(html.includes('just now'));
  assert.ok(html.includes('58m ago'));
  assert.ok(html.includes('2h ago'));
  assert.ok(html.includes('<h3 title="Untitled session">Untitled session</h3>'));
  assert.ok(html.includes('Last known activity</dt><dd>Unknown'));
  assert.ok(html.includes('Future timestamp'));
  assert.equal(html.includes('SYNTHETIC_PREVIEW_MUST_NOT_RENDER'), false);
  assert.equal(html.includes('<h3 title="Do not use project as title"'), false);
  assert.equal(localRequests(b).length, 0);
});

test('visible titles shorten by Unicode code points while full metadata title stays in session details', async () => {
  const title = '😀'.repeat(10) + 'x'.repeat(70);
  const b = browser(localState([{ ...localDevice, sessions: [{ ...localDevice.sessions[0], title }] }]));
  await b.login();
  const heading = /<h3 title="[^"]*">([^<]*)<\/h3>/.exec(b.element('sessions').innerHTML)?.[1];
  assert.equal(heading, '😀'.repeat(10) + 'x'.repeat(54) + '…');
  assert.ok(b.element('sessions').innerHTML.includes('<dt>Title</dt><dd>' + title + '</dd>'));
});

test('Cwd + Active explains non-archived metadata and filename fallback never claims CLI parity', async () => {
  const scoped = { ...localDevice, sessionInventory: { status: 'available', source: 'app-server', truncated: false } };
  const b = browser(localState([scoped]));
  await b.login();
  assert.equal(b.element('inventory-filter').textContent, 'Cwd + Active · Read-only inventory');
  assert.ok(b.element('inventory-filter-note').textContent.includes('non-archived sessions'));
  assert.ok(b.element('inventory-filter-note').textContent.includes('does not mean a Codex process is running'));
  b.state(localState([{ ...scoped, sessionInventory: { status: 'available', source: 'files', truncated: false } }]));
  await b.poll();
  assert.equal(b.element('inventory-filter').textContent, 'Unverified filename inventory');
  assert.ok(b.element('inventory-filter-note').textContent.includes('cannot confirm workspace, archive status'));
  b.state(localState([{ ...scoped, workspaceReady: false }]));
  await b.poll();
  assert.equal(b.element('inventory-filter').textContent, 'Read-only inventory');
});

test('local errors explain busy, unverified, unavailable, unsupported and authentication states distinctly', async () => {
  const b = browser(localState());
  await b.login();
  const messages = {
    'codex-busy': 'Session or workspace in use by another Codex process. Finish that activity before trying Resume.',
    'session-activity-unverified': 'Session activity could not be verified.',
    'session-unavailable': 'The session is no longer available in the selected workspace.',
    'codex-version-unsupported': 'The installed Codex CLI version is unsupported.',
    'codex-not-authenticated': 'Codex authentication could not be confirmed.',
    'codex-policy-mismatch': 'Local safety settings could not be verified.',
    'codex-request-rejected': 'Codex rejected the local request.'
  };
  for (const [errorCode, message] of Object.entries(messages)) {
    b.state({ ...localState(), readonlyJobs: [{ id: 'synthetic-error', deviceId: localDevice.id,
      status: 'failed', mode: 'resume', threadId: localThread, workspaceId: 'project', errorCode }] });
    await b.poll();
    assert.ok(b.element('local-jobs').innerHTML.includes(message));
    assert.ok(b.element('local-jobs').innerHTML.includes('<code>' + errorCode + '</code>'));
  }
  assert.equal(localRequests(b).length, 0);
});
