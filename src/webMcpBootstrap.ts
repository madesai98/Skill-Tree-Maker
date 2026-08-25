type McpBInitOptions = {
  autoInitialize?: boolean;
  nativeModelContextBehavior?: 'preserve' | 'patch';
};

type RelayBootstrapState = {
  enabled: boolean;
  tunnelId: string;
};

type McpBWindow = Window & typeof globalThis & {
  __webModelContextOptions?: McpBInitOptions;
  __skillTreeMcpRelayBootstrap?: RelayBootstrapState;
};

const mcpWindow = window as McpBWindow;
const relaySettingsKey = 'skill-tree:webmcp-settings:v2';
const relaySettingsFallbackKeys = [
  'skill-tree:webmcp-settings:v1',
  'skill-tree:local-mcp-settings:v1',
];

function readRelayBootstrapState(): RelayBootstrapState {
  for (const key of [relaySettingsKey, ...relaySettingsFallbackKeys]) {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? '') as {
        tunnelId?: unknown;
        relayEnabled?: unknown;
      };
      const tunnelId = typeof value.tunnelId === 'string' ? value.tunnelId.trim() : '';
      if (!tunnelId && typeof value.relayEnabled !== 'boolean') continue;
      return {
        tunnelId,
        enabled: typeof value.relayEnabled === 'boolean' ? value.relayEnabled : Boolean(tunnelId),
      };
    } catch {
      // Try the next saved settings source.
    }
  }
  return { enabled: false, tunnelId: '' };
}

// The legacy WebMCP module still contains the old CDN-hosted MCP-B relay embed.
// Capture the user's relay preference, then make that module observe the relay as
// disabled for this page load. webMcpLocalConnection.ts owns the loopback
// connection instead, so we avoid the embed's multi-port WebSocket scan and its
// associated browser-console noise. Restore storage after module evaluation so
// the user's actual preference remains persistent.
const relayBootstrap = readRelayBootstrapState();
mcpWindow.__skillTreeMcpRelayBootstrap = relayBootstrap;
try {
  const original = localStorage.getItem(relaySettingsKey);
  let originalObject: Record<string, unknown> = {};
  try {
    originalObject = JSON.parse(original ?? '{}') as Record<string, unknown>;
  } catch {
    originalObject = {};
  }
  const temporary = JSON.stringify({
    ...originalObject,
    tunnelId: relayBootstrap.tunnelId,
    relayEnabled: false,
  });
  localStorage.setItem(relaySettingsKey, temporary);
  window.setTimeout(() => {
    try {
      if (localStorage.getItem(relaySettingsKey) !== temporary) return;
      if (original === null) localStorage.removeItem(relaySettingsKey);
      else localStorage.setItem(relaySettingsKey, original);
    } catch {
      // Storage restoration is best effort; the direct relay keeps its in-memory state.
    }
  }, 0);
} catch {
  // Private browsing/storage restrictions should not block WebMCP initialization.
}

// webMcp.ts predates the current @mcp-b/global transport contract and writes an
// options object that disables both built-in transports. MCP-B cannot
// auto-initialize in that state. Normalize that one assignment before the
// runtime module is loaded. The local relay is handled separately by the
// Skill Tree Maker direct loopback client.
Object.defineProperty(mcpWindow, '__webModelContextOptions', {
  configurable: true,
  set(value: McpBInitOptions | undefined) {
    Object.defineProperty(mcpWindow, '__webModelContextOptions', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: {
        autoInitialize: value?.autoInitialize ?? true,
        nativeModelContextBehavior: value?.nativeModelContextBehavior ?? 'preserve',
      } satisfies McpBInitOptions,
    });
  },
});
