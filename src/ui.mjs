const $ = id => document.getElementById(id);
let secret = '';
let state = { devices: [], readonlyJobs: [] };
let connected = false;
let busy = false;
let refreshing = false;
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const online = device => device.online && !device.revokedAt;
const deviceLabel = device => device.name + ' · ' + device.id;
const sessionTitle = session => typeof session.title === 'string' && session.title.trim() ? session.title.trim() : 'Untitled session';
const shortTitle = session => {
  const characters = Array.from(sessionTitle(session));
  return characters.length > 64 ? characters.slice(0, 64).join('') + '…' : characters.join('');
};
const authLabel = value => value === 'authenticated' ? 'Codex authenticated' : value === 'not-authenticated' ? 'Not authenticated' : 'Unavailable';
const localDevice = () => state.devices.find(device => device.id === $('local-device').value);
function resumeLabel(session) {
  if (session.eligibility === 'busy') return 'Busy — unavailable';
  return 'Discovered — resume not yet verified';
}
function resumeAvailability(device, session) {
  if (!connected) return 'Hub disconnected — Resume unavailable';
  if (!online(device)) return 'Device offline or revoked — Resume unavailable';
  if (!state.localControl?.enabled || device.id !== state.localControl.deviceId || !device.localControl) {
    return 'Inventory only — local Resume unavailable';
  }
  if (device.codexAuth !== 'authenticated') return authLabel(device.codexAuth) + ' — Resume unavailable';
  return resumeLabel(session);
}
const localErrors = {
  'codex-busy': 'The selected session is still loaded by another Codex client, or this app already has a running turn. An idle CLI or editor can keep its native lock; release the session in its owning client, then explicitly retry.',
  'codex-cleanup-unconfirmed': 'The app could not confirm that its Codex worker exited. Further turns are blocked; inspect the local agent before an explicit restart.',
  'session-unavailable': 'The session is no longer available in the selected workspace. Refresh inventory or choose New.',
  'codex-version-unsupported': 'The installed Codex CLI version is unsupported. Check the supported version before retrying local control.',
  'codex-not-authenticated': 'Codex authentication could not be confirmed. Check local Codex login before retrying.',
  'codex-policy-mismatch': 'Local safety settings could not be verified. The turn was refused; check local configuration.',
  'codex-ambient-config-blocked': 'Local Codex configuration would load outside instructions, skill metadata, enabled MCP connections or other external integrations. The turn was blocked without changing configuration. See ETAPA-2C-READONLY.md for the supported local setup.',
  'repository-request-invalid': 'Codex requested repository data in an unsupported format. No additional files were read; retry with a focused read-only instruction.',
  'repository-budget-exceeded': 'This analysis reached its repository request limit. Any received response is shown below; use Resume for a narrower follow-up.',
  'repository-unavailable': 'The authorized repository reader could not complete the request safely. Check the local workspace and agent before retrying; private filesystem diagnostics are withheld.',
  'codex-request-rejected': 'Codex rejected the local request. Check local Codex status and refresh inventory before retrying.',
  'codex-unavailable': 'Local Codex is unavailable. Check the local agent and Codex status before retrying.',
  'controller-unavailable': 'The local controller stopped unexpectedly. Any received partial response is shown below.',
  'codex-rpc-timeout': 'Codex did not acknowledge a protocol request in time. Any received partial response is shown below.',
  'codex-idle-timeout': 'No Codex turn activity was received before the idle timeout. The turn stopped; any partial response is shown below.',
  'codex-turn-timeout': 'The local Codex turn reached its maximum duration. It stopped without replay; any partial response is shown below.',
  'agent-disconnected': 'The agent disconnected. This turn will not replay automatically; reconnect and confirm a new instruction.',
  'agent-revoked': 'Agent authorization was revoked. Check enrollment before submitting another turn.',
  'selection-no-longer-available': 'The selected device or session changed before the turn started. Refresh and select again.'
};
function localAvailability() {
  const device = localDevice();
  if (!connected) return { ready: false, message: 'Connect as operator to use local control.' };
  if (!state.localControl?.enabled) return { ready: false, message: 'Local read-only control is disabled on this Hub.' };
  if (!device) return { ready: false, message: 'Select the configured local device explicitly.' };
  if (device.id !== state.localControl.deviceId || !device.localControl) {
    return { ready: false, message: 'This device is inventory-only. Local control is unavailable.' };
  }
  if (!online(device)) return { ready: false, message: 'The selected local device is offline or revoked.' };
  if (device.codexAuth !== 'authenticated') return { ready: false, message: 'Codex authentication: ' + authLabel(device.codexAuth) +
    '. An online heartbeat does not confirm Codex availability. Check local Codex/agent status before retrying.' };
  return { ready: true, message: 'Codex authenticated · local read-only control · explicit selections and confirmation required.' };
}
function localSelection() {
  const device = localDevice();
  const mode = $('local-mode').value;
  const workspace = state.localControl?.workspaces?.find(item => item.id === $('local-workspace').value);
  const session = device?.sessions?.find(item => item.id === $('local-thread').value);
  const prompt = $('local-prompt').value.trim();
  const valid = localAvailability().ready && ['new', 'resume'].includes(mode) && Boolean(workspace) &&
    prompt.length > 0 && prompt.length <= 2000 && (mode === 'new' || Boolean(session && session.eligibility !== 'busy'));
  return { valid, device, mode, workspace, session, prompt };
}
function timestamp(value) {
  if (value === undefined || value === null || value === '') return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toISOString();
}
function relativeTime(value) {
  if (timestamp(value) === 'Unknown') return 'Unknown';
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 0) return 'Future timestamp';
  if (elapsed < 60000) return 'just now';
  if (elapsed < 3600000) return Math.floor(elapsed / 60000) + 'm ago';
  if (elapsed < 86400000) return Math.floor(elapsed / 3600000) + 'h ago';
  return Math.floor(elapsed / 86400000) + 'd ago';
}

