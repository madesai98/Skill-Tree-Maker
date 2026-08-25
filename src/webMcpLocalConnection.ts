import './webMcpLocalConnection.css';

const SETTINGS_KEY = 'skill-tree:webmcp-settings:v2';
const BRIDGE_SETUP_KEY = 'skill-tree:bridge-launch-setup:v1';
const RELAY_HOST = '127.0.0.1';
const RELAY_PORT = 9333;
const RELAY_URL = `ws://${RELAY_HOST}:${RELAY_PORT}`;
const RELAY_BROWSER_PROTOCOL = 'webmcp.v1';
const RELAY_DISCOVERY_PROTOCOL = 'webmcp-discovery.v1';
const TAB_ID_KEY = 'skill-tree:webmcp-relay-tab-id:v1';
const TOOL_PREFIX = 'skill_tree_';
const INVOKE_TIMEOUT_MS = 120_000;
const HANDSHAKE_TIMEOUT_MS = 4_000;
const TOOL_POLL_INTERVAL_MS = 2_000;
const RETRY_DELAYS_MS = [1_500, 3_000, 5_000, 10_000, 15_000, 30_000];
const HIDDEN_TAB_RETRY_FLOOR_MS = 30_000;

type JsonObject = Record<string, unknown>;
type RelayPhase = 'disabled' | 'connecting' | 'waiting' | 'connected' | 'rejected';
type RelayBootstrapState = { enabled: boolean; tunnelId: string };
type RegisteredTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
  execute?: (input: JsonObject) => unknown;
};
type ModelContextLike = {
  getTools?: () => Promise<RegisteredTool[]>;
  executeTool?: (tool: RegisteredTool, serializedArgs: string) => Promise<unknown>;
  addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
};
type RelayDescriptor = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: unknown;
  annotations?: unknown;
};
type RelayState = {
  phase: RelayPhase;
  detail: string;
  retryAt: number | null;
  connectedAt: number | null;
  serverInstanceId: string | null;
};
type SkillTreeWindow = Window & typeof globalThis & {
  __skillTreeMcpRelayBootstrap?: RelayBootstrapState;
};
type ModelContextDocument = Document & { modelContext?: ModelContextLike };

const skillTreeWindow = window as SkillTreeWindow;
const bootstrap = skillTreeWindow.__skillTreeMcpRelayBootstrap;
let enabled = bootstrap?.enabled ?? readStoredRelayEnabled();
let state: RelayState = {
  phase: enabled ? 'waiting' : 'disabled',
  detail: enabled ? 'Waiting for the local launcher.' : 'Local bridge is disabled.',
  retryAt: null,
  connectedAt: null,
  serverInstanceId: null,
};
let socket: WebSocket | null = null;
let socketGeneration = 0;
let handshakeTimer: number | null = null;
let retryTimer: number | null = null;
let retryIndex = 0;
let connectedOnce = false;
let toolCount = 0;
let lastToolsSnapshot = '';
let toolPollTimer: number | null = null;
let toolChangeSubscribedContext: ModelContextLike | null = null;
let uiObserver: MutationObserver | null = null;
let uiDiscoveryObserver: MutationObserver | null = null;
let uiPatchScheduled = false;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStoredRelayEnabled() {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '') as {
      relayEnabled?: unknown;
      tunnelId?: unknown;
    };
    if (typeof value.relayEnabled === 'boolean') return value.relayEnabled;
    return typeof value.tunnelId === 'string' && Boolean(value.tunnelId.trim());
  } catch {
    return false;
  }
}

function readTunnelId() {
  for (const key of [SETTINGS_KEY, BRIDGE_SETUP_KEY]) {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? '') as { tunnelId?: unknown };
      if (typeof value.tunnelId === 'string' && value.tunnelId.trim()) return value.tunnelId.trim();
    } catch {
      // Try the next settings source.
    }
  }
  return bootstrap?.tunnelId ?? '';
}

function persistRelayEnabled(nextEnabled: boolean) {
  try {
    let value: JsonObject = {};
    try {
      value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as JsonObject;
    } catch {
      value = {};
    }
    const tunnelId = typeof value.tunnelId === 'string' ? value.tunnelId : readTunnelId();
    const currentEnabled = typeof value.relayEnabled === 'boolean' ? value.relayEnabled : undefined;
    if (currentEnabled === nextEnabled && value.tunnelId === tunnelId) return;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...value, tunnelId, relayEnabled: nextEnabled }));
  } catch {
    // The connection can continue in memory when browser storage is unavailable.
  }
}

