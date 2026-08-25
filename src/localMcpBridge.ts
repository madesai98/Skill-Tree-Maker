import {
  HISTORY_APPLY_EVENT,
  getHistoryProject,
  type HistoryApplyDetail,
} from './history';
import { readWorkingProject } from './localProjectStore';
import {
  diffProjects,
  normalizeProject,
  sameValue,
  validateProjectGraph,
  type CanonicalProject,
} from './projectData';
import './localMcpBridge.css';

const BRIDGE_PROTOCOL_VERSION = 1;
const MESSAGE_CHANNEL = 'skill-tree-maker-local-mcp';
const PAGE_SOURCE = 'skill-tree-maker-page';
const COMPANION_SOURCE = 'skill-tree-maker-companion';
const SETTINGS_KEY = 'skill-tree:local-mcp-settings:v1';
const PROJECT_SETTINGS_KEY = 'skill-tree:project-settings:v1';
const OPENAI_TUNNELS_URL = 'https://platform.openai.com/settings/organization/tunnels';
const OPENAI_RUNTIME_KEYS_URL = 'https://platform.openai.com/settings/organization/api-keys';
const TUNNEL_CLIENT_RELEASE_URL = 'https://github.com/openai/tunnel-client/releases/latest';

type ConnectionState = 'connected' | 'disconnected' | 'missing' | 'unknown';

type BridgeSettings = {
  tunnelId: string;
};

type CompanionStatus = {
  extension: ConnectionState;
  localServer: ConnectionState;
  tunnel: ConnectionState;
  localServerUrl?: string;
  tunnelId?: string;
  detail?: string;
  lastSeenAt?: number;
};

type CompanionRequest = {
  channel: typeof MESSAGE_CHANNEL;
  source: typeof COMPANION_SOURCE;
  type: 'request';
  requestId: string;
  action: 'ping' | 'get_context' | 'get_project' | 'apply_project';
  payload?: unknown;
};

type CompanionStatusMessage = {
  channel: typeof MESSAGE_CHANNEL;
  source: typeof COMPANION_SOURCE;
  type: 'status';
  status?: Partial<CompanionStatus>;
};

type CompanionMessage = CompanionRequest | CompanionStatusMessage;

let panelOpen = false;
let uiInstalled = false;
let probeTimer: number | null = null;
let settings = readSettings();
let companionStatus: CompanionStatus = {
  extension: 'unknown',
  localServer: 'unknown',
  tunnel: 'unknown',
};

function readSettings(): BridgeSettings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '') as Partial<BridgeSettings>;
    return {
      tunnelId: typeof value.tunnelId === 'string' ? value.tunnelId.trim() : '',
    };
  } catch {
    return { tunnelId: '' };
  }
}

function writeSettings(next: BridgeSettings) {
  settings = next;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  announceConfiguration();
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[char]!);
}

function readRuntimeMode() {
  try {
    const value = JSON.parse(localStorage.getItem(PROJECT_SETTINGS_KEY) ?? '') as {
      mode?: unknown;
      selectedLocalProjectId?: unknown;
      selectedOnlineProjectId?: unknown;
    };
    const mode = value.mode === 'online' ? 'online' : 'local';
    const projectId = mode === 'online'
      ? (typeof value.selectedOnlineProjectId === 'string' ? value.selectedOnlineProjectId : null)
      : (typeof value.selectedLocalProjectId === 'string' ? value.selectedLocalProjectId : null);
    return { mode, projectId };
  } catch {
    return { mode: 'local' as const, projectId: null };
  }
}

function activeViewName() {
  const active = document.querySelector<HTMLElement>('.view-switcher button.active');
  return active?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
}

function currentProject() {
  return getHistoryProject() ?? readWorkingProject();
}

function currentContext() {
  const runtime = readRuntimeMode();
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    storageMode: runtime.mode,
    projectId: runtime.projectId,
    activeView: activeViewName(),
    origin: window.location.origin,
    capabilities: {
      readProject: true,
      applyProject: true,
      localAndOnlineModes: true,
    },
  };
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

  const detail: HistoryApplyDetail = {
    transitions: [{ direction: 'redo', changes }],
  };
  window.dispatchEvent(new CustomEvent<HistoryApplyDetail>(HISTORY_APPLY_EVENT, { detail }));
  return { changed: true, changeCount: changes.length };
}

