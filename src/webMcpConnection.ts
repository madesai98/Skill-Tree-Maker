import './webMcp.css';
import {
  MCP_PROTOCOL_VERSION,
  installMcpSchemaNormalization,
  type BrowserModelContext,
} from './webMcpSchema';

const MCP_ENABLED_KEY = 'skill-tree:mcp-enabled:v1';
const LEGACY_SETTINGS_KEYS = [
  'skill-tree:webmcp-settings:v2',
  'skill-tree:webmcp-settings:v1',
  'skill-tree:local-mcp-settings:v1',
];
const RELAY_VERSION = '5.0.1';
const RELAY_PORT = '9333';
const RELAY_REQUEST_TIMEOUT_MS = '120000';
const RELAY_INVOKE_TIMEOUT_MS = '125000';
const RELAY_EMBED_ID = 'skill-tree-mcp-relay-embed';
const RELAY_EMBED_URL = `https://cdn.jsdelivr.net/npm/@mcp-b/webmcp-local-relay@${RELAY_VERSION}/dist/browser/embed.js`;
const MCP_READY_EVENT = 'skill-tree:mcp-ready';

type ConnectionState = 'off' | 'enabling' | 'enabled' | 'error';
type WebMcpDocument = Document & { modelContext?: BrowserModelContext };
type McpWindow = Window & typeof globalThis & {
  __webModelContextOptions?: Record<string, unknown>;
};

let panelOpen = false;
let uiInstalled = false;
let connectionState: ConnectionState = readEnabledPreference() ? 'enabling' : 'off';
let connectionError: string | null = null;
let toolCount = 0;
let enablePromise: Promise<void> | null = null;

function readEnabledPreference() {
  const saved = localStorage.getItem(MCP_ENABLED_KEY);
  if (saved === 'true') return true;
  if (saved === 'false') return false;

  for (const key of LEGACY_SETTINGS_KEYS) {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? '') as { relayEnabled?: unknown };
      if (typeof value.relayEnabled !== 'boolean') continue;
      localStorage.setItem(MCP_ENABLED_KEY, String(value.relayEnabled));
      return value.relayEnabled;
    } catch {
      // Try the next legacy preference. Tunnel IDs and credentials are intentionally ignored.
    }
  }
  return false;
}

function persistEnabled() {
  localStorage.setItem(MCP_ENABLED_KEY, 'true');
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]!);
}

function bridgeCommand() {
  return `npx -y @mcp-b/webmcp-local-relay@latest --widget-origin ${window.location.origin} --invoke-timeout ${RELAY_INVOKE_TIMEOUT_MS}`;
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

function loadRelayAdapter() {
  const existing = document.getElementById(RELAY_EMBED_ID) as HTMLScriptElement | null;
  if (existing?.dataset.loaded === 'true') return Promise.resolve();
  if (existing) existing.remove();

  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.id = RELAY_EMBED_ID;
    script.src = RELAY_EMBED_URL;
    script.async = true;
    script.dataset.relayPort = RELAY_PORT;
    script.dataset.requestTimeout = RELAY_REQUEST_TIMEOUT_MS;
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      resolve();
    }, { once: true });
    script.addEventListener('error', () => {
      reject(new Error('The browser MCP relay adapter could not be loaded. Check the network or content-blocking settings and retry.'));
    }, { once: true });
    document.head.appendChild(script);
  });
}

async function refreshToolCount() {
  const context = (document as WebMcpDocument).modelContext;
  if (!context?.getTools) return;
  try {
    const tools = await context.getTools();
    toolCount = tools.filter((tool) => typeof tool.name === 'string' && tool.name.startsWith('skill_tree_')).length;
  } catch {
    // Tool discovery is optional in WebMCP; registration can still work without it.
  }
  renderUi();
}

async function enableMcp() {
  if (connectionState === 'enabled') return;
  if (enablePromise) return enablePromise;

  connectionState = 'enabling';
  connectionError = null;
  renderUi();

  enablePromise = (async () => {
    try {
      const mcpWindow = window as McpWindow;
      mcpWindow.__webModelContextOptions = {
        autoInitialize: false,
        nativeModelContextBehavior: 'preserve',
      };

      const runtime = await import('@mcp-b/global');
      runtime.initializeWebModelContext({
        transport: { tabServer: false, iframeServer: false },
        nativeModelContextBehavior: 'preserve',
        installTestingShim: true,
      });

      const context = (document as WebMcpDocument).modelContext;
      if (!context?.registerTool) throw new Error('The browser MCP runtime loaded, but document.modelContext is unavailable.');
      installMcpSchemaNormalization(context);
      await loadRelayAdapter();

      persistEnabled();
      connectionState = 'enabled';
      window.dispatchEvent(new CustomEvent(MCP_READY_EVENT, {
        detail: { protocolVersion: MCP_PROTOCOL_VERSION },
      }));
      window.setTimeout(() => void refreshToolCount(), 0);
      window.setTimeout(() => void refreshToolCount(), 500);
    } catch (error) {
      connectionState = 'error';
      connectionError = error instanceof Error ? error.message : 'MCP initialization failed.';
    } finally {
      enablePromise = null;
      renderUi();
    }
  })();

  return enablePromise;
}