function setEnabled(nextEnabled: boolean) {
  enabled = nextEnabled;
  if (skillTreeWindow.__skillTreeMcpRelayBootstrap) {
    skillTreeWindow.__skillTreeMcpRelayBootstrap.enabled = nextEnabled;
  }
  persistRelayEnabled(nextEnabled);

  if (!nextEnabled) {
    clearRetryTimer();
    clearHandshakeTimer();
    retryIndex = 0;
    connectedOnce = false;
    const current = socket;
    socket = null;
    if (current) {
      try {
        current.close(1000, 'Local bridge disabled');
      } catch {
        // Ignore close failures while disabling.
      }
    }
    updateState('disabled', 'Local bridge is disabled.', null, null);
    return;
  }

  retryIndex = 0;
  updateState('waiting', 'Waiting for the local launcher.', null, null);
  connectNow();
}

function getModelContext() {
  return (document as ModelContextDocument).modelContext;
}

function readOrCreateTabId() {
  try {
    const saved = sessionStorage.getItem(TAB_ID_KEY);
    if (saved) return saved;
    const created = crypto.randomUUID();
    sessionStorage.setItem(TAB_ID_KEY, created);
    return created;
  } catch {
    return typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `stm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

const tabId = readOrCreateTabId();

function cleanPageUrl() {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  return url.href;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

function normalizeInputSchema(value: unknown) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function descriptorFromTool(tool: RegisteredTool): RelayDescriptor | null {
  if (typeof tool.name !== 'string' || !tool.name) return null;
  const inputSchema = normalizeInputSchema(tool.inputSchema);
  return {
    name: tool.name,
    ...(typeof tool.title === 'string' ? { title: tool.title } : {}),
    description: typeof tool.description === 'string' ? tool.description : '',
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  };
}

async function readRelayTools() {
  const context = getModelContext();
  if (!context?.getTools) return { tools: [] as RegisteredTool[], descriptors: [] as RelayDescriptor[] };
  try {
    const tools = await context.getTools() as RegisteredTool[];
    const descriptors = tools
      .map(descriptorFromTool)
      .filter((tool): tool is RelayDescriptor => tool !== null);
    return { tools, descriptors };
  } catch {
    return { tools: [] as RegisteredTool[], descriptors: [] as RelayDescriptor[] };
  }
}

function safeSend(target: WebSocket, value: unknown) {
  if (target.readyState !== WebSocket.OPEN) return false;
  try {
    target.send(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function normalizeToolResult(raw: unknown) {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      value = raw;
    }
  }

  if (isRecord(value) && Array.isArray(value.content)) return value;
  if (value === null || value === undefined) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Tool execution was interrupted before a result was returned.' }],
    };
  }
  return {
    content: [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value),
    }],
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Tool invocation timed out.')), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function invokeTool(name: string, args: JsonObject) {
  const context = getModelContext();
  if (!context?.getTools) throw new Error('WebMCP runtime is not ready in this tab.');
  const tools = await context.getTools() as RegisteredTool[];
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);

  if (context.executeTool) {
    return normalizeToolResult(await withTimeout(
      Promise.resolve(context.executeTool(tool, JSON.stringify(args))),
      INVOKE_TIMEOUT_MS,
    ));
  }
  if (typeof tool.execute === 'function') {
    return normalizeToolResult(await withTimeout(Promise.resolve(tool.execute(args)), INVOKE_TIMEOUT_MS));
  }
  throw new Error(`Tool ${name} is registered but cannot be executed by this WebMCP runtime.`);
}

function toolSnapshot(descriptors: RelayDescriptor[]) {
  return descriptors.map(stableStringify).sort().join('\n');
}

async function syncTools(forceList = false) {
  const context = getModelContext();
  subscribeToToolChanges(context);
  const { descriptors } = await readRelayTools();
  toolCount = descriptors.filter((tool) => tool.name.startsWith(TOOL_PREFIX)).length;
  const nextSnapshot = toolSnapshot(descriptors);
  const changed = nextSnapshot !== lastToolsSnapshot;
  if (changed) lastToolsSnapshot = nextSnapshot;

  const active = socket;
  if (active && state.phase === 'connected' && (forceList || changed)) {
    safeSend(active, {
      type: forceList ? 'tools/list' : 'tools/changed',
      tools: descriptors,
    });
  }
  scheduleUiPatch();
}

function subscribeToToolChanges(context: ModelContextLike | undefined) {
  if (!context || context === toolChangeSubscribedContext || !context.addEventListener) return;
  toolChangeSubscribedContext = context;
  try {
    context.addEventListener('toolchange', () => {
      void syncTools(false);
    });
  } catch {
    // Polling below remains the compatibility fallback.
  }
}

function clearHandshakeTimer() {
  if (handshakeTimer === null) return;
  window.clearTimeout(handshakeTimer);
  handshakeTimer = null;
}

function clearRetryTimer() {
  if (retryTimer === null) return;
  window.clearTimeout(retryTimer);
  retryTimer = null;
}

function updateState(
  phase: RelayPhase,
  detail: string,
  retryAt: number | null = state.retryAt,
  serverInstanceId: string | null = state.serverInstanceId,
) {
  state = {
    phase,
    detail,
    retryAt,
    connectedAt: phase === 'connected' ? (state.connectedAt ?? Date.now()) : state.connectedAt,
    serverInstanceId,
  };
  scheduleUiPatch();
}

function retryDelay() {
  const base = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
  const visibilityFloor = document.visibilityState === 'hidden' ? HIDDEN_TAB_RETRY_FLOOR_MS : 0;
  return Math.max(base, visibilityFloor);
}

function scheduleRetry(reason: string, quick = false) {
  if (!enabled || retryTimer !== null || state.phase === 'rejected') return;
  const delay = quick ? 750 : retryDelay();
  if (!quick) retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS_MS.length - 1);
  const retryAt = Date.now() + delay;
  updateState('waiting', reason, retryAt, null);
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    connectNow();
  }, delay);
}

function handleSocketFailure(target: WebSocket, generation: number, reason: string, quick = false) {
  if (generation !== socketGeneration || socket !== target) return;
  clearHandshakeTimer();
  socket = null;
  scheduleRetry(reason, quick);
}

function connectNow() {
  if (!enabled || socket || state.phase === 'rejected') return;
  if (!navigator.onLine) {
    scheduleRetry('Browser is offline. Waiting for network access.');
    return;
  }

  clearRetryTimer();
  const generation = ++socketGeneration;
  updateState('connecting', `Connecting to the local relay at ${RELAY_HOST}:${RELAY_PORT}…`, null, null);

  let target: WebSocket;
  try {
    target = new WebSocket(RELAY_URL, [RELAY_DISCOVERY_PROTOCOL, RELAY_BROWSER_PROTOCOL]);
  } catch {
    scheduleRetry(`Waiting for the local relay at ${RELAY_HOST}:${RELAY_PORT}.`);
    return;
  }
  socket = target;
  let helloReceived = false;
  let accepted = false;

  const fail = (reason: string, quick = false) => {
    try {
      if (target.readyState === WebSocket.OPEN || target.readyState === WebSocket.CONNECTING) target.close();
    } catch {
      // Close is best effort during a failed attempt.
    }
    handleSocketFailure(target, generation, reason, quick);
  };

  target.addEventListener('open', () => {
    if (generation !== socketGeneration || socket !== target) return;
    handshakeTimer = window.setTimeout(() => {
      if (!accepted) fail('Local relay did not complete the WebMCP handshake. Retrying automatically.');
    }, HANDSHAKE_TIMEOUT_MS);
  }, { once: true });

  target.addEventListener('message', (event) => {
    if (generation !== socketGeneration || socket !== target) return;
    let message: unknown;
    try {
      message = JSON.parse(String(event.data)) as unknown;
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.type !== 'string') return;

    if (message.type === 'server-hello') {
      if (
        message.service !== 'webmcp-local-relay' ||
        message.version !== 1 ||
        typeof message.instanceId !== 'string'
      ) {
        fail('A different service is using the configured local relay port.');
        return;
      }
      helloReceived = true;
      safeSend(target, {
        type: 'hello',
        tabId,
        origin: window.location.origin,
        title: document.title || 'Skill Tree Maker',
        url: cleanPageUrl(),
      });
      return;
    }

    if (message.type === 'hello/accepted') {
      if (!helloReceived) return;
      accepted = true;
      clearHandshakeTimer();
      retryIndex = 0;
      connectedOnce = true;
      state.connectedAt = Date.now();
      updateState(
        'connected',
        `Connected to the local relay at ${RELAY_HOST}:${RELAY_PORT}. This tab is registered and tool calls can flow through the tunnel runtime.`,
        null,
        typeof message.instanceId === 'string' ? message.instanceId : state.serverInstanceId,
      );
      void syncTools(true);
      return;
    }

    if (message.type === 'hello/rejected') {
      clearHandshakeTimer();
      const rejection = typeof message.message === 'string'
        ? message.message
        : 'The local relay rejected this page.';
      state.connectedAt = null;
      updateState('rejected', rejection, null, null);
      try {
        target.close(1008, 'Relay rejected browser hello');
      } catch {
        // Ignore close failures after a structured rejection.
      }
      return;
    }

    if (message.type === 'ping') {
      safeSend(target, { type: 'pong' });
      return;
    }

    if (message.type === 'reload') {
      window.location.reload();
      return;
    }

    if (message.type === 'invoke' && typeof message.callId === 'string' && typeof message.toolName === 'string') {
      const args = isRecord(message.args) ? message.args : {};
      void invokeTool(message.toolName, args).then(
        (result) => {
          safeSend(target, { type: 'result', callId: message.callId, result });
        },
        (error: unknown) => {
          safeSend(target, {
            type: 'result',
            callId: message.callId,
            result: {
              isError: true,
              content: [{
                type: 'text',
                text: error instanceof Error ? error.message : String(error),
              }],
            },
          });
        },
      );
    }
  });

  target.addEventListener('error', () => {
    // Chromium reports the failed WebSocket attempt itself in DevTools. Avoid
    // adding duplicate application warnings; close handling below owns retry.
  });

  target.addEventListener('close', () => {
    if (generation !== socketGeneration || socket !== target) return;
    clearHandshakeTimer();
    socket = null;
    if (!enabled || state.phase === 'rejected') return;
    state.connectedAt = null;
    scheduleRetry(
      connectedOnce
        ? 'Local relay connection was interrupted. Reconnecting automatically…'
        : `Waiting for the local relay at ${RELAY_HOST}:${RELAY_PORT}. Start the launcher in any order; this page will keep retrying.`,
      connectedOnce,
    );
    connectedOnce = false;
  }, { once: true });
}

function reconnectNow() {
  if (!enabled) {
    setEnabled(true);
    return;
  }
  state = { ...state, phase: 'waiting', retryAt: null };
  retryIndex = 0;
  clearRetryTimer();
  clearHandshakeTimer();
  const current = socket;
  socket = null;
  socketGeneration += 1;
  if (current) {
    try {
      current.close(1000, 'Manual reconnect');
    } catch {
      // Ignore close failures during manual reconnect.
    }
  }
  connectNow();
}

function statusClass(phase: RelayPhase) {
  if (phase === 'connected') return 'ready';
  if (phase === 'disabled' || phase === 'rejected') return 'missing';
  return 'external';
}

function statusText(phase: RelayPhase) {
  if (phase === 'connected') return 'Connected';
  if (phase === 'connecting') return 'Connecting';
  if (phase === 'waiting') return 'Waiting';
  if (phase === 'rejected') return 'Action needed';
  return 'Disabled';
}

function retryDetail() {
  if (state.phase !== 'waiting' || state.retryAt === null) return state.detail;
  const seconds = Math.max(1, Math.ceil((state.retryAt - Date.now()) / 1000));
  return `${state.detail} Next attempt in about ${seconds}s.`;
}

function setStatusRow(
  row: HTMLElement,
  label: string,
  detail: string,
  visualState: 'ready' | 'missing' | 'external',
  rightText: string,
) {
  const dot = row.querySelector<HTMLElement>('.webmcp-dot');
  if (dot) dot.className = `webmcp-dot is-${visualState}`;
  const strong = row.querySelector<HTMLElement>('strong');
  if (strong && strong.textContent !== label) strong.textContent = label;
  const small = row.querySelector<HTMLElement>('small');
  if (small && small.textContent !== detail) small.textContent = detail;
  const right = row.querySelector<HTMLElement>(':scope > span:last-child');
  if (right && right.textContent !== rightText) right.textContent = rightText;
}

function localSectionMarkup() {
  if (!enabled) {
    return `<div class="webmcp-section-title"><strong>1. Local browser bridge</strong><small>The direct connector is bundled with Skill Tree Maker and only connects to 127.0.0.1:${RELAY_PORT}. It does not load a third-party relay script or scan a range of localhost ports.</small></div><div class="webmcp-actions"><button type="button" data-local-relay-action="enable">Enable local bridge</button></div><small class="webmcp-note">Normal visitors do not probe localhost until this integration is enabled.</small>`;
  }
  const actionLabel = state.phase === 'connected' ? 'Reconnect now' : 'Retry now';
  return `<div class="webmcp-section-title"><strong>1. Local browser bridge</strong><small>The direct connector is bundled with Skill Tree Maker and uses one stable loopback endpoint: <code>${RELAY_HOST}:${RELAY_PORT}</code>. Startup order does not matter; reconnection is automatic.</small></div><div class="webmcp-actions"><button type="button" data-local-relay-action="reconnect">${actionLabel}</button><button type="button" data-local-relay-action="disable">Disable local bridge</button></div><small class="webmcp-note">If the launcher is not running yet, the page waits with bounded backoff instead of scanning ports. Refreshing this page or restarting the launcher automatically re-establishes the connection.</small>`;
}

function patchPanel(panel: HTMLElement) {
  const status = panel.querySelector<HTMLElement>('.webmcp-status');
  const rows = status ? Array.from(status.querySelectorAll<HTMLElement>('.webmcp-status-row')) : [];
  if (rows[2]) {
    setStatusRow(
      rows[2],
      'Built-in browser relay client',
      enabled
        ? `Bundled with Skill Tree Maker; fixed to loopback ${RELAY_HOST}:${RELAY_PORT} with quiet retry/backoff.`
        : 'Disabled for this browser profile; localhost is not being probed.',
      enabled ? 'ready' : 'missing',
      enabled ? 'Ready' : 'Disabled',
    );
  }
  if (rows[3]) {
    setStatusRow(
      rows[3],
      'Local MCP-B relay + OpenAI tunnel runtime',
      retryDetail(),
      statusClass(state.phase),
      statusText(state.phase),
    );
  }

  if (status) {
    let summary = panel.querySelector<HTMLElement>('.webmcp-local-summary');
    if (!summary) {
      summary = document.createElement('div');
      summary.className = 'webmcp-local-summary';
      status.after(summary);
    }
    const tunnelId = readTunnelId();
    const allReady = state.phase === 'connected' && toolCount > 0;
    summary.classList.toggle('is-ready', allReady);
    summary.classList.toggle('is-waiting', enabled && !allReady && state.phase !== 'rejected');
    summary.classList.toggle('is-error', state.phase === 'rejected');
    const message = allReady
      ? `Local computer connection is ready. ${toolCount} Skill Tree Maker tools from this tab are registered with the relay${tunnelId ? ` for ${tunnelId}` : ''}. Refreshes and temporary disconnects reconnect automatically.`
      : state.phase === 'rejected'
        ? 'The local relay is running but rejected this page. Re-download and run the launcher so its allowed origin matches this Skill Tree Maker site, then retry.'
        : enabled
          ? `Waiting for the local computer side to become available. You can launch the bridge before or after this page; it will connect automatically${toolCount ? ` once the relay is reachable (${toolCount} page tools are already ready)` : ''}.`
          : 'Local bridge is disabled. Enable it only when you want this browser tab exposed through your local OpenAI tunnel.';
    if (summary.textContent !== message) summary.textContent = message;
  }

  const firstSection = Array.from(panel.querySelectorAll<HTMLElement>(':scope > .webmcp-section')).find((section) =>
    section.querySelector('.webmcp-section-title strong')?.textContent?.trim() === '1. Enable the browser relay' ||
    section.querySelector('.webmcp-section-title strong')?.textContent?.trim() === '1. Local browser bridge',
  );
  if (firstSection) {
    const markup = localSectionMarkup();
    if (firstSection.innerHTML !== markup) firstSection.innerHTML = markup;
  }

  const footer = panel.querySelector<HTMLElement>('.webmcp-footer');
  if (footer) {
    const footerText = 'This page now verifies the full local browser side itself: WebMCP runtime, registered tools, and the live loopback relay connection. The OpenAI control-plane side remains managed by tunnel-client and ChatGPT.';
    if (footer.textContent !== footerText) footer.textContent = footerText;
  }
}

function patchUi() {
  uiPatchScheduled = false;
  persistRelayEnabled(enabled);
  removeLegacyRelayEmbed();

  const panel = document.querySelector<HTMLElement>('.webmcp-panel');
  if (panel) patchPanel(panel);

  const button = document.querySelector<HTMLElement>('.webmcp-button');
  if (button) {
    const allReady = state.phase === 'connected' && toolCount > 0;
    button.classList.toggle('is-ready', allReady);
    button.classList.toggle('is-waiting', enabled && !allReady);
    const status = button.querySelector<HTMLElement>('.webmcp-button-status');
    const text = allReady
      ? 'Connected'
      : enabled
        ? state.phase === 'connecting' ? 'Connecting' : 'Waiting'
        : toolCount ? `${toolCount} tools` : 'Setup';
    if (status && status.textContent !== text) status.textContent = text;
  }
}

function scheduleUiPatch() {
  if (uiPatchScheduled) return;
  uiPatchScheduled = true;
  window.requestAnimationFrame(patchUi);
}

function removeLegacyRelayEmbed() {
  document.getElementById('skill-tree-webmcp-relay-embed')?.remove();
  document.querySelectorAll<HTMLElement>('[data-webmcp-relay]').forEach((element) => element.remove());
}

function installUiObserver() {
  const control = document.querySelector<HTMLElement>('.webmcp-control');
  if (!control) return false;
  if (uiDiscoveryObserver) {
    uiDiscoveryObserver.disconnect();
    uiDiscoveryObserver = null;
  }
  if (!uiObserver) {
    uiObserver = new MutationObserver(scheduleUiPatch);
    uiObserver.observe(control, { childList: true, subtree: true, characterData: true });
  }
  scheduleUiPatch();
  return true;
}

function startUiDiscovery() {
  if (installUiObserver()) return;
  uiDiscoveryObserver = new MutationObserver(() => {
    if (installUiObserver()) uiDiscoveryObserver?.disconnect();
  });
  uiDiscoveryObserver.observe(document.documentElement, { childList: true, subtree: true });
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const directAction = target.closest<HTMLElement>('[data-local-relay-action]')?.dataset.localRelayAction;
  const legacyAction = target.closest<HTMLElement>('[data-webmcp-action]')?.dataset.webmcpAction;
  if (!directAction && legacyAction !== 'enable-relay' && legacyAction !== 'retry-relay') return;

  event.preventDefault();
  event.stopImmediatePropagation();
  if (directAction === 'disable') setEnabled(false);
  else if (directAction === 'reconnect' || legacyAction === 'retry-relay') reconnectNow();
  else setEnabled(true);
  scheduleUiPatch();
}, true);

window.addEventListener('focus', () => {
  if (enabled && state.phase !== 'connected' && state.phase !== 'rejected') reconnectNow();
});
window.addEventListener('online', () => {
  if (enabled && state.phase !== 'connected' && state.phase !== 'rejected') reconnectNow();
});
window.addEventListener('offline', () => {
  if (!enabled) return;
  clearRetryTimer();
  updateState('waiting', 'Browser is offline. Waiting for network access.', null, null);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && enabled && state.phase !== 'connected' && state.phase !== 'rejected') {
    reconnectNow();
  }
});
window.addEventListener('beforeunload', () => {
  clearRetryTimer();
  clearHandshakeTimer();
  if (toolPollTimer !== null) window.clearInterval(toolPollTimer);
  try {
    socket?.close(1000, 'Page unloading');
  } catch {
    // Ignore shutdown races.
  }
});

removeLegacyRelayEmbed();
startUiDiscovery();
void syncTools(false);
toolPollTimer = window.setInterval(() => {
  void syncTools(false);
  if (state.phase === 'waiting' && state.retryAt !== null) scheduleUiPatch();
}, TOOL_POLL_INTERVAL_MS);

if (enabled) connectNow();
else scheduleUiPatch();
