import { HISTORY_APPLY_EVENT, getHistoryProject, type HistoryApplyDetail } from './history';
import { readWorkingProject } from './localProjectStore';
import { diffProjects, normalizeProject, sameValue, validateProjectGraph } from './projectData';
import './localMcpBridge.css';

const PROTOCOL_VERSION = 1;
const CHANNEL = 'skill-tree-maker-local-mcp';
const PAGE_SOURCE = 'skill-tree-maker-page';
const COMPANION_SOURCE = 'skill-tree-maker-companion';
const SETTINGS_KEY = 'skill-tree:local-mcp-settings:v1';
const PROJECT_SETTINGS_KEY = 'skill-tree:project-settings:v1';
const TUNNELS_URL = 'https://platform.openai.com/settings/organization/tunnels';
const API_KEYS_URL = 'https://platform.openai.com/settings/organization/api-keys';
const TUNNEL_CLIENT_URL = 'https://github.com/openai/tunnel-client/releases/latest';

type ConnectionState = 'connected' | 'disconnected' | 'missing' | 'unknown';
type Settings = { tunnelId: string };
type CompanionStatus = {
  extension: ConnectionState;
  localServer: ConnectionState;
  tunnel: ConnectionState;
  localServerUrl?: string;
  tunnelId?: string;
  lastSeenAt?: number;
};
type CompanionMessage = {
  channel: typeof CHANNEL;
  source: typeof COMPANION_SOURCE;
  type: 'status' | 'request';
  requestId?: string;
  action?: 'ping' | 'get_context' | 'get_project' | 'apply_project';
  payload?: unknown;
  status?: Partial<CompanionStatus>;
};

let panelOpen = false;
let uiInstalled = false;
let probeTimer: number | null = null;
let settings = readSettings();
let companionStatus: CompanionStatus = {
  extension: 'unknown',
  localServer: 'unknown',
  tunnel: 'unknown',
};

function readSettings(): Settings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '') as Partial<Settings>;
    return { tunnelId: typeof value.tunnelId === 'string' ? value.tunnelId.trim() : '' };
  } catch {
    return { tunnelId: '' };
  }
}

function saveSettings(tunnelId: string) {
  settings = { tunnelId: tunnelId.trim() };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  announceConfiguration();
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]!);
}

function runtimeContext() {
  let mode: 'local' | 'online' = 'local';
  let projectId: string | null = null;
  try {
    const value = JSON.parse(localStorage.getItem(PROJECT_SETTINGS_KEY) ?? '') as Record<string, unknown>;
    mode = value.mode === 'online' ? 'online' : 'local';
    const selected = mode === 'online' ? value.selectedOnlineProjectId : value.selectedLocalProjectId;
    projectId = typeof selected === 'string' ? selected : null;
  } catch {
    // Local mode is the safe fallback when settings have not been initialized yet.
  }
  const activeView = document.querySelector<HTMLElement>('.view-switcher button.active')
    ?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  return {
    protocolVersion: PROTOCOL_VERSION,
    storageMode: mode,
    projectId,
    activeView,
    origin: window.location.origin,
    capabilities: { readProject: true, applyProject: true, localAndOnlineModes: true },
  };
}

function currentProject() {
  return getHistoryProject() ?? readWorkingProject();
}

function applyProject(raw: unknown) {
  const project = normalizeProject(raw);
  if (!project) throw new Error('The companion supplied an invalid Skill Tree Maker project.');
  const graphIssue = validateProjectGraph(project);
  if (graphIssue) throw new Error(graphIssue);

  const before = currentProject();
  if (sameValue(before, project)) return { changed: false, changeCount: 0 };
  const changes = diffProjects(before, project);
  if (!changes.length) return { changed: false, changeCount: 0 };

  const detail: HistoryApplyDetail = { transitions: [{ direction: 'redo', changes }] };
  window.dispatchEvent(new CustomEvent<HistoryApplyDetail>(HISTORY_APPLY_EVENT, { detail }));
  return { changed: true, changeCount: changes.length };
}

function post(message: Record<string, unknown>) {
  window.postMessage({
    channel: CHANNEL,
    source: PAGE_SOURCE,
    protocolVersion: PROTOCOL_VERSION,
    ...message,
  }, window.location.origin);
}

function announceConfiguration() {
  post({ type: 'configuration', tunnelId: settings.tunnelId || null, context: runtimeContext() });
}

function respond(requestId: string, ok: boolean, result?: unknown, error?: string) {
  post({ type: 'response', requestId, ok, ...(ok ? { result } : { error }) });
}

