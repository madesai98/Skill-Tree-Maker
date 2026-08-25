type McpBInitOptions = {
  autoInitialize?: boolean;
  nativeModelContextBehavior?: 'preserve' | 'patch';
};

type McpBWindow = Window & typeof globalThis & {
  __webModelContextOptions?: McpBInitOptions;
};

const mcpWindow = window as McpBWindow;

// webMcp.ts predates the current @mcp-b/global transport contract and writes an
// options object that disables both built-in transports. MCP-B cannot
// auto-initialize in that state. Normalize that one assignment before the
// runtime module is loaded; the local relay is provided separately by its
// browser embed, so MCP-B should use its normal main-window transport setup.
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
