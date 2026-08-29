export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type McpToolContent = {
  type?: string;
  text?: string;
  [key: string]: unknown;
};

export type McpToolResponse = {
  content?: McpToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
};

export type BrowserMcpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  execute: (input: Record<string, unknown>) => unknown | Promise<unknown>;
  [key: string]: unknown;
};

export type BrowserModelContext = {
  registerTool: (tool: BrowserMcpTool, options?: { signal?: AbortSignal }) => void | Promise<void>;
  getTools?: () => Promise<Array<{ name?: string }>>;
};

const patchedContexts = new WeakSet<object>();

const PARAMETER_DESCRIPTIONS: Record<string, string> = {
  skill: 'Skill ID or exact skill name. Use the ID when a name is ambiguous.',
  perk: 'Perk ID or exact perk name.',
  target: 'Target skill or perk ID or exact name, as selected by kind.',
  prerequisite: 'Parent prerequisite skill ID or exact skill name.',
  group: 'Stat group ID, group key, or exact group name.',
  stat: 'Stat ID, full stat key, or exact stat name.',
  currency: 'Currency ID, currency key, or exact currency name.',
  icon: 'Icon ID or exact icon name.',
  upgrade: 'Upgrade effect ID on the target skill or perk.',
  name: 'Human-readable display name.',
  key: 'Stable project key. When omitted, Skill Tree Maker derives one from the display name.',
  type: 'Value type used by the selected project entity.',
  color: 'Six-digit hexadecimal color in #RRGGBB form.',
  iconId: 'Icon ID or exact icon name. Use null to clear the icon where supported.',
  primaryIconId: 'Primary icon ID or exact icon name. Use null to clear it.',
  secondaryIconId: 'Secondary icon ID or exact icon name. Use null to clear it.',
  secondaryColor: 'Secondary six-digit hexadecimal color in #RRGGBB form. Use null to clear it.',
  x: 'Canvas X coordinate in editor coordinate space.',
  y: 'Canvas Y coordinate in editor coordinate space.',
  currencyId: 'Currency ID used for the skill cost.',
  costAmount: 'Non-negative numeric skill cost amount.',
  kind: 'Target entity kind: skill or perk.',
  operator: 'Upgrade operation applied to the selected stat.',
  value: 'Value applied by the selected upgrade operation.',
  size: 'Perks grid spacing in editor pixels.',
  view: 'Editor view to activate.',
  cursor: 'Atomic history cursor index. -1 represents the state before the first recorded change.',
  project: 'Complete Skill Tree Maker project object, or a JSON string containing that project.',
  config: 'Firebase web configuration object used by the project manager.',
  mode: 'Project storage mode: local browser storage or online Firebase storage.',
  projectId: 'Project ID in the selected storage mode.',
  firstStatName: 'Display name for the initial stat created with a new stat group.',
  firstStatKey: 'Local key for the initial stat created with a new stat group.',
  firstStatType: 'Value type for the initial stat: number or boolean.',
  firstStatBaseValue: 'Base value for the initial stat. Its JSON type must match firstStatType.',
  firstStatIconId: 'Icon ID or exact icon name for the initial stat. Use null for no icon.',
  baseValue: 'Base stat value. Its JSON type must match the stat type.',
  svg: 'SVG markup for the icon asset. The editor sanitizes the markup before storing it.',
  platform: 'Target platform identifier.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function humanize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (character) => character.toUpperCase());
}

function parameterDescription(name: string, toolTitle: string) {
  return PARAMETER_DESCRIPTIONS[name]
    ?? `${humanize(name)} accepted by ${toolTitle}. Omit this optional field when no change is requested.`;
}

function enrichSchemaNode(value: unknown, propertyName: string | null, toolTitle: string): unknown {
  if (Array.isArray(value)) return value.map((item) => enrichSchemaNode(item, propertyName, toolTitle));
  if (!isRecord(value)) return value;

  const schema = cloneRecord(value);
  if (propertyName) {
    if (typeof schema.title !== 'string' || !schema.title.trim()) schema.title = humanize(propertyName);
    if (typeof schema.description !== 'string' || !schema.description.trim()) {
      schema.description = parameterDescription(propertyName, toolTitle);
    }
  }

  if (isRecord(schema.properties)) {
    schema.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [
      name,
      enrichSchemaNode(child, name, toolTitle),
    ]));
  }

  if (isRecord(schema.patternProperties)) {
    schema.patternProperties = Object.fromEntries(Object.entries(schema.patternProperties).map(([pattern, child]) => [
      pattern,
      enrichSchemaNode(child, propertyName, toolTitle),
    ]));
  }

  for (const keyword of ['items', 'contains', 'additionalProperties', 'propertyNames', 'not', 'if', 'then', 'else']) {
    if (isRecord(schema[keyword])) schema[keyword] = enrichSchemaNode(schema[keyword], propertyName, toolTitle);
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(schema[keyword])) schema[keyword] = enrichSchemaNode(schema[keyword], propertyName, toolTitle);
  }
  for (const keyword of ['$defs', 'definitions', 'dependentSchemas']) {
    if (!isRecord(schema[keyword])) continue;
    schema[keyword] = Object.fromEntries(Object.entries(schema[keyword] as Record<string, unknown>).map(([name, child]) => [
      name,
      enrichSchemaNode(child, name, toolTitle),
    ]));
  }

  return schema;
}

