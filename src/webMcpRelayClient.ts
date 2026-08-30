import {
  normalizeToolDefinition,
  type BrowserMcpTool,
  type BrowserModelContext,
  type McpToolResponse,
} from './webMcpSchema';

const RELAY_HOST = '127.0.0.1';
const RELAY_PORT = 9333;
const RELAY_URL = `ws://${RELAY_HOST}:${RELAY_PORT}`;
const RELAY_DISCOVERY_PROTOCOL = 'webmcp-discovery.v1';
const RELAY_BROWSER_PROTOCOL = 'webmcp.v1';
const TAB_ID_KEY = 'skill-tree:mcp-relay-tab-id:v1';
const INVOKE_TIMEOUT_MS = 120_000;
const HANDSHAKE_TIMEOUT_MS = 4_000;
const TOOL_POLL_INTERVAL_MS = 1_000;
const RETRY_DELAYS_MS = [250, 250, 500, 500, 1_000, 1_000, 2_000, 5_000, 10_000];

type JsonRecord = Record<string, unknown>;
type RelayPhase = 'idle' | 'waiting' | 'connecting' | 'connected' | 'rejected';
type ExecutableModelContext = BrowserModelContext & EventTarget & {
  executeTool?: (tool: { name?: string }, serializedArgs: string) => Promise<unknown>;
};

type RelayToolDescriptor = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export type BrowserRelayState = {
  phase: RelayPhase;
  detail: string;
  publishedToolCount: number;
  connectedAt: number | null;
  serverInstanceId: string | null;
};

const listeners = new Set<(state: BrowserRelayState) => void>();
const capturedTools = new WeakMap<BrowserModelContext, Map<string, BrowserMcpTool>>();
const capturedContexts = new WeakSet<object>();