function postToCompanion(message: Record<string, unknown>) {
  window.postMessage({
    channel: MESSAGE_CHANNEL,
    source: PAGE_SOURCE,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    ...message,
  }, window.location.origin);
}

function announceConfiguration() {
  postToCompanion({
    type: 'configuration',
    tunnelId: settings.tunnelId || null,
    context: currentContext(),
  });
}

function sendResponse(requestId: string, ok: boolean, result?: unknown, error?: string) {
  postToCompanion({
    type: 'response',
    requestId,
    ok,
    ...(ok ? { result } : { error: error ?? 'Bridge request failed.' }),
  });
}

function validCompanionMessage(value: unknown): value is CompanionMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return message.channel === MESSAGE_CHANNEL && message.source === COMPANION_SOURCE;
}

function mergeCompanionStatus(next: Partial<CompanionStatus>) {
  companionStatus = {
    ...companionStatus,
    ...next,
    extension: next.extension ?? 'connected',
    lastSeenAt: Date.now(),
  };
  if (probeTimer !== null) {
    window.clearTimeout(probeTimer);
    probeTimer = null;
  }
  renderUi();
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!validCompanionMessage(event.data)) return;
  const message = event.data;

  if (message.type === 'status') {
    mergeCompanionStatus(message.status ?? {});
    announceConfiguration();
    return;
  }

  void (async () => {
    try {
      if (message.action === 'ping') {
        sendResponse(message.requestId, true, currentContext());
      } else if (message.action === 'get_context') {
        sendResponse(message.requestId, true, currentContext());
      } else if (message.action === 'get_project') {
        sendResponse(message.requestId, true, currentProject());
      } else if (message.action === 'apply_project') {
        const payload = message.payload as { project?: unknown } | null | undefined;
        sendResponse(message.requestId, true, applyProject(payload?.project));
      }
    } catch (error) {
      sendResponse(
        message.requestId,
        false,
        undefined,
        error instanceof Error ? error.message : 'Bridge request failed.',
      );
    }
  })();
});

function probeCompanion() {
  companionStatus = {
    ...companionStatus,
    extension: 'unknown',
    localServer: 'unknown',
    tunnel: 'unknown',
  };
  renderUi();
  postToCompanion({ type: 'probe', tunnelId: settings.tunnelId || null });
  if (probeTimer !== null) window.clearTimeout(probeTimer);
  probeTimer = window.setTimeout(() => {
    probeTimer = null;
    if (companionStatus.lastSeenAt && Date.now() - companionStatus.lastSeenAt < 3000) return;
    companionStatus = {
      extension: 'missing',
      localServer: 'unknown',
      tunnel: 'unknown',
    };
    renderUi();
  }, 1200);
}

function statusLabel(state: ConnectionState) {
  if (state === 'connected') return 'Connected';
  if (state === 'disconnected') return 'Disconnected';
  if (state === 'missing') return 'Not detected';
  return 'Checking…';
}

function statusRow(label: string, state: ConnectionState, detail?: string) {
  return `<div class="mcp-setup-status-row"><span class="mcp-setup-dot is-${state}"></span><div><strong>${escapeHtml(label)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</div><span>${escapeHtml(statusLabel(state))}</span></div>`;
}