function normalizeProjectProperty(schema: Record<string, unknown>) {
  if (!isRecord(schema.properties)) return schema;
  const project = schema.properties.project;
  if (isRecord(project) && Object.keys(project).length === 0) {
    schema.properties = {
      ...schema.properties,
      project: {
        title: 'Project',
        description: PARAMETER_DESCRIPTIONS.project,
        anyOf: [
          { type: 'object', title: 'Project object', description: 'Complete Skill Tree Maker project object.' },
          { type: 'string', title: 'Project JSON', description: 'JSON string containing a complete Skill Tree Maker project.' },
        ],
      },
    };
  }
  const config = schema.properties.config;
  if (isRecord(config) && Object.keys(config).length === 0) {
    schema.properties = {
      ...schema.properties,
      config: {
        type: 'object',
        title: 'Firebase configuration',
        description: PARAMETER_DESCRIPTIONS.config,
        additionalProperties: true,
      },
    };
  }
  return schema;
}

export function normalizeInputSchema(tool: BrowserMcpTool) {
  const toolTitle = tool.title?.trim() || humanize(tool.name);
  const source = isRecord(tool.inputSchema) ? cloneRecord(tool.inputSchema) : {};
  const root = normalizeProjectProperty(source);
  root.$schema = JSON_SCHEMA_2020_12;
  root.type = 'object';
  if (!isRecord(root.properties)) root.properties = {};
  if (!Array.isArray(root.required)) root.required = [];
  if (root.additionalProperties === undefined) root.additionalProperties = false;
  if (typeof root.title !== 'string' || !root.title.trim()) root.title = `${toolTitle} input`;
  if (typeof root.description !== 'string' || !root.description.trim()) {
    root.description = `Input parameters for the ${toolTitle} MCP tool.`;
  }
  return enrichSchemaNode(root, null, toolTitle) as Record<string, unknown>;
}

export function normalizeOutputSchema(tool: BrowserMcpTool) {
  const toolTitle = tool.title?.trim() || humanize(tool.name);
  const root = isRecord(tool.outputSchema) ? cloneRecord(tool.outputSchema) : {};
  root.$schema = JSON_SCHEMA_2020_12;
  if (typeof root.title !== 'string' || !root.title.trim()) root.title = `${toolTitle} output`;
  if (typeof root.description !== 'string' || !root.description.trim()) {
    root.description = `Structured JSON result returned by the ${toolTitle} MCP tool.`;
  }
  return root;
}

function normalizeAnnotations(tool: BrowserMcpTool): McpToolAnnotations {
  const source = tool.annotations ?? {};
  const readOnlyHint = source.readOnlyHint === true;
  const destructiveHint = source.destructiveHint ?? !readOnlyHint;
  return {
    title: source.title?.trim() || tool.title?.trim() || humanize(tool.name),
    readOnlyHint,
    destructiveHint,
    idempotentHint: source.idempotentHint ?? readOnlyHint,
    openWorldHint: source.openWorldHint ?? false,
  };
}

function withStructuredContent(value: unknown) {
  if (!isRecord(value) || value.structuredContent !== undefined) return value;
  const content = Array.isArray(value.content) ? value.content : [];
  const text = content.find((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string');
  if (!isRecord(text) || typeof text.text !== 'string') return value;
  try {
    return { ...value, structuredContent: JSON.parse(text.text) as unknown };
  } catch {
    return value;
  }
}

export function normalizeToolDefinition(tool: BrowserMcpTool): BrowserMcpTool {
  const originalExecute = tool.execute;
  return {
    ...tool,
    title: tool.title?.trim() || humanize(tool.name),
    description: tool.description?.trim() || `${humanize(tool.name)} in the active Skill Tree Maker browser project.`,
    inputSchema: normalizeInputSchema(tool),
    outputSchema: normalizeOutputSchema(tool),
    annotations: normalizeAnnotations(tool),
    execute: async (input) => withStructuredContent(await originalExecute(input)),
  };
}

export function installMcpSchemaNormalization(context: BrowserModelContext) {
  if (patchedContexts.has(context)) return;
  const originalRegisterTool = context.registerTool.bind(context);
  const normalizedRegisterTool: BrowserModelContext['registerTool'] = (tool, options) =>
    originalRegisterTool(normalizeToolDefinition(tool), options);

  Object.defineProperty(context, 'registerTool', {
    configurable: true,
    writable: true,
    value: normalizedRegisterTool,
  });
  patchedContexts.add(context);
}
