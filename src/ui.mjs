const $ = id => document.getElementById(id);
let secret = '';
let state = { devices: [], jobs: [] };
let connected = false;
let busy = false;
let refreshing = false;
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function controls() {
  const available = connected && state.devices.some(d => d.online);
  for (const id of ['device', 'thread', 'prompt', 'submit']) $(id).disabled = !available || busy;
  for (const button of document.querySelectorAll('#jobs button')) button.disabled = !connected || busy;
}
function connection(ok, message) {
  connected = ok;
  $('connection').textContent = message;
  $('connection').className = ok ? 'on' : 'off';
  controls();
}
async function api(method, pathname, body) {
  let result;
  try {
    result = await fetch(pathname, {
      method, headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000), redirect: 'error'
    });
  } catch { throw new Error('Local hub unavailable.'); }
  let data;
  try { data = await result.json(); } catch { throw new Error('Invalid hub response.'); }
  if (!result.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function renderThreads() {
  const device = state.devices.find(d => d.id === $('device').value);
  const previous = $('thread').value;
  $('thread').innerHTML = '<option value="">Without thread ID (DEMO)</option>' +
    (device?.sessions || []).map(s => '<option value="' + escape(s.id) + '">' + escape(s.id) + '</option>').join('');
  if (device?.sessions.some(s => s.id === previous)) $('thread').value = previous;
}
function render() {
  $('device-count').textContent = '(' + state.devices.filter(d => d.online).length + ' online / ' + state.devices.length + ')';
  $('devices').innerHTML = state.devices.length ? state.devices.map(d =>
    '<div class="device"><h3>' + escape(d.name) + ' <small class="' + (d.online ? 'on' : 'off') + '">' +
    (d.online ? '● online' : '○ offline') + '</small></h3><small>' + escape(d.platform) +
    ' · Remote AI execution: disabled · DEMO ONLY · ' + (d.workspaceReady ? 'Workspace verified' : 'Workspace missing or invalid') +
    '</small><p><b>Configured MCP (' + d.mcp.servers.length + ')</b> <small>— ' + escape(d.mcp.status) +
    '; NOT verified live</small></p><div class="chips">' + (d.mcp.servers.map(s =>
      '<span class="chip">' + escape(s) + '</span>').join('') || '<small>None found</small>') +
    '</div><p><b>Discovered thread IDs (' + d.sessions.length + ')</b></p><small>Inventory: ' +
    escape(d.sessionInventory?.status || 'unknown') + (d.sessionInventory?.truncated ? ' · scan incomplete' : '') +
    ' · activity and resume NOT verified</small><div class="chips">' + (d.sessions.slice(0, 8).map(s =>
      '<span class="chip" title="' + escape(s.id + ' · ' + s.modified) + '">' + escape(s.id.slice(0, 8)) +
      '</span>').join('') || '<small>None found</small>') + '</div></div>'
  ).join('') : '<p class="muted">No local agent registered. Start the agent on this computer.</p>';
  const current = $('device').value;
  $('device').innerHTML = state.devices.filter(d => d.online).map(d =>
    '<option value="' + escape(d.id) + '">' + escape(d.name) + '</option>').join('');
  if (state.devices.some(d => d.id === current && d.online)) $('device').value = current;
  renderThreads();
  $('jobs').innerHTML = state.jobs.length ? state.jobs.map(j =>
    '<div class="job"><b>' + escape(j.status) + '</b> · ' +
    escape(state.devices.find(d => d.id === j.deviceId)?.name || j.deviceId) + '<br><small>' +
    escape(j.createdAt) + ' · reference ID ' + escape(j.resultThreadId || j.threadId || 'none') +
    '</small><p>' + escape(j.prompt) + '</p>' + (j.status === 'pending_approval' ?
      '<button class="approve-job" data-id="' + escape(j.id) + '">Approve DEMO task</button> ' +
      '<button class="reject-job" data-id="' + escape(j.id) + '">Reject</button>' : '') +
    (j.output ? '<pre>' + escape(j.output) + '</pre>' : '') + '</div>'
  ).join('') : '<p class="muted">No jobs yet.</p>';
  controls();
}
async function refresh() {
  if (!secret || refreshing) return;
  refreshing = true;
  try { state = await api('GET', '/api/state'); connection(true, 'Connected · localhost DEMO'); render(); }
  catch (error) { connection(false, error.message); }
  finally { refreshing = false; }
}
$('login').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  $('login').disabled = true;
  secret = $('token').value.trim();
  try {
    state = await api('GET', '/api/state');
    $('connect').classList.add('hidden');
    $('main').classList.remove('hidden');
    $('token').value = '';
    connection(true, 'Connected · localhost DEMO');
    render();
  } catch (error) { secret = ''; connection(false, error.message); }
  finally { busy = false; $('login').disabled = false; controls(); }
});
$('device').addEventListener('change', renderThreads);
$('form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!connected || busy || !state.devices.some(d => d.online && d.id === $('device').value)) {
    $('message').textContent = 'Connect to the local hub and select an online device.';
    return;
  }
  busy = true;
  controls();
  try {
    await api('POST', '/api/task', {
      deviceId: $('device').value, threadId: $('thread').value || null, prompt: $('prompt').value
    });
    $('message').textContent = 'Instruction submitted for explicit DEMO approval.';
    $('prompt').value = '';
    await refresh();
  } catch (error) { $('message').textContent = error.message; await refresh(); }
  finally { busy = false; controls(); }
});
$('jobs').addEventListener('click', async event => {
  const button = event.target.closest('button[data-id]');
  if (!button || !connected || busy) return;
  const action = button.classList.contains('approve-job') ? 'approve' : 'reject';
  const job = state.jobs.find(j => j.id === button.dataset.id);
  if (!job) return;
  if (action === 'approve' && !confirm('Approve this DEMO instruction?\n\n' + job.prompt +
      '\n\nNo real Codex or shell execution will occur.')) return;
  busy = true;
  controls();
  try { await api('POST', '/api/task/' + action, { jobId: job.id }); await refresh(); }
  catch (error) { $('message').textContent = error.message; await refresh(); }
  finally { busy = false; controls(); }
});
controls();
setInterval(refresh, 4000);