let context: ExecutableModelContext | null = null;
let socket: WebSocket | null = null;
let socketGeneration = 0;
let retryTimer: number | null = null;
let handshakeTimer: number | null = null;
let toolPollTimer: number | null = null;
let retryIndex = 0;
let lastToolsSnapshot = '';
let toolChangeContext: ExecutableModelContext | null = null;
let enabled = false;
let serverInstanceId: string | null = null;
let state: BrowserRelayState = {
  phase: 'idle',
  detail: 'MCP relay client is idle.',
  publishedToolCount: 0,
  connectedAt: null,
  serverInstanceId: null,
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function emitState(next: BrowserRelayState) {
  state = next;
  for (const listener of listeners) listener(state);
}

function patchState(patch: Partial<BrowserRelayState>) {
  emitState({ ...state, ...patch });
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
      : `skill-tree-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function installToolCapture(target: BrowserModelContext) {
  if (capturedContexts.has(target)) return;
  capturedContexts.add(target);
  const registry = capturedTools.get(target) ?? new Map<string, BrowserMcpTool>();
  capturedTools.set(target, registry);
  const originalRegisterTool = target.registerTool.bind(target);

  const capturedRegisterTool: BrowserModelContext['registerTool'] = async (tool, options) => {
    const normalized = normalizeToolDefinition(tool);
    await originalRegisterTool(tool, options);
    registry.set(normalized.name, normalized);
    if (options?.signal) {
      options.signal.addEventListener('abort', () => registry.delete(normalized.name), { once: true });
    }
  };

  Object.defineProperty(target, 'registerTool', {
    configurable: true,
    writable: true,
    value: capturedRegisterTool,
  });
}

async function readRelayTools(): Promise<RelayToolDescriptor[]> {
  if (!context) return [];
  const captured = capturedTools.get(context);
  if (captured?.size) {
    return [...captured.values()].map((tool) => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false },
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}),
    }));
  }

  if (!context.getTools) return [];
  const tools = await context.getTools();
  return tools
    .filter((tool): tool is { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> } =>
      typeof tool.name === 'string' && Boolean(tool.name))
    .map((tool) => ({
      name: tool.name,
      ...(typeof tool.title === 'string' && tool.title ? { title: tool.title } : {}),
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
      ...(isRecord(tool.annotations) ? { annotations: tool.annotations } : {}),
    }));
}

function toolSnapshot(tools: RelayToolDescriptor[]) {
  return tools.map(stableStringify).sort().join('\n');
}

function safeSend(target: WebSocket, message: unknown) {
  if (target.readyState !== WebSocket.OPEN) return false;
  try {
    target.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function normalizeToolResult(value: unknown): McpToolResponse {
  if (value === null) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Tool execution was interrupted before returning a result.' }],
    };
  }

  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      parsed = value;
    }
  }
  if (isRecord(parsed) && Array.isArray(parsed.content)) return parsed as McpToolResponse;
  return {
    content: [{
      type: 'text',
      text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2) ?? String(parsed),
    }],
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Tool invocation timed out.')), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function invokeRelayTool(name: string, args: JsonRecord): Promise<McpToolResponse> {
  if (!context) throw new Error('The Skill Tree Maker MCP runtime is not available.');

  if (context.getTools && typeof context.executeTool === 'function') {
    const tools = await context.getTools();
    const descriptor = tools.find((tool) => tool.name === name);
    if (descriptor) {
      return normalizeToolResult(await withTimeout(
        context.executeTool(descriptor, JSON.stringify(args)),
        INVOKE_TIMEOUT_MS,
      ));
    }
  }

  const captured = capturedTools.get(context)?.get(name);
  if (!captured) throw new Error(`Tool not found: ${name}`);
  return normalizeToolResult(await withTimeout(Promise.resolve(captured.execute(args)), INVOKE_TIMEOUT_MS));
}

async function publishTools(forceList = false) {
  const tools = await readRelayTools();
  const nextSnapshot = toolSnapshot(tools);
  const changed = nextSnapshot !== lastToolsSnapshot;
  lastToolsSnapshot = nextSnapshot;
  patchState({ publishedToolCount: tools.filter((tool) => tool.name.startsWith('skill_tree_')).length });

  const active = socket;
  if (!active || state.phase !== 'connected' || (!forceList && !changed)) return;
  safeSend(active, { type: forceList ? 'tools/list' : 'tools/changed', tools });
}

function subscribeToToolChanges(target: ExecutableModelContext) {
  if (toolChangeContext === target) return;
  toolChangeContext = target;
  try {
    target.addEventListener('toolchange', () => void publishTools(false));
  } catch {
    // Polling below is the compatibility fallback.
  }
  if (toolPollTimer !== null) window.clearInterval(toolPollTimer);
  toolPollTimer = window.setInterval(() => void publishTools(false), TOOL_POLL_INTERVAL_MS);
}

function clearRetryTimer() {
  if (retryTimer === null) return;
  window.clearTimeout(retryTimer);
  retryTimer = null;
}

function clearHandshakeTimer() {
  if (handshakeTimer === null) return;
  window.clearTimeout(handshakeTimer);
  handshakeTimer = null;
}

function retryDelay() {
  return RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
}

function scheduleRetry(detail = 'Waiting for the local MCP bridge command to start.') {
  if (!enabled || retryTimer !== null || state.phase === 'rejected') return;
  const delay = retryDelay();
  retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS_MS.length - 1);
  patchState({ phase: 'waiting', detail, serverInstanceId: null });
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    connectNow();
  }, delay);
}

function failSocket(target: WebSocket, generation: number, detail: string) {
  if (generation !== socketGeneration || socket !== target) return;
  clearHandshakeTimer();
  socket = null;
  try {
    target.close();
  } catch {
    // Best effort during failed connection cleanup.
  }
  scheduleRetry(detail);
}

function connectNow() {
  if (!enabled || socket || state.phase === 'rejected') return;
  clearRetryTimer();
  const generation = ++socketGeneration;
  patchState({
    phase: 'connecting',
    detail: `Connecting to the local MCP bridge at ${RELAY_HOST}:${RELAY_PORT}…`,
  });

  let target: WebSocket;
  try {
    target = new WebSocket(RELAY_URL, [RELAY_DISCOVERY_PROTOCOL, RELAY_BROWSER_PROTOCOL]);
  } catch {
    scheduleRetry();
    return;
  }
  socket = target;
  let serverHelloSeen = false;
  let accepted = false;

  target.addEventListener('open', () => {
    handshakeTimer = window.setTimeout(() => {
      if (!accepted) failSocket(target, generation, 'The local MCP bridge did not complete its browser handshake. Retrying.');
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
      if (message.service !== 'webmcp-local-relay' || message.version !== 1 || typeof message.instanceId !== 'string') {
        failSocket(target, generation, 'A different service is using the local MCP bridge port.');
        return;
      }
      serverHelloSeen = true;
      serverInstanceId = message.instanceId;
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
      if (!serverHelloSeen) return;
      accepted = true;
      clearHandshakeTimer();
      retryIndex = 0;
      patchState({
        phase: 'connected',
        detail: 'Bridge connected. Skill Tree Maker tools are being published directly to the MCP server.',
        connectedAt: Date.now(),
        serverInstanceId,
      });
      void publishTools(true);
      return;
    }

    if (message.type === 'hello/rejected') {
      clearHandshakeTimer();
      socket = null;
      patchState({
        phase: 'rejected',
        detail: typeof message.message === 'string' ? message.message : 'The local MCP bridge rejected this page.',
        serverInstanceId: null,
      });
      try {
        target.close(1008, 'Relay rejected browser hello');
      } catch {
        // Best effort after structured rejection.
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
      void invokeRelayTool(message.toolName, args).then(
        (result) => safeSend(target, { type: 'result', callId: message.callId, result }),
        (error: unknown) => safeSend(target, {
          type: 'result',
          callId: message.callId,
          result: {
            isError: true,
            content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          },
        }),
      );
    }
  });

  target.addEventListener('error', () => {
    try {
      target.close();
    } catch {
      // Close handling owns retry state.
    }
  });

  target.addEventListener('close', () => {
    if (generation !== socketGeneration || socket !== target) return;
    clearHandshakeTimer();
    socket = null;
    if (state.phase === 'rejected') return;
    patchState({ connectedAt: null, serverInstanceId: null });
    scheduleRetry('The local MCP bridge is not running yet, or the connection closed. Retrying automatically.');
  }, { once: true });
}

export function startBrowserMcpRelay(target: BrowserModelContext) {
  context = target as ExecutableModelContext;
  enabled = true;
  installToolCapture(target);
  subscribeToToolChanges(context);
  void publishTools(false);
  connectNow();
}

export function stopBrowserMcpRelay() {
  enabled = false;
  clearRetryTimer();
  clearHandshakeTimer();
  retryIndex = 0;
  const active = socket;
  socket = null;
  if (active) {
    try {
      active.close(1000, 'MCP disabled');
    } catch {
      // Best effort during shutdown.
    }
  }
  patchState({
    phase: 'idle',
    detail: 'MCP relay client is idle.',
    connectedAt: null,
    serverInstanceId: null,
  });
}

export function getBrowserRelayState() {
  return state;
}

export function subscribeBrowserRelayState(listener: (next: BrowserRelayState) => void) {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

window.addEventListener('focus', () => {
  if (enabled && !socket && state.phase !== 'rejected') connectNow();
});
document.addEventListener('visibilitychange', () => {
  if (enabled && document.visibilityState === 'visible' && !socket && state.phase !== 'rejected') connectNow();
});