function isCompanionMessage(value: unknown): value is CompanionMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return message.channel === CHANNEL && message.source === COMPANION_SOURCE;
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin || !isCompanionMessage(event.data)) return;
  const message = event.data;
  if (message.type === 'status') {
    companionStatus = {
      ...companionStatus,
      ...message.status,
      extension: message.status?.extension ?? 'connected',
      lastSeenAt: Date.now(),
    };
    if (probeTimer !== null) window.clearTimeout(probeTimer);
    probeTimer = null;
    renderUi();
    announceConfiguration();
    return;
  }

  if (message.type !== 'request' || !message.requestId || !message.action) return;
  try {
    if (message.action === 'ping' || message.action === 'get_context') {
      respond(message.requestId, true, runtimeContext());
    } else if (message.action === 'get_project') {
      respond(message.requestId, true, currentProject());
    } else if (message.action === 'apply_project') {
      const payload = message.payload as { project?: unknown } | undefined;
      respond(message.requestId, true, applyProject(payload?.project));
    }
  } catch (error) {
    respond(message.requestId, false, undefined, error instanceof Error ? error.message : 'Bridge request failed.');
  }
});

function probeCompanion() {
  const startedAt = Date.now();
  companionStatus = { ...companionStatus, extension: 'unknown', localServer: 'unknown', tunnel: 'unknown' };
  renderUi();
  post({ type: 'probe', tunnelId: settings.tunnelId || null });
  if (probeTimer !== null) window.clearTimeout(probeTimer);
  probeTimer = window.setTimeout(() => {
    probeTimer = null;
    if (companionStatus.lastSeenAt && companionStatus.lastSeenAt >= startedAt) return;
    companionStatus = { extension: 'missing', localServer: 'unknown', tunnel: 'unknown' };
    renderUi();
  }, 1200);
}

function stateLabel(state: ConnectionState) {
  if (state === 'connected') return 'Connected';
  if (state === 'disconnected') return 'Disconnected';
  if (state === 'missing') return 'Not detected';
  return 'Checking…';
}

function statusRow(label: string, state: ConnectionState, detail: string) {
  return `<div class="mcp-setup-status-row"><span class="mcp-setup-dot is-${state}"></span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></div><span>${escapeHtml(stateLabel(state))}</span></div>`;
}

function tunnelCommand() {
  return `tunnel-client init --sample sample_mcp_stdio_local --profile skill-tree-maker --tunnel-id ${settings.tunnelId || '<YOUR_TUNNEL_ID>'} --mcp-command "<PATH_TO_SKILL_TREE_MAKER_MCP_SERVER>"`;
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
}