function controls() {
  $('inventory-device').disabled = !connected || !state.devices.length;
  const { ready, message } = localAvailability();
  $('local-control-status').textContent = message;
  const selection = localSelection();
  const conversation = $('local-mode').value === 'new'
    ? 'New conversation — no existing session will be resumed.'
    : $('local-mode').value !== 'resume' ? 'Choose New or Resume explicitly.'
    : !selection.session ? 'Choose a session explicitly. Discovered IDs are unverified candidates.'
    : shortTitle(selection.session) + ' · ' + relativeTime(selection.session.lastActivity) + ' · ' +
      resumeAvailability(selection.device, selection.session) + ' · Session ID: ' + selection.session.id;
  $('local-selection-summary').textContent = conversation +
    (selection.mode === 'new' ? ' Session ID will appear in the result after creation.' : '') +
    ' Workspace: ' + (selection.workspace ? selection.workspace.label + ' (alias: ' + selection.workspace.id + ')' : 'not selected') + '.';
  $('local-device').disabled = !connected || !state.localControl?.enabled || busy;
  for (const id of ['local-mode', 'local-workspace', 'local-prompt']) $(id).disabled = !ready || busy;
  $('local-thread').disabled = !ready || busy || $('local-mode').value !== 'resume';
  $('local-thread').required = $('local-mode').value === 'resume';
  const valid = selection.valid;
  $('local-confirm').disabled = !valid || busy;
  $('local-submit').disabled = !valid || !$('local-confirm').checked || busy;
}
function connection(ok, message) {
  connected = ok;
  $('connection').textContent = message;
  $('connection').className = ok ? 'on' : 'off';
  // Successful callers immediately render the new state, including controls.
  if (!ok) {
    controls();
    renderSessions();
  }
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
function renderSessions() {
  const device = state.devices.find(d => d.id === $('inventory-device').value);
  if (!device) {
    $('inventory-filter').textContent = 'Read-only inventory';
    $('inventory-filter-note').textContent = 'Discovery does not prove that a session is running or resumable.';
    $('inventory-status').textContent = 'Select a registered device to view its inventory.';
    $('sessions').innerHTML = '';
    return;
  }
  const inventory = device.sessionInventory || {};
  const scoped = inventory.source === 'app-server' && device.workspaceReady;
  $('inventory-filter').textContent = inventory.source === 'files' ? 'Unverified filename inventory' :
    scoped ? 'Cwd + Active · Read-only inventory' : 'Read-only inventory';
  $('inventory-filter-note').textContent = inventory.source === 'files'
    ? 'Session filenames cannot confirm workspace, archive status, live activity or resumability.'
    : scoped ? 'Cwd + Active means the configured workspace and non-archived sessions. It does not mean a Codex process is running. Resume is checked separately after your approval.'
    : 'Discovery does not prove that a session is running or resumable. Inventory collects no transcript.';
  $('inventory-status').textContent = deviceLabel(device) + ' · ' +
    (!connected ? 'Hub disconnected — last reported inventory' : device.revokedAt ? 'Revoked' : online(device) ? 'Online' : 'Offline — last reported inventory') +
    ' · Last heartbeat: ' + timestamp(device.lastSeen) + ' · Inventory: ' + (inventory.status || 'unknown') +
    (inventory.truncated ? ' · scan incomplete' : '') + (inventory.reason ? ' · ' + inventory.reason : '');
  $('sessions').innerHTML = (device.sessions || []).length ? device.sessions.map(session => {
    const source = session.source === 'app-server' ? 'App Server inventory' : session.source === 'files' ? 'Session filename inventory' : 'Unspecified inventory source';
    return '<article class="session"><div class="session-heading"><h3 title="' + escape(sessionTitle(session)) + '">' +
      escape(shortTitle(session)) + '</h3><span class="session-age">' + escape(relativeTime(session.lastActivity)) +
      '</span></div><p class="session-resume">' + escape(resumeAvailability(device, session)) +
      '</p><details class="session-id"><summary>Session details</summary><dl><dt>Title</dt><dd>' + escape(sessionTitle(session)) +
      '</dd><dt>Session ID</dt><dd><code aria-label="Full session ID: ' + escape(session.id) + '">' + escape(session.id) +
      '</code></dd><dt>Project</dt><dd>' + escape(session.project || 'Not available') +
      '</dd><dt>Device</dt><dd>' + escape(deviceLabel(device)) + '</dd><dt>Last known activity</dt><dd>' +
      escape(timestamp(session.lastActivity)) + '</dd><dt>Last modified metadata</dt><dd>' +
      escape(timestamp(session.modified)) + '</dd><dt>Activity</dt><dd>Discovered only — activity unconfirmed' +
      '</dd><dt>Source</dt><dd>' + escape(source) + '</dd><dt>Resume</dt><dd>' +
      escape(resumeAvailability(device, session)) + '</dd></dl></details></article>';
  }).join('') : '<p class="muted">No sessions reported by this device.</p>';
}
function renderLocalThreads(preserve = true) {
  const previous = preserve ? $('local-thread').value : '';
  const sessions = localDevice()?.sessions || [];
  $('local-thread').innerHTML = '<option value="">Choose a session explicitly</option>' + sessions.map(session =>
    '<option value="' + escape(session.id) + '"' + (session.eligibility === 'busy' ? ' disabled' : '') +
    ' title="' + escape(sessionTitle(session)) + ' · Full session ID: ' + escape(session.id) + ' · ' +
    escape(resumeLabel(session)) + '">' + escape(shortTitle(session)) + ' · ' + escape(relativeTime(session.lastActivity)) +
    (session.eligibility === 'busy' ? ' · Busy' : '') + '</option>').join('');
  if (sessions.some(session => session.id === previous && session.eligibility !== 'busy')) $('local-thread').value = previous;
}
function renderLocalControl() {
  const currentDevice = $('local-device').value;
  const currentWorkspace = $('local-workspace').value;
  $('local-device').innerHTML = '<option value="">Choose a device explicitly</option>' + state.devices.map(device =>
    '<option value="' + escape(device.id) + '">' + escape(deviceLabel(device)) + ' · ' +
    escape(authLabel(device.codexAuth)) + (device.id === state.localControl?.deviceId && device.localControl ? ' · local control' : ' · inventory only') + '</option>').join('');
  if (state.devices.some(device => device.id === currentDevice)) $('local-device').value = currentDevice;
  const workspaces = state.localControl?.workspaces || [];
  $('local-workspace').innerHTML = '<option value="">Choose a workspace explicitly</option>' + workspaces.map(workspace =>
    '<option value="' + escape(workspace.id) + '">' + escape(workspace.label) + '</option>').join('');
  if (workspaces.some(workspace => workspace.id === currentWorkspace)) $('local-workspace').value = currentWorkspace;
  renderLocalThreads();
  const jobs = state.readonlyJobs || [];
  $('local-jobs').innerHTML = jobs.length ? jobs.map(job =>
    '<article class="job"><b>' + escape(job.status) + '</b> · ' +
    escape(state.devices.find(device => device.id === job.deviceId)?.name || job.deviceId) +
    '<p><small>' + escape(job.mode) + ' · workspace ' +
    escape(workspaces.find(workspace => workspace.id === job.workspaceId)?.label || job.workspaceId) +
    ' (alias: ' + escape(job.workspaceId) + ') · session ' +
    escape(job.resultThreadId || job.threadId || 'ID pending creation') + ' · ' + escape(job.createdAt) + '</small></p><p>' +
    escape(job.prompt) + '</p>' + ((job.events || []).length ? '<ul class="local-events">' + job.events.map(event =>
      '<li><b>' + escape(event.type) + '</b> ' + escape(event.message) + '</li>').join('') + '</ul>' : '') +
    (job.errorCode ? '<p class="off">Error: <code>' + escape(job.errorCode) + '</code></p><p class="muted">' +
      escape(Object.hasOwn(localErrors, job.errorCode) ? localErrors[job.errorCode] :
        'The local turn stopped. Check the error code and current device status before retrying.') + '</p>' : '') +
    (job.outputTruncated === true ? '<p class="response-limit" role="status">Response truncated: the local output limit was reached. The text below is incomplete; ask a narrower follow-up in Resume. Completion status does not mean that the full response is displayed.</p>' : '') +
    (job.output ? '<p class="muted">' + (job.status === 'completed' ? 'Final response' : job.status === 'running'
      ? 'Partial response — turn still running' : 'Partial response — turn stopped') +
      (job.outputTruncated === true ? ' — truncated' : '') + '</p><pre>' + escape(job.output) + '</pre>' : '') + '</article>'
  ).join('') : '<p class="muted">No local read-only analyses submitted.</p>';
}
function render() {
  $('device-count').textContent = '(' + state.devices.filter(online).length + ' online / ' + state.devices.length + ')';
  $('devices').innerHTML = state.devices.length ? state.devices.map(d =>
    '<div class="device"><h3>' + escape(d.name) + ' <small class="' + (online(d) ? 'on' : 'off') + '">' +
    (d.revokedAt ? '○ revoked' : online(d) ? '● online' : '○ offline') + '</small></h3><code>' + escape(d.id) +
    '</code><p class="muted">Last heartbeat: ' + escape(timestamp(d.lastSeen)) + '</p><small>' + escape(d.platform) +
    ' · Remote instruction dispatch: disabled · ' + (d.workspaceReady ? 'Workspace verified' : 'Workspace missing or invalid') +
    '</small><p class="muted">Codex authentication: ' + escape(authLabel(d.codexAuth)) +
    '</p><p class="muted">Device-local workspaces (inventory): ' +
    ((d.workspaces || []).map(w => escape(w.label) + ' [' + escape(w.id) + ']').join(', ') || 'Not reported') +
    '</p><p><b>Configured MCP (' + d.mcp.servers.length + ')</b> <small>— ' + escape(d.mcp.status) +
    '; NOT verified live</small></p><div class="chips">' + (d.mcp.servers.map(s =>
      '<span class="chip">' + escape(s) + '</span>').join('') || '<small>None found</small>') +
    '</div><p><b>Reported sessions (' + d.sessions.length + ')</b></p><small>Inventory: ' +
    escape(d.sessionInventory?.status || 'unknown') + (d.sessionInventory?.truncated ? ' · scan incomplete' : '') +
    ' · activity and resume NOT verified. View sessions below.</small></div>'
  ).join('') : '<p class="muted">No device has reported inventory. Enroll an agent and connect it privately to this hub.</p>';
  const inventoryCurrent = $('inventory-device').value;
  $('inventory-device').innerHTML = state.devices.map(d => '<option value="' + escape(d.id) + '">' +
    escape(deviceLabel(d)) + (d.revokedAt ? ' · revoked' : online(d) ? ' · online' : ' · offline') + '</option>').join('');
  if (state.devices.some(d => d.id === inventoryCurrent)) $('inventory-device').value = inventoryCurrent;
  renderSessions();
  renderLocalControl();
  controls();
}
async function refresh() {
  if (!secret || refreshing) return;
  refreshing = true;
  try { state = await api('GET', '/api/state'); connection(true, 'Connected · operator · read-only inventory'); render(); }
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
    connection(true, 'Connected · operator · read-only inventory');
    render();
  } catch (error) { secret = ''; connection(false, error.message); }
  finally { busy = false; $('login').disabled = false; controls(); }
});
$('inventory-device').addEventListener('change', renderSessions);
$('local-device').addEventListener('change', () => {
  $('local-mode').value = '';
  $('local-workspace').value = '';
  $('local-confirm').checked = false;
  renderLocalThreads(false);
  controls();
});
$('local-mode').addEventListener('change', () => {
  $('local-confirm').checked = false;
  renderLocalThreads(false);
  controls();
});
for (const id of ['local-workspace', 'local-thread', 'local-prompt']) {
  $(id).addEventListener(id === 'local-prompt' ? 'input' : 'change', () => {
    $('local-confirm').checked = false;
    controls();
  });
}
$('local-confirm').addEventListener('change', controls);
$('local-form').addEventListener('submit', async event => {
  event.preventDefault();
  const selection = localSelection();
  if (busy || !selection.valid || !$('local-confirm').checked) {
    $('local-message').textContent = 'Select the authenticated local device, conversation mode, approved workspace, session for Resume and an instruction; then confirm the read-only analysis.';
    return;
  }
  const { device, mode, workspace, session, prompt } = selection;
  if (!confirm('Run one REAL LOCAL READ-ONLY Codex analysis?\n\nDevice: ' + deviceLabel(device) +
    '\nConversation: ' + (mode === 'new' ? 'New' : 'Resume ' + session.id) + '\nWorkspace: ' + workspace.label +
    '\n\n' + prompt + '\n\nCodex may request authorized project files through the limited READ-ONLY reader. Older sessions may use bounded continuations in this same conversation; the total analysis deadline still applies. File changes, arbitrary shell and access to private files are prohibited. This does not authorize execution on another device.')) {
    $('local-confirm').checked = false;
    controls();
    return;
  }
  busy = true;
  controls();
  try {
    await api('POST', '/api/local/task', {
      deviceId: device.id, mode, threadId: mode === 'resume' ? session.id : null,
      workspaceId: workspace.id, prompt, confirmed: true
    });
    $('local-message').textContent = 'Confirmed local read-only analysis submitted. Follow progress and results below.';
    $('local-prompt').value = '';
    $('local-confirm').checked = false;
    await refresh();
  } catch (error) { $('local-message').textContent = error.message; await refresh(); }
  finally { busy = false; controls(); }
});
controls();
setInterval(refresh, 4000);