function tunnelCommand() {
  const tunnelId = settings.tunnelId || '<YOUR_TUNNEL_ID>';
  return `tunnel-client init --sample sample_mcp_stdio_local --profile skill-tree-maker --tunnel-id ${tunnelId} --mcp-command "<PATH_TO_SKILL_TREE_MAKER_MCP_SERVER>"`;
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
  const tunnelDetail = companionStatus.tunnelId ?? settings.tunnelId || 'Enter your tunnel ID below.';

  panel.hidden = !panelOpen;
  panel.innerHTML = `
    <div class="mcp-setup-head">
      <div><strong>ChatGPT / Local MCP</strong><small>Browser bridge protocol v${BRIDGE_PROTOCOL_VERSION}</small></div>
      <button type="button" data-mcp-action="close" aria-label="Close">×</button>
    </div>
    <div class="mcp-setup-intro">The editor exposes a local companion bridge that works with both Local and Online projects. The browser never needs your OpenAI API key.</div>
    <div class="mcp-setup-status">
      ${statusRow('Skill Tree Maker browser bridge', 'connected', 'Ready in this tab.')}
      ${statusRow('Browser extension relay', companionStatus.extension, extensionDetail)}
      ${statusRow('Local MCP server', companionStatus.localServer, localDetail)}
      ${statusRow('OpenAI tunnel', companionStatus.tunnel, tunnelDetail)}
    </div>
    <div class="mcp-setup-section">
      <div class="mcp-setup-section-title"><strong>1. Save your tunnel ID</strong><small>This is not a secret. API keys stay outside the browser.</small></div>
      <label class="mcp-setup-field"><span>Tunnel ID</span><input type="text" data-mcp-tunnel-id spellcheck="false" placeholder="tunnel_0123456789abcdef..." value="${escapeHtml(settings.tunnelId)}"></label>
      <div class="mcp-setup-actions"><button type="button" data-mcp-action="save-tunnel">Save</button><a href="${OPENAI_TUNNELS_URL}" target="_blank" rel="noreferrer">Open Tunnels</a></div>
    </div>
    <div class="mcp-setup-section">
      <div class="mcp-setup-section-title"><strong>2. Install the local pieces</strong><small>The web page cannot install or launch native software, so these steps must be completed on your computer.</small></div>
      <ol class="mcp-setup-steps">
        <li>Install the Skill Tree Maker browser extension relay and local MCP companion when available. The extension only relays messages for this Skill Tree Maker origin.</li>
        <li>Download OpenAI's <code>tunnel-client</code> and create a runtime API key with tunnel Read + Use permissions.</li>
        <li>Configure <code>tunnel-client</code> to forward your tunnel to the local Skill Tree Maker MCP server, then keep it running while ChatGPT is connected.</li>
        <li>In ChatGPT Settings → Connectors, choose a Tunnel connection and select the same tunnel.</li>
      </ol>
      <div class="mcp-setup-links"><a href="${TUNNEL_CLIENT_RELEASE_URL}" target="_blank" rel="noreferrer">Download tunnel-client</a><a href="${OPENAI_RUNTIME_KEYS_URL}" target="_blank" rel="noreferrer">Runtime API keys</a></div>
      <div class="mcp-setup-command"><code>${escapeHtml(tunnelCommand())}</code><button type="button" data-mcp-action="copy-command">Copy</button></div>
      <small class="mcp-setup-note">The companion executable is the next implementation step. This page already provides the handshake, project read access, validated project-apply channel, status reporting, and tunnel configuration it will use.</small>
    </div>
    <div class="mcp-setup-footer"><button type="button" data-mcp-action="check">Check connection</button><span>${companionStatus.extension === 'connected' ? 'Companion relay detected.' : 'Waiting for companion relay.'}</span></div>
  `;
}

function renderUi() {
  const panel = document.querySelector<HTMLElement>('.mcp-setup-panel');
  const trigger = document.querySelector<HTMLElement>('.mcp-setup-button');
  if (trigger) {
    trigger.classList.toggle('is-connected', companionStatus.localServer === 'connected' && companionStatus.tunnel === 'connected');
    trigger.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
    const status = trigger.querySelector<HTMLElement>('.mcp-setup-button-status');
    if (status) {
      status.textContent = companionStatus.localServer === 'connected' && companionStatus.tunnel === 'connected'
        ? 'Connected'
        : companionStatus.extension === 'missing'
          ? 'Setup'
          : 'Checking';
    }
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

  control.querySelector('.mcp-setup-button')?.addEventListener('click', (event) => {
    event.stopPropagation();
    panelOpen = !panelOpen;
    renderUi();
    if (panelOpen) probeCompanion();
  });

  control.querySelector('.mcp-setup-panel')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-mcp-action]')?.dataset.mcpAction;
    if (!action) return;

    if (action === 'close') {
      panelOpen = false;
      renderUi();
    } else if (action === 'check') {
      probeCompanion();
    } else if (action === 'save-tunnel') {
      const input = control.querySelector<HTMLInputElement>('[data-mcp-tunnel-id]');
      writeSettings({ tunnelId: input?.value.trim() ?? '' });
      renderUi();
      probeCompanion();
    } else if (action === 'copy-command') {
      void copyText(tunnelCommand());
    }
  });

  control.querySelector('.mcp-setup-panel')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const target = event.target as HTMLElement;
    if (!target.matches('[data-mcp-tunnel-id]')) return;
    event.preventDefault();
    const input = target as HTMLInputElement;
    writeSettings({ tunnelId: input.value.trim() });
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