function renderPanel(panel: HTMLElement) {
  panel.hidden = !panelOpen;
  const enabled = connectionState === 'enabled';
  const statusText = connectionState === 'off'
    ? 'Disabled'
    : connectionState === 'enabling'
      ? 'Enabling…'
      : connectionState === 'enabled'
        ? toolCount > 0 ? `Enabled · ${toolCount} tools` : 'Enabled'
        : 'Setup error';

  panel.innerHTML = `
    <div class="webmcp-head">
      <div><strong>MCP</strong><small>Skill Tree Maker browser tools ↔ local MCP bridge</small></div>
      <button type="button" data-mcp-action="close" aria-label="Close">×</button>
    </div>
    <div class="webmcp-section">
      <div class="webmcp-section-title">
        <strong>1. Enable MCP</strong>
        <small>Loads the browser WebMCP runtime, compatibility polyfills, Skill Tree Maker tools, and the loopback relay adapter.</small>
      </div>
      <div class="webmcp-actions">
        <button type="button" class="bridge-primary-action" data-mcp-action="enable" ${connectionState === 'enabling' ? 'disabled' : ''}>
          ${enabled ? 'MCP enabled' : connectionState === 'error' ? 'Retry MCP' : connectionState === 'enabling' ? 'Enabling MCP…' : 'Enable MCP'}
        </button>
      </div>
      <small class="webmcp-note">Status: <strong>${escapeHtml(statusText)}</strong>. Enabling MCP is remembered in this browser. No tunnel ID, OpenAI API key, account credential, extension, or remote-debugging session is required.</small>
      ${connectionError ? `<div class="webmcp-error">${escapeHtml(connectionError)}</div>` : ''}
    </div>
    <div class="webmcp-section">
      <div class="webmcp-section-title">
        <strong>2. Run the bridge</strong>
        <small>${enabled ? 'Run this command on the same computer, then keep this Skill Tree Maker tab open.' : 'Enable MCP first; then run the bridge command shown here.'}</small>
      </div>
      <div class="webmcp-command${enabled ? '' : ' is-disabled'}">
        <code>${escapeHtml(bridgeCommand())}</code>
        <button type="button" data-mcp-action="copy-command" ${enabled ? '' : 'disabled'}>Copy</button>
      </div>
      <small class="webmcp-note">The bridge is an ordinary MCP stdio server. It binds only to loopback for the browser side and is restricted to <code>${escapeHtml(window.location.origin)}</code>. Chrome may request Local Network Access the first time this site connects to localhost.</small>
    </div>`;
}

function renderUi() {
  const trigger = document.querySelector<HTMLElement>('.webmcp-button');
  const panel = document.querySelector<HTMLElement>('.webmcp-panel');
  if (trigger) {
    const enabled = connectionState === 'enabled';
    trigger.classList.toggle('is-ready', enabled);
    trigger.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
    const status = trigger.querySelector<HTMLElement>('.webmcp-button-status');
    if (status) status.textContent = enabled ? 'Enabled' : connectionState === 'enabling' ? 'Loading' : connectionState === 'error' ? 'Error' : 'Off';
  }
  if (panel) renderPanel(panel);
}

function installUi() {
  if (uiInstalled) return true;
  const actions = document.querySelector<HTMLElement>('.top-actions');
  if (!actions) return false;
  uiInstalled = true;

  const control = document.createElement('div');
  control.className = 'webmcp-control';
  control.innerHTML = `<button type="button" class="ghost webmcp-button" aria-expanded="false"><span class="webmcp-icon" aria-hidden="true">⌁</span><span class="webmcp-button-label">MCP</span><small class="webmcp-button-status">${connectionState === 'off' ? 'Off' : 'Loading'}</small></button><div class="webmcp-panel" hidden></div>`;
  actions.insertBefore(control, actions.firstChild);

  control.querySelector<HTMLButtonElement>('.webmcp-button')?.addEventListener('click', (event) => {
    event.stopPropagation();
    panelOpen = !panelOpen;
    renderUi();
    if (panelOpen && connectionState === 'enabled') void refreshToolCount();
  });

  control.querySelector<HTMLElement>('.webmcp-panel')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-mcp-action]')?.dataset.mcpAction;
    if (action === 'close') {
      panelOpen = false;
      renderUi();
    } else if (action === 'enable') {
      void enableMcp();
    } else if (action === 'copy-command' && connectionState === 'enabled') {
      void copyText(bridgeCommand());
    }
  });

  document.addEventListener('click', () => {
    if (!panelOpen) return;
    panelOpen = false;
    renderUi();
  });

  renderUi();
  return true;
}

if (!installUi()) {
  const observer = new MutationObserver(() => {
    if (installUi()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

if (connectionState === 'enabling') void enableMcp();
window.setInterval(() => {
  if (connectionState === 'enabled') void refreshToolCount();
}, 2500);
