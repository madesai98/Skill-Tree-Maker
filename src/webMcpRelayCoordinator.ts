import {
  startBrowserMcpRelay,
  stopBrowserMcpRelay,
} from './webMcpRelayClient';
import type { BrowserModelContext } from './webMcpSchema';

const LOCK_NAME = 'skill-tree-maker:mcp-relay-publisher:v1';
const CHANNEL_NAME = 'skill-tree-maker:mcp-relay-coordinator:v1';
const PREFERENCE_KEY = 'skill-tree:mcp-relay-preferred-tab:v1';
const FALLBACK_OWNER_KEY = 'skill-tree:mcp-relay-owner:v1';
const PREFERENCE_WINDOW_MS = 1_500;
const RETRY_INTERVAL_MS = 1_000;
const FALLBACK_LEASE_MS = 3_500;

type OwnershipPhase = 'idle' | 'active' | 'standby';
type CoordinatorMessage = {
  type: 'prefer';
  instanceId: string;
  at: number;
};
type FallbackOwner = {
  instanceId: string;
  updatedAt: number;
};

export type BrowserRelayOwnershipState = {
  phase: OwnershipPhase;
  detail: string;
  instanceId: string;
};

const listeners = new Set<(state: BrowserRelayOwnershipState) => void>();
const instanceId = typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `stm-relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

let targetContext: BrowserModelContext | null = null;
let enabled = false;
let initialized = false;
let lockRequestActive = false;
let releaseCurrentLock: (() => void) | null = null;
let preferredInstanceId: string | null = null;
let preferredUntil = 0;
let retryTimer: number | null = null;
let channel: BroadcastChannel | null = null;
let state: BrowserRelayOwnershipState = {
  phase: 'idle',
  detail: 'MCP relay coordination is idle.',
  instanceId,
};

function emitState(next: BrowserRelayOwnershipState) {
  state = next;
  for (const listener of listeners) listener(state);
}

function setState(phase: OwnershipPhase, detail: string) {
  if (state.phase === phase && state.detail === detail) return;
  emitState({ phase, detail, instanceId });
}

function parsePreference(value: string | null): CoordinatorMessage | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CoordinatorMessage>;
    if (parsed.type !== 'prefer' || typeof parsed.instanceId !== 'string' || typeof parsed.at !== 'number') return null;
    return { type: 'prefer', instanceId: parsed.instanceId, at: parsed.at };
  } catch {
    return null;
  }
}

function parseFallbackOwner(value: string | null): FallbackOwner | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<FallbackOwner>;
    if (typeof parsed.instanceId !== 'string' || typeof parsed.updatedAt !== 'number') return null;
    return { instanceId: parsed.instanceId, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

function readFallbackOwner() {
  try {
    return parseFallbackOwner(localStorage.getItem(FALLBACK_OWNER_KEY));
  } catch {
    return null;
  }
}

function writeFallbackOwner() {
  try {
    localStorage.setItem(FALLBACK_OWNER_KEY, JSON.stringify({ instanceId, updatedAt: Date.now() } satisfies FallbackOwner));
    return readFallbackOwner()?.instanceId === instanceId;
  } catch {
    return false;
  }
}

function clearFallbackOwner() {
  try {
    if (readFallbackOwner()?.instanceId === instanceId) localStorage.removeItem(FALLBACK_OWNER_KEY);
  } catch {
    // Storage cleanup is best effort.
  }
}

function becomeActive(detail = 'This is the active Skill Tree Maker MCP tab.') {
  if (!enabled || !targetContext) return;
  if (state.phase !== 'active') startBrowserMcpRelay(targetContext);
  setState('active', detail);
}

function becomeStandby(detail = 'Another Skill Tree Maker tab is the active MCP publisher.') {
  if (state.phase === 'active') stopBrowserMcpRelay();
  setState('standby', detail);
}

function hasWebLocks() {
  return typeof navigator.locks?.request === 'function';
}

function releaseLeadership(detail = 'Another Skill Tree Maker tab is taking over the MCP bridge.') {
  if (state.phase === 'active') becomeStandby(detail);
  if (hasWebLocks()) {
    const release = releaseCurrentLock;
    releaseCurrentLock = null;
    release?.();
  } else {
    clearFallbackOwner();
  }
}

function preferenceBlocksThisTab() {
  return preferredInstanceId !== null
    && preferredInstanceId !== instanceId
    && Date.now() < preferredUntil;
}

function applyPreference(message: CoordinatorMessage) {
  if (message.instanceId === instanceId) return;
  preferredInstanceId = message.instanceId;
  preferredUntil = Math.max(preferredUntil, message.at + PREFERENCE_WINDOW_MS);
  if (state.phase === 'active') {
    releaseLeadership('A different focused Skill Tree Maker tab is now publishing MCP tools.');
  } else {
    setState('standby', 'Another focused Skill Tree Maker tab is publishing MCP tools.');
  }
}

function publishPreference() {
  if (!enabled) return;
  const message: CoordinatorMessage = { type: 'prefer', instanceId, at: Date.now() };
  preferredInstanceId = instanceId;
  preferredUntil = message.at + PREFERENCE_WINDOW_MS;
  try {
    channel?.postMessage(message);
  } catch {
    // Storage below provides a second cross-tab signal.
  }
  try {
    localStorage.setItem(PREFERENCE_KEY, JSON.stringify(message));
  } catch {
    // Web Locks still prevent duplicate publishers when storage is unavailable.
  }
  requestLeadership(true);
}

function requestWebLock() {
  if (!enabled || !targetContext || lockRequestActive || state.phase === 'active' || preferenceBlocksThisTab()) return;
  lockRequestActive = true;
  void navigator.locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock || !enabled || !targetContext) return;
    becomeActive();
    await new Promise<void>((resolve) => {
      releaseCurrentLock = resolve;
    });
  }).catch(() => {
    setState('standby', 'Could not acquire the browser MCP publisher lock. Retrying automatically.');
  }).finally(() => {
    releaseCurrentLock = null;
    lockRequestActive = false;
  });
}

function requestFallbackLeadership(force = false) {
  if (!enabled || !targetContext) return;
  const now = Date.now();
  const owner = readFallbackOwner();
  const ownerAlive = owner && now - owner.updatedAt < FALLBACK_LEASE_MS;
  if (!force && ownerAlive && owner.instanceId !== instanceId) {
    becomeStandby();
    return;
  }
  if (writeFallbackOwner()) becomeActive('This is the active Skill Tree Maker MCP tab (storage coordination fallback).');
  else becomeStandby();
}

function requestLeadership(force = false) {
  if (!enabled || !targetContext) return;
  if (hasWebLocks()) {
    requestWebLock();
    return;
  }
  requestFallbackLeadership(force);
}

function coordinationTick() {
  if (!enabled) return;

  if (hasWebLocks()) {
    if (state.phase === 'active') return;
    if (document.hasFocus()) {
      publishPreference();
      return;
    }
    requestLeadership(false);
    return;
  }

  const owner = readFallbackOwner();
  if (state.phase === 'active') {
    if (owner && owner.instanceId !== instanceId && Date.now() - owner.updatedAt < FALLBACK_LEASE_MS) {
      becomeStandby();
      return;
    }
    if (!writeFallbackOwner()) becomeStandby();
    return;
  }
  requestFallbackLeadership(document.hasFocus());
}

function installCoordinator() {
  if (initialized) return;
  initialized = true;

  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      const value = event.data as Partial<CoordinatorMessage> | null;
      if (!value || value.type !== 'prefer' || typeof value.instanceId !== 'string' || typeof value.at !== 'number') return;
      applyPreference({ type: 'prefer', instanceId: value.instanceId, at: value.at });
    });
  }

  window.addEventListener('storage', (event) => {
    if (!enabled) return;
    if (event.key === PREFERENCE_KEY) {
      const message = parsePreference(event.newValue);
      if (message) applyPreference(message);
      return;
    }
    if (!hasWebLocks() && event.key === FALLBACK_OWNER_KEY) {
      const owner = parseFallbackOwner(event.newValue);
      if (owner && owner.instanceId !== instanceId && Date.now() - owner.updatedAt < FALLBACK_LEASE_MS) {
        becomeStandby();
      } else if (!owner) {
        requestFallbackLeadership(document.hasFocus());
      }
    }
  });

  window.addEventListener('focus', publishPreference);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && document.hasFocus()) publishPreference();
  });
  window.addEventListener('pagehide', () => {
    releaseLeadership('This tab is no longer the active page.');
  });
  window.addEventListener('pageshow', () => {
    if (!enabled || !targetContext) return;
    if (document.hasFocus()) publishPreference();
    else requestLeadership(false);
  });

  retryTimer = window.setInterval(coordinationTick, RETRY_INTERVAL_MS);
}

export function startCoordinatedBrowserMcpRelay(target: BrowserModelContext) {
  targetContext = target;
  enabled = true;
  installCoordinator();
  setState('standby', 'Choosing the active Skill Tree Maker MCP tab…');
  if (document.hasFocus()) publishPreference();
  else requestLeadership(false);
}

export function stopCoordinatedBrowserMcpRelay() {
  enabled = false;
  releaseLeadership('MCP relay coordination stopped.');
  targetContext = null;
  preferredInstanceId = null;
  preferredUntil = 0;
  setState('idle', 'MCP relay coordination is idle.');
}

export function getBrowserRelayOwnershipState() {
  return state;
}

export function subscribeBrowserRelayOwnershipState(listener: (next: BrowserRelayOwnershipState) => void) {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}