function renderPanel(panel: HTMLElement) {
  const extensionDetail = companionStatus.lastSeenAt
    ? `Last response ${new Date(companionStatus.lastSeenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
    : 'Relays commands between this tab and the local bridge.';
  const localDetail = companionStatus.localServerUrl ?? 'Expected local Skill Tree Maker MCP companion.';
  const tunnelDetail = companionStatus.tunnelId ?? (settings.tunnelId || 'Enter your tunnel ID below.');
  panel.hidden = !panelOpen;
  panel.innerHTML = `
    <div class="mcp-setup-head"><div><strong>ChatGPT / Local MCP</strong><small>Browser bridge protocol v${PROTOCOL_VERSION}</small></div><button type="button" data-mcp-action="close" aria-label="Close">×</button></div>
    <div class="mcp-setup-intro">This bridge controls the running editor, so it works with both Local and Online projects. OpenAI API keys stay on your computer and are never stored by this page.</div>
    <div class="mcp-setup-status">
      ${statusRow('Skill Tree Maker browser bridge', 'connected', 'Ready in this tab.')}
      ${statusRow('Browser extension relay', companionStatus.extension, extensionDetail)}
      ${statusRow('Local MCP server', companionStatus.localServer, localDetail)}
      ${statusRow('OpenAI tunnel', companionStatus.tunnel, tunnelDetail)}
    </div>
    <div class="mcp-setup-section">
      <div class="mcp-setup-section-title"><strong>1. Save your tunnel ID</strong><small>The tunnel ID is not secret. Do not paste an OpenAI API key here.</small></div>
      <label class="mcp-setup-field"><span>Tunnel ID</span><input type="text" data-mcp-tunnel-id spellcheck="false" placeholder="tunnel_0123456789abcdef..." value="${escapeHtml(settings.tunnelId)}"></label>
      <div class="mcp-setup-actions"><button type="button" data-mcp-action="save-tunnel">Save</button><a href="${TUNNELS_URL}" target="_blank" rel="noreferrer">Open Tunnels</a></div>
    </div>
    <div class="mcp-setup-section">
      <div class="mcp-setup-section-title"><strong>2. Install the local pieces</strong><small>A web page cannot reliably install or launch native software, so the remaining steps happen on your computer.</small></div>
      <ol class="mcp-setup-steps">
        <li>Install the Skill Tree Maker extension relay and local MCP companion when available. The relay is limited to the Skill Tree Maker site.</li>
        <li>Download OpenAI <code>tunnel-client</code> and create a runtime API key with Tunnels Read + Use permissions.</li>
        <li>Point the tunnel at the local Skill Tree Maker MCP server and keep the runtime running while ChatGPT is connected.</li>
        <li>In ChatGPT Settings → Connectors, choose a Tunnel connection and select the same tunnel.</li>
      </ol>
      <div class="mcp-setup-links"><a href="${TUNNEL_CLIENT_URL}" target="_blank" rel="noreferrer">Download tunnel-client</a><a href="${API_KEYS_URL}" target="_blank" rel="noreferrer">Runtime API keys</a></div>
      <div class="mcp-setup-command"><code>${escapeHtml(tunnelCommand())}</code><button type="button" data-mcp-action="copy-command">Copy</button></div>
      <small class="mcp-setup-note">The companion executable is the next implementation step. The page-side handshake, project read channel, validated project-apply channel, tunnel setting, and connection-status protocol are already active.</small>
    </div>
    <div class="mcp-setup-footer"><button type="button" data-mcp-action="check">Check connection</button><span>${companionStatus.extension === 'connected' ? 'Companion relay detected.' : 'Waiting for companion relay.'}</span></div>`;
}

function renderUi() {
  const panel = document.querySelector<HTMLElement>('.mcp-setup-panel');
  const trigger = document.querySelector<HTMLElement>('.mcp-setup-button');
  if (trigger) {
    const connected = companionStatus.localServer === 'connected' && companionStatus.tunnel === 'connected';
    trigger.classList.toggle('is-connected', connected);
    trigger.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
    const status = trigger.querySelector<HTMLElement>('.mcp-setup-button-status');
    if (status) status.textContent = connected ? 'Connected' : companionStatus.extension === 'missing' ? 'Setup' : 'Checking';
  }
  if (panel) renderPanel(panel);
}

function installUi() {
  if (uiInstalled) return true;
  const actions = document.querySelector<HTMLElement>('.top-actions');
  if (!actions) return false;
  uiInstalled = true;

  const control = document.createElement('div');
  control.className = 'mcp-setup-control';
  control.innerHTML = `<button type="button" class="ghost mcp-setup-button" aria-expanded="false"><span class="mcp-setup-icon" aria-hidden="true">⌁</span><span class="mcp-setup-button-label">ChatGPT</span><small class="mcp-setup-button-status">Setup</small></button><div class="mcp-setup-panel" hidden></div>`;
  actions.insertBefore(control, actions.firstChild);

  control.querySelector<HTMLButtonElement>('.mcp-setup-button')?.addEventListener('click', (event) => {
    event.stopPropagation();
    panelOpen = !panelOpen;
    renderUi();
    if (panelOpen) probeCompanion();
  });

  const panel = control.querySelector<HTMLElement>('.mcp-setup-panel');
  panel?.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-mcp-action]')?.dataset.mcpAction;
    if (action === 'close') {
      panelOpen = false;
      renderUi();
    } else if (action === 'check') {
      probeCompanion();
    } else if (action === 'save-tunnel') {
      saveSettings(control.querySelector<HTMLInputElement>('[data-mcp-tunnel-id]')?.value ?? '');
      renderUi();
      probeCompanion();
    } else if (action === 'copy-command') {
      void copyText(tunnelCommand());
    }
  });

  panel?.addEventListener('keydown', (event) => {
    const keyboardEvent = event as KeyboardEvent;
    const target = keyboardEvent.target as HTMLElement;
    if (keyboardEvent.key !== 'Enter' || !target.matches('[data-mcp-tunnel-id]')) return;
    keyboardEvent.preventDefault();
    saveSettings((target as HTMLInputElement).value);
    renderUi();
    probeCompanion();
  });

  document.addEventListener('click', () => {
    if (!panelOpen) return;
    panelOpen = false;
    renderUi();
  });

  renderUi();
  window.setTimeout(probeCompanion, 200);
  return true;
}

if (!installUi()) {
  const observer = new MutationObserver(() => {
    if (installUi()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

window.addEventListener('focus', () => {
  if (panelOpen) probeCompanion();
});
