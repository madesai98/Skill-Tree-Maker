import { HISTORY_APPLY_EVENT, getHistoryProject, type HistoryApplyDetail } from './history';
import { readWorkingProject } from './localProjectStore';
import {
  cloneValue,
  diffProjects,
  isRecord,
  sameValue,
  validateProjectGraph,
  type CanonicalProject,
  type JsonRecord,
} from './projectData';
import './webMcp.css';

const SETTINGS_KEY = 'skill-tree:webmcp-settings:v2';
const PREVIOUS_SETTINGS_KEY = 'skill-tree:webmcp-settings:v1';
const LEGACY_SETTINGS_KEY = 'skill-tree:local-mcp-settings:v1';
const PROJECT_SETTINGS_KEY = 'skill-tree:project-settings:v1';
const TUNNELS_URL = 'https://platform.openai.com/settings/organization/tunnels';
const API_KEYS_URL = 'https://platform.openai.com/settings/organization/api-keys';
const TUNNEL_CLIENT_URL = 'https://github.com/openai/tunnel-client/releases/latest';
const CHATGPT_CONNECTORS_URL = 'https://chatgpt.com/#settings/Connectors';
const MCP_B_RELAY_DOCS_URL = 'https://docs.mcp-b.ai/packages/webmcp-local-relay/reference';
const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download';
const TOOL_PREFIX = 'skill_tree_';
const RELAY_VERSION = '5.0.1';
const RELAY_PORT = '9333';
const RELAY_REQUEST_TIMEOUT_MS = '120000';
const RELAY_INVOKE_TIMEOUT_MS = '125000';
const RELAY_EMBED_ID = 'skill-tree-webmcp-relay-embed';
const RELAY_EMBED_URL = `https://cdn.jsdelivr.net/npm/@mcp-b/webmcp-local-relay@${RELAY_VERSION}/dist/browser/embed.js`;

type Settings = { tunnelId: string; relayEnabled: boolean };
type ToolAnnotations = {
  readOnlyHint: boolean;
  openWorldHint: boolean;
  destructiveHint: boolean;
};
type ToolResponse = { content: Array<{ type: 'text'; text: string }> };
type ToolDefinition = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  execute: (input: Record<string, unknown>) => ToolResponse | Promise<ToolResponse>;
};
type ModelContextLike = {
  registerTool: (tool: ToolDefinition, options?: { signal?: AbortSignal }) => void | Promise<void>;
  getTools?: () => Promise<Array<{ name?: string }>>;
};
type WebMcpDocument = Document & { modelContext?: ModelContextLike };
type McpBWindow = Window & typeof globalThis & {
  __webModelContextOptions?: {
    autoInitialize?: boolean;
    transport?: { tabServer?: false; iframeServer?: false };
    nativeModelContextBehavior?: 'preserve' | 'patch';
    installTestingShim?: boolean | 'always' | 'if-missing';
  };
};
type RegistrationState = {
  runtimeLoading: boolean;
  available: boolean;
  registering: boolean;
  registered: boolean;
  toolNames: string[];
  error: string | null;
};
type RelayEmbedState = 'disabled' | 'loading' | 'loaded' | 'error';

let panelOpen = false;
let uiInstalled = false;
let settings = readSettings();
let relayEmbedState: RelayEmbedState = 'disabled';
let relayEmbedError: string | null = null;
let registration: RegistrationState = {
  runtimeLoading: true,
  available: false,
  registering: false,
  registered: false,
  toolNames: [],
  error: null,
};

function readSettings(): Settings {
  for (const key of [SETTINGS_KEY, PREVIOUS_SETTINGS_KEY, LEGACY_SETTINGS_KEY]) {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? '') as Partial<Settings>;
      const tunnelId = typeof value.tunnelId === 'string' ? value.tunnelId.trim() : '';
      if (!tunnelId && typeof value.relayEnabled !== 'boolean') continue;
      return {
        tunnelId,
        relayEnabled: typeof value.relayEnabled === 'boolean' ? value.relayEnabled : Boolean(tunnelId),
      };
    } catch {
      // Try the next settings source.
    }
  }
  return { tunnelId: '', relayEnabled: false };
}

function persistSettings(next: Settings) {
  settings = next;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function saveTunnelId(value: string) {
  const tunnelId = value.trim();
  persistSettings({ tunnelId, relayEnabled: settings.relayEnabled || Boolean(tunnelId) });
  if (settings.relayEnabled) void ensureRelayEmbed();
}

function enableRelay() {
  if (!settings.relayEnabled) persistSettings({ ...settings, relayEnabled: true });
  void ensureRelayEmbed();
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]!);
}

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function currentProject() {
  return getHistoryProject() ?? readWorkingProject();
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
    // Local mode is the safe fallback while runtime settings initialize.
  }
  const activeView = document.querySelector<HTMLElement>('.view-switcher button.active')
    ?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  return {
    storageMode: mode,
    projectId,
    activeView,
    origin: window.location.origin,
    mcpBRuntimeReady: registration.available,
    relayAdapterEnabled: settings.relayEnabled,
    relayAdapterState: relayEmbedState,
    registeredTools: registration.toolNames,
  };
}

function toolResult(value: unknown): ToolResponse {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return { content: [{ type: 'text', text }] };
}

function positionOf(entity: JsonRecord) {
  const position = isRecord(entity.position) ? entity.position : {};
  return {
    x: typeof position.x === 'number' && Number.isFinite(position.x) ? position.x : 0,
    y: typeof position.y === 'number' && Number.isFinite(position.y) ? position.y : 0,
  };
}

function dataOf(entity: JsonRecord) {
  return isRecord(entity.data) ? entity.data : {};
}

function nameOf(entity: JsonRecord) {
  const data = dataOf(entity);
  return typeof data.name === 'string' ? data.name : '';
}

function idOf(entity: JsonRecord) {
  return typeof entity.id === 'string' ? entity.id : '';
}

function requireString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string.`);
  return value.trim();
}

function optionalFiniteNumber(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number.`);
  return value;
}

function resolveEntity(collection: JsonRecord[], reference: string, kind: string) {
  const byId = collection.find((item) => idOf(item) === reference);
  if (byId) return byId;
  const normalized = reference.trim().toLocaleLowerCase();
  const byName = collection.filter((item) => nameOf(item).trim().toLocaleLowerCase() === normalized);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`${kind} name “${reference}” is ambiguous. Use its ID instead.`);
  throw new Error(`${kind} “${reference}” was not found.`);
}

async function applyProjectMutation(mutator: (project: CanonicalProject) => unknown) {
  const before = currentProject();
  const next = cloneValue(before);
  const result = mutator(next);
  const graphIssue = validateProjectGraph(next);
  if (graphIssue) throw new Error(graphIssue);
  if (sameValue(before, next)) return { changed: false, result };

  const changes = diffProjects(before, next);
  if (!changes.length) return { changed: false, result };
  const detail: HistoryApplyDetail = { transitions: [{ direction: 'redo', changes }] };
  window.dispatchEvent(new CustomEvent<HistoryApplyDetail>(HISTORY_APPLY_EVENT, { detail }));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  return { changed: true, changeCount: changes.length, result };
}

function nextSkillPosition(project: CanonicalProject) {
  if (!project.nodes.length) return { x: 80, y: 220 };
  const positions = project.nodes.map(positionOf);
  return {
    x: Math.max(...positions.map((position) => position.x)) + 140,
    y: Math.round(positions.reduce((sum, position) => sum + position.y, 0) / positions.length),
  };
}

function perkIdFromName(name: string) {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, '.');
}

function ensureUniquePerkName(project: CanonicalProject, name: string, exceptId?: string) {
  const normalized = name.trim().toLocaleLowerCase();
  if (project.perks.some((perk) => idOf(perk) !== exceptId && nameOf(perk).trim().toLocaleLowerCase() === normalized)) {
    throw new Error(`A perk named “${name}” already exists.`);
  }
}

function snapPerkPosition(project: CanonicalProject, x: number, y: number) {
  const grid = Math.max(72, Math.min(320, Math.round(project.perkGridSize || 140)));
  return { x: Math.round(x / grid) * grid, y: Math.round(y / grid) * grid };
}

function skillSummary(project: CanonicalProject, node: JsonRecord) {
  const id = idOf(node);
  const data = dataOf(node);
  return {
    id,
    name: nameOf(node),
    position: positionOf(node),
    cost: isRecord(data.cost) ? cloneValue(data.cost) : null,
    upgrades: Array.isArray(data.upgrades) ? cloneValue(data.upgrades) : [],
    prerequisites: project.edges.filter((edge) => edge.target === id).map((edge) => edge.source),
    unlocks: project.edges.filter((edge) => edge.source === id).map((edge) => edge.target),
  };
}

function toolDefinitions(): ToolDefinition[] {
  const readOnly: ToolAnnotations = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
  const write: ToolAnnotations = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };
  const destructive: ToolAnnotations = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };
  const emptySchema = { type: 'object', properties: {}, additionalProperties: false };

  return [
    {
      name: `${TOOL_PREFIX}get_context`,
      title: 'Get Skill Tree Maker context',
      description: 'Return the active project mode, project ID, editor view, origin, MCP-B relay state, and registered Skill Tree Maker tools.',
      inputSchema: emptySchema,
      annotations: readOnly,
      execute: () => toolResult(runtimeContext()),
    },
    {
      name: `${TOOL_PREFIX}get_project`,
      title: 'Get current project',
      description: 'Return the complete currently open Skill Tree Maker project. This is the canonical live browser state for either Local or Online mode.',
      inputSchema: emptySchema,
      annotations: readOnly,
      execute: () => toolResult(currentProject()),
    },
    {
      name: `${TOOL_PREFIX}list_skills`,
      title: 'List skills',
      description: 'List skills in the current project with IDs, positions, costs, upgrade effects, prerequisites, and unlocked children.',
      inputSchema: emptySchema,
      annotations: readOnly,
      execute: () => {
        const project = currentProject();
        return toolResult(project.nodes.map((node) => skillSummary(project, node)));
      },
    },
    {
      name: `${TOOL_PREFIX}get_skill`,
      title: 'Get skill',
      description: 'Get one skill by ID or exact name. If names are duplicated, use the ID.',
      inputSchema: {
        type: 'object',
        properties: { skill: { type: 'string', description: 'Skill ID or exact skill name.' } },
        required: ['skill'],
        additionalProperties: false,
      },
      annotations: readOnly,
      execute: (input) => {
        const project = currentProject();
        const node = resolveEntity(project.nodes, requireString(input, 'skill'), 'Skill');
        return toolResult(skillSummary(project, node));
      },
    },
    {
      name: `${TOOL_PREFIX}create_skill`,
      title: 'Create skill',
      description: 'Create a new skill in the current project. Optionally connect an existing skill as its prerequisite.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Display name. Defaults to New Skill.' },
          x: { type: 'number', description: 'Canvas X position. Omit for an automatic position.' },
          y: { type: 'number', description: 'Canvas Y position. Omit for an automatic position.' },
          prerequisite: { type: 'string', description: 'Optional prerequisite skill ID or exact name.' },
        },
        additionalProperties: false,
      },
      annotations: write,
      execute: async (input) => {
        const requestedName = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'New Skill';
        const x = optionalFiniteNumber(input, 'x');
        const y = optionalFiniteNumber(input, 'y');
        const prerequisite = typeof input.prerequisite === 'string' && input.prerequisite.trim() ? input.prerequisite.trim() : null;
        const applied = await applyProjectMutation((project) => {
          const fallback = nextSkillPosition(project);
          const id = uid('skill');
          const firstCurrency = project.currencies.find((item) => typeof item.id === 'string');
          project.nodes.push({
            id,
            type: 'skill',
            position: { x: x ?? fallback.x, y: y ?? fallback.y },
            data: {
              name: requestedName,
              cost: { currencyId: typeof firstCurrency?.id === 'string' ? firstCurrency.id : '', amount: 0 },
              upgrades: [],
              primaryIconId: null,
              secondaryIconId: null,
              secondaryColor: null,
            },
          });
          if (prerequisite) {
            const parent = resolveEntity(project.nodes.filter((node) => idOf(node) !== id), prerequisite, 'Prerequisite skill');
            project.edges.push({ id: uid('edge'), source: idOf(parent), target: id, type: 'skillLink' });
          }
          return { id, name: requestedName };
        });
        return toolResult(applied);
      },
    },
    {
      name: `${TOOL_PREFIX}update_skill`,
      title: 'Update skill',
      description: 'Rename or move a skill and optionally change its currency cost. Refer to the skill by ID or exact name.',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Skill ID or exact skill name.' },
          name: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          currencyId: { type: 'string', description: 'Currency ID for the skill cost.' },
          costAmount: { type: 'number', minimum: 0 },
        },
        required: ['skill'],
        additionalProperties: false,
      },
      annotations: write,
      execute: async (input) => {
        const reference = requireString(input, 'skill');
        const x = optionalFiniteNumber(input, 'x');
        const y = optionalFiniteNumber(input, 'y');
        const costAmount = optionalFiniteNumber(input, 'costAmount');
        if (costAmount !== undefined && costAmount < 0) throw new Error('costAmount cannot be negative.');
        const applied = await applyProjectMutation((project) => {
          const node = resolveEntity(project.nodes, reference, 'Skill');
          const position = positionOf(node);
          node.position = { x: x ?? position.x, y: y ?? position.y };
          const data = dataOf(node);
          if (typeof input.name === 'string' && input.name.trim()) data.name = input.name.trim();
          if (input.currencyId !== undefined || costAmount !== undefined) {
            const cost = isRecord(data.cost) ? data.cost : {};
            if (input.currencyId !== undefined) {
              if (typeof input.currencyId !== 'string') throw new Error('currencyId must be a string.');
              if (input.currencyId && !project.currencies.some((currency) => currency.id === input.currencyId)) {
                throw new Error(`Currency “${input.currencyId}” was not found.`);
              }
              cost.currencyId = input.currencyId;
            }
            if (costAmount !== undefined) cost.amount = costAmount;
            data.cost = cost;
          }
          node.data = data;
          return { id: idOf(node), name: nameOf(node), position: positionOf(node) };
        });
        return toolResult(applied);
      },
    },
    {
      name: `${TOOL_PREFIX}delete_skill`,
      title: 'Delete skill',
      description: 'Delete a skill and every prerequisite edge connected to it. Refer to the skill by ID or exact name.',
      inputSchema: {
        type: 'object',
        properties: { skill: { type: 'string', description: 'Skill ID or exact skill name.' } },
        required: ['skill'],
        additionalProperties: false,
      },
      annotations: destructive,
      execute: async (input) => {
        const reference = requireString(input, 'skill');
        const applied = await applyProjectMutation((project) => {
          const node = resolveEntity(project.nodes, reference, 'Skill');
          const id = idOf(node);
          project.nodes = project.nodes.filter((item) => idOf(item) !== id);
          project.edges = project.edges.filter((edge) => edge.source !== id && edge.target !== id);
          return { id, name: nameOf(node) };
        });
        return toolResult(applied);
      },
    },
    {
      name: `${TOOL_PREFIX}connect_skills`,
      title: 'Connect prerequisite',
      description: 'Add a directed prerequisite relationship. The prerequisite skill becomes a parent of the target skill. Cycles are rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          prerequisite: { type: 'string', description: 'Parent/prerequisite skill ID or exact name.' },
          skill: { type: 'string', description: 'Target skill ID or exact name.' },
        },
        required: ['prerequisite', 'skill'],
        additionalProperties: false,
      },
      annotations: write,
      execute: async (input) => {
        const prerequisiteRef = requireString(input, 'prerequisite');
        const skillRef = requireString(input, 'skill');
        const applied = await applyProjectMutation((project) => {
          const source = resolveEntity(project.nodes, prerequisiteRef, 'Prerequisite skill');
          const target = resolveEntity(project.nodes, skillRef, 'Target skill');
          const sourceId = idOf(source);
          const targetId = idOf(target);
          if (sourceId === targetId) throw new Error('A skill cannot unlock itself.');
          if (project.edges.some((edge) => edge.source === sourceId && edge.target === targetId)) {
            throw new Error('That prerequisite relationship already exists.');
          }
          project.edges.push({ id: uid('edge'), source: sourceId, target: targetId, type: 'skillLink' });
          return { prerequisite: sourceId, skill: targetId };
        });
        return toolResult(applied);
      },
    },
    {
      name: `${TOOL_PREFIX}disconnect_skills`,
      title: 'Disconnect prerequisite',
      description: 'Remove a directed prerequisite relationship between two skills.',
      inputSchema: {
        type: 'object',
        properties: {
          prerequisite: { type: 'string', description: 'Parent/prerequisite skill ID or exact name.' },
          skill: { type: 'string', description: 'Target skill ID or exact name.' },
        },
        required: ['prerequisite', 'skill'],
        additionalProperties: false,
      },
      annotations: write,
      execute: async (input) => {
        const prerequisiteRef = requireString(input, 'prerequisite');
        const skillRef = requireString(input, 'skill');
        const applied = await applyProjectMutation((project) => {
          const source = resolveEntity(project.nodes, prerequisiteRef, 'Prerequisite skill');
          const target = resolveEntity(project.nodes, skillRef, 'Target skill');
          const sourceId = idOf(source);
          const targetId = idOf(target);
          const beforeCount = project.edges.length;
          project.edges = project.edges.filter((edge) => !(edge.source === sourceId && edge.target === targetId));
          if (project.edges.length === beforeCount) throw new Error('That prerequisite relationship does not exist.');
          return { prerequisite: sourceId, skill: targetId };
        });
        return toolResult(applied);
      },
    },
    {
      name: `${TOOL_PREFIX}list_perks`,
      title: 'List perks',
      description: 'List all standalone perk nodes in the current project.',
      inputSchema: emptySchema,
      annotations: readOnly,
      execute: () => toolResult(currentProject().perks.map((perk) => ({
        id: idOf(perk), name: nameOf(perk), position: positionOf(perk), upgrades: cloneValue(dataOf(perk).upgrades ?? []),
      }))),
    },
    {
      name: `${TOOL_PREFIX}create_perk`,
      title: 'Create perk',
      description: 'Create a standalone perk. Perk names must be unique; the ID is derived from the lowercase name with spaces replaced by periods. Position is snapped to the perk grid.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
        required: ['name'],
        additionalProperties: false,
      },
      annotations: write,
      execute: async (input) => {
        const name = requireString(input, 'name');
        const x = optionalFiniteNumber(input, 'x') ?? 0;
        const y = optionalFiniteNumber(input, 'y') ?? 0;
        const applied = await applyProjectMutation((project) => {
          ensureUniquePerkName(project, name);
          const id = perkIdFromName(name);
          if (project.perks.some((perk) => idOf(perk) === id)) throw new Error(`Perk ID “${id}” already exists.`);
          project.perks.push({
            id,
            type: 'skill',
            position: snapPerkPosition(project, x, y),
            data: { name, upgrades: [], primaryIconId: null, secondaryIconId: null, secondaryColor: null },
          });
          return { id, name };
        });
        return toolResult(applied);
      },
    },
    {
      name: `${TOOL_PREFIX}update_perk`,
      title: 'Update perk',
      description: 'Rename or move a perk. Renaming also updates its derived ID. Positions are snapped to the configured perk grid.',
      inputSchema: {
        type: 'object',
        properties: { perk: { type: 'string' }, name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
        required: ['perk'],
        additionalProperties: false,
      },
      annotations: write,
      execute: async (input) => {
        const reference = requireString(input, 'perk');
        const x = optionalFiniteNumber(input, 'x');
        const y = optionalFiniteNumber(input, 'y');
        const applied = await applyProjectMutation((project) => {
          const perk = resolveEntity(project.perks, reference, 'Perk');
          const oldId = idOf(perk);
          const nextName = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : nameOf(perk);
          ensureUniquePerkName(project, nextName, oldId);
          const nextId = perkIdFromName(nextName);
          if (nextId !== oldId && project.perks.some((item) => idOf(item) === nextId)) throw new Error(`Perk ID “${nextId}” already exists.`);
          perk.id = nextId;
          const data = dataOf(perk);
          data.name = nextName;
          perk.data = data;
          if (x !== undefined || y !== undefined) {
            const current = positionOf(perk);
            perk.position = snapPerkPosition(project, x ?? current.x, y ?? current.y);
          }
          return { id: nextId, name: nextName, position: positionOf(perk) };
        });
        return toolResult(applied);
      },
    },
    {
      name: `${TOOL_PREFIX}delete_perk`,
      title: 'Delete perk',
      description: 'Delete a standalone perk by ID or exact name.',
      inputSchema: {
        type: 'object',
        properties: { perk: { type: 'string' } },
        required: ['perk'],
        additionalProperties: false,
      },
      annotations: destructive,
      execute: async (input) => {
        const reference = requireString(input, 'perk');
        const applied = await applyProjectMutation((project) => {
          const perk = resolveEntity(project.perks, reference, 'Perk');
          const id = idOf(perk);
          project.perks = project.perks.filter((item) => idOf(item) !== id);
          return { id, name: nameOf(perk) };
        });
        return toolResult(applied);
      },
    },
    {
      name: `${TOOL_PREFIX}list_stats`,
      title: 'List stat pool',
      description: 'Return all stat definitions in the current project, including keys, groups, types, and base values.',
      inputSchema: emptySchema,
      annotations: readOnly,
      execute: () => toolResult(currentProject().stats),
    },
    {
      name: `${TOOL_PREFIX}list_currencies`,
      title: 'List currencies',
      description: 'Return all currency definitions in the current project.',
      inputSchema: emptySchema,
      annotations: readOnly,
      execute: () => toolResult(currentProject().currencies),
    },
  ];
}

async function registerTools() {
  const modelContext = (document as WebMcpDocument).modelContext;
  registration.available = Boolean(modelContext);
  if (!modelContext || registration.registering || registration.registered) {
    renderUi();
    return;
  }

  registration.registering = true;
  registration.error = null;
  renderUi();
  try {
    const tools = toolDefinitions();
    for (const tool of tools) await modelContext.registerTool(tool);
    let names = tools.map((tool) => tool.name);
    if (modelContext.getTools) {
      const visible = await modelContext.getTools();
      const discovered = visible.map((tool) => tool.name).filter((name): name is string => typeof name === 'string');
      const confirmed = names.filter((name) => discovered.includes(name));
      if (confirmed.length) names = confirmed;
    }
    registration = {
      runtimeLoading: false,
      available: true,
      registering: false,
      registered: true,
      toolNames: names,
      error: null,
    };
  } catch (error) {
    registration = {
      runtimeLoading: false,
      available: true,
      registering: false,
      registered: false,
      toolNames: [],
      error: error instanceof Error ? error.message : 'WebMCP tool registration failed.',
    };
  }
  renderUi();
}

function relayCommand() {
  return `npx -y @mcp-b/webmcp-local-relay@${RELAY_VERSION} --widget-origin ${window.location.origin} --invoke-timeout ${RELAY_INVOKE_TIMEOUT_MS}`;
}

function tunnelCommand() {
  const tunnelId = settings.tunnelId || '<YOUR_TUNNEL_ID>';
  return `tunnel-client runtimes connect --alias skill-tree-maker --tunnel-id ${tunnelId} --runtime-api-key env:TUNNEL_RUNTIME_KEY --mcp-command "${relayCommand()}"`;
}

function tunnelStatusCommand() {
  return 'tunnel-client runtimes status skill-tree-maker --json';
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

async function ensureRelayEmbed(forceRetry = false) {
  if (!settings.relayEnabled) {
    relayEmbedState = 'disabled';
    renderUi();
    return;
  }
  if (relayEmbedState === 'loaded' || relayEmbedState === 'loading') return;

  const existing = document.getElementById(RELAY_EMBED_ID) as HTMLScriptElement | null;
  if (existing) {
    if (!forceRetry) return;
    existing.remove();
  }

  relayEmbedState = 'loading';
  relayEmbedError = null;
  renderUi();

  const script = document.createElement('script');
  script.id = RELAY_EMBED_ID;
  script.src = RELAY_EMBED_URL;
  script.async = true;
  script.dataset.relayPort = RELAY_PORT;
  script.dataset.requestTimeout = RELAY_REQUEST_TIMEOUT_MS;
  script.addEventListener('load', () => {
    relayEmbedState = 'loaded';
    relayEmbedError = null;
    renderUi();
  }, { once: true });
  script.addEventListener('error', () => {
    relayEmbedState = 'error';
    relayEmbedError = 'The MCP-B browser relay adapter could not be loaded. Check your network or content-blocking settings, then retry.';
    renderUi();
  }, { once: true });
  document.head.appendChild(script);
}

function statusRow(label: string, state: 'ready' | 'missing' | 'external', detail: string, stateText?: string) {
  const text = stateText ?? (state === 'ready' ? 'Ready' : state === 'missing' ? 'Action needed' : 'External');
  return `<div class="webmcp-status-row"><span class="webmcp-dot is-${state}"></span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></div><span>${escapeHtml(text)}</span></div>`;
}

function relayStatusRow() {
  if (!settings.relayEnabled) {
    return statusRow('MCP-B browser relay adapter', 'missing', 'Disabled until you opt in. Normal visitors do not probe localhost.', 'Enable');
  }
  if (relayEmbedState === 'loaded') {
    return statusRow('MCP-B browser relay adapter', 'ready', `Loaded from MCP-B ${RELAY_VERSION}; connects only to loopback relay ports.`, 'Loaded');
  }
  if (relayEmbedState === 'error') {
    return statusRow('MCP-B browser relay adapter', 'missing', relayEmbedError ?? 'Adapter failed to load.', 'Retry');
  }
  return statusRow('MCP-B browser relay adapter', 'external', 'Loading the opt-in browser adapter…', 'Loading');
}

function renderPanel(panel: HTMLElement) {
  const runtimeState = registration.available ? 'ready' : registration.runtimeLoading ? 'external' : 'missing';
  const runtimeDetail = registration.runtimeLoading
    ? 'Loading the bundled @mcp-b/global runtime…'
    : registration.available
      ? '@mcp-b/global supplies document.modelContext even when native WebMCP is unavailable.'
      : registration.error ?? 'MCP-B runtime initialization failed.';
  const toolsState = registration.registered ? 'ready' : registration.registering ? 'external' : 'missing';
  const toolsDetail = registration.registered
    ? `${registration.toolNames.length} Skill Tree Maker tools are registered in this tab.`
    : registration.registering
      ? 'Registering Skill Tree Maker tools…'
      : registration.error ?? 'Waiting for the MCP-B runtime.';

  panel.hidden = !panelOpen;
  panel.innerHTML = `
    <div class="webmcp-head"><div><strong>ChatGPT / MCP-B</strong><small>Page WebMCP tools → local relay → OpenAI Secure Tunnel</small></div><button type="button" data-webmcp-action="close" aria-label="Close">×</button></div>
    <div class="webmcp-intro">Skill Tree Maker now uses MCP-B to expose the running editor directly as WebMCP tools. No Chrome DevTools MCP, remote debugging, extension, Skill Tree Maker companion server, Firebase-specific bridge, or Cloudflare routing is required.</div>
    <div class="webmcp-status">
      ${statusRow('MCP-B WebMCP runtime', runtimeState, runtimeDetail)}
      ${statusRow('Skill Tree Maker page tools', toolsState, toolsDetail)}
      ${relayStatusRow()}
      ${statusRow('Local MCP-B relay + OpenAI tunnel', 'external', settings.tunnelId || 'Runs outside the browser; use the generated command below.')}
    </div>
    ${registration.error ? `<div class="webmcp-error">${escapeHtml(registration.error)}</div>` : ''}
    ${relayEmbedError ? `<div class="webmcp-error">${escapeHtml(relayEmbedError)}</div>` : ''}
    <div class="webmcp-section">
      <div class="webmcp-section-title"><strong>1. Enable the browser relay</strong><small>The WebMCP runtime and tools are already bundled with this site. This opt-in loads MCP-B’s browser relay adapter only for users who want a local MCP connection.</small></div>
      <div class="webmcp-actions">
        ${settings.relayEnabled
          ? `<button type="button" data-webmcp-action="${relayEmbedState === 'error' ? 'retry-relay' : 'check'}">${relayEmbedState === 'error' ? 'Retry relay adapter' : 'Refresh tool status'}</button>`
          : '<button type="button" data-webmcp-action="enable-relay">Enable browser relay</button>'}
        <a href="${MCP_B_RELAY_DOCS_URL}" target="_blank" rel="noreferrer">MCP-B relay docs</a>
      </div>
      <small class="webmcp-note">The adapter opens a WebSocket only to <code>127.0.0.1</code>. Chrome may ask for Local Network Access the first time a public page connects to loopback; allow it for this integration. If the local relay is not running yet, the adapter waits and reconnects later.</small>
    </div>
    <div class="webmcp-section">
      <div class="webmcp-section-title"><strong>2. Connect your OpenAI tunnel</strong><small>The browser cannot install native software or store your runtime API key safely. These are the only remaining local setup steps.</small></div>
      <ol class="webmcp-steps">
        <li>Install <code>tunnel-client</code>. Install Node.js too if <code>npx</code> is not already available on your computer.</li>
        <li>Create a restricted OpenAI runtime API key with Tunnels Read + Use permissions and expose it locally as <code>TUNNEL_RUNTIME_KEY</code>. Do not paste that secret into this page.</li>
        <li>Paste the non-secret tunnel ID below, then run the generated command. <code>tunnel-client</code> will launch <code>@mcp-b/webmcp-local-relay</code> itself as the stdio MCP server.</li>
        <li>In ChatGPT Settings → Connectors, choose a Tunnel connection and select the same tunnel.</li>
      </ol>
      <label class="webmcp-field"><span>Tunnel ID</span><input type="text" data-webmcp-tunnel-id spellcheck="false" placeholder="tunnel_0123456789abcdef..." value="${escapeHtml(settings.tunnelId)}"></label>
      <div class="webmcp-actions"><button type="button" data-webmcp-action="save-tunnel">Save tunnel ID</button><a href="${TUNNELS_URL}" target="_blank" rel="noreferrer">Open Tunnels</a><a href="${API_KEYS_URL}" target="_blank" rel="noreferrer">Runtime API keys</a><a href="${TUNNEL_CLIENT_URL}" target="_blank" rel="noreferrer">tunnel-client</a><a href="${NODE_DOWNLOAD_URL}" target="_blank" rel="noreferrer">Node.js</a></div>
      <div class="webmcp-command"><code>${escapeHtml(tunnelCommand())}</code><button type="button" data-webmcp-action="copy-command">Copy</button></div>
      <small class="webmcp-note">The relay is restricted to <code>${escapeHtml(window.location.origin)}</code> and runs on loopback only. The browser adapter uses port <code>${RELAY_PORT}</code>; the CLI automatically discovers compatible relay instances around that root port.</small>
      <div class="webmcp-command"><code>${escapeHtml(tunnelStatusCommand())}</code><button type="button" data-webmcp-action="copy-status-command">Copy status check</button></div>
      <small class="webmcp-note">After connecting, this status command should report the managed runtime as running and healthy before you expect ChatGPT tool calls to work.</small>
    </div>
    <div class="webmcp-section">
      <div class="webmcp-section-title"><strong>3. Use it in ChatGPT</strong><small>Keep this Skill Tree Maker tab open while you use the tunnel.</small></div>
      <ol class="webmcp-steps">
        <li>Open the tunnel connection in ChatGPT and ask it to inspect the current Skill Tree Maker project.</li>
        <li>For diagnostics, the relay exposes <code>webmcp_list_sources</code> and <code>webmcp_list_tools</code>. The current tab should appear as a source with the Skill Tree Maker tools below.</li>
        <li>Edits execute inside this page and therefore use the editor’s existing Local or Online persistence, validation, history, and collaboration path.</li>
      </ol>
      <div class="webmcp-actions"><a href="${CHATGPT_CONNECTORS_URL}" target="_blank" rel="noreferrer">Open ChatGPT Connectors</a></div>
    </div>
    <div class="webmcp-section compact">
      <div class="webmcp-section-title"><strong>Exposed Skill Tree Maker tools</strong><small>${registration.toolNames.length ? registration.toolNames.map((name) => name.replace(TOOL_PREFIX, '')).join(' · ') : 'Tools are still initializing.'}</small></div>
    </div>
    <div class="webmcp-footer"><span>The site can verify its own MCP-B runtime, tool registration, and whether the relay adapter script loaded. The local relay process and OpenAI tunnel run outside the browser, so use <code>tunnel-client runtimes status</code> or the relay management tools to verify those stages.</span></div>`;
}

function renderUi() {
  const panel = document.querySelector<HTMLElement>('.webmcp-panel');
  const trigger = document.querySelector<HTMLElement>('.webmcp-button');
  if (trigger) {
    const ready = registration.registered && registration.toolNames.length > 0;
    trigger.classList.toggle('is-ready', ready);
    trigger.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
    const status = trigger.querySelector<HTMLElement>('.webmcp-button-status');
    if (status) {
      status.textContent = ready
        ? settings.relayEnabled && relayEmbedState === 'loaded' ? 'Relay ready' : `${registration.toolNames.length} tools`
        : registration.runtimeLoading ? 'Loading' : 'Setup';
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
  control.className = 'webmcp-control';
  control.innerHTML = `<button type="button" class="ghost webmcp-button" aria-expanded="false"><span class="webmcp-icon" aria-hidden="true">⌁</span><span class="webmcp-button-label">ChatGPT</span><small class="webmcp-button-status">Loading</small></button><div class="webmcp-panel" hidden></div>`;
  actions.insertBefore(control, actions.firstChild);

  control.querySelector<HTMLButtonElement>('.webmcp-button')?.addEventListener('click', (event) => {
    event.stopPropagation();
    panelOpen = !panelOpen;
    renderUi();
    if (panelOpen) {
      void registerTools();
      if (settings.relayEnabled) void ensureRelayEmbed();
    }
  });

  const panel = control.querySelector<HTMLElement>('.webmcp-panel');
  panel?.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-webmcp-action]')?.dataset.webmcpAction;
    if (action === 'close') {
      panelOpen = false;
      renderUi();
    } else if (action === 'check') {
      void registerTools();
      if (settings.relayEnabled) void ensureRelayEmbed();
    } else if (action === 'enable-relay') {
      enableRelay();
      renderUi();
    } else if (action === 'retry-relay') {
      relayEmbedState = 'disabled';
      relayEmbedError = null;
      void ensureRelayEmbed(true);
    } else if (action === 'save-tunnel') {
      saveTunnelId(control.querySelector<HTMLInputElement>('[data-webmcp-tunnel-id]')?.value ?? '');
      renderUi();
    } else if (action === 'copy-command') {
      void copyText(tunnelCommand());
    } else if (action === 'copy-status-command') {
      void copyText(tunnelStatusCommand());
    }
  });

  panel?.addEventListener('keydown', (event) => {
    const keyboardEvent = event as KeyboardEvent;
    const target = keyboardEvent.target as HTMLElement;
    if (keyboardEvent.key !== 'Enter' || !target.matches('[data-webmcp-tunnel-id]')) return;
    keyboardEvent.preventDefault();
    saveTunnelId((target as HTMLInputElement).value);
    renderUi();
  });

  document.addEventListener('click', () => {
    if (!panelOpen) return;
    panelOpen = false;
    renderUi();
  });

  renderUi();
  return true;
}

async function initializeMcpBRuntime() {
  try {
    const mcpWindow = window as McpBWindow;
    mcpWindow.__webModelContextOptions = {
      autoInitialize: true,
      transport: { tabServer: false, iframeServer: false },
      nativeModelContextBehavior: 'preserve',
      installTestingShim: 'if-missing',
    };
    await import('@mcp-b/global');
    registration.runtimeLoading = false;
    registration.available = Boolean((document as WebMcpDocument).modelContext);
    if (!registration.available) throw new Error('@mcp-b/global loaded but document.modelContext is unavailable.');
    await registerTools();
    if (settings.relayEnabled) await ensureRelayEmbed();
  } catch (error) {
    registration = {
      runtimeLoading: false,
      available: false,
      registering: false,
      registered: false,
      toolNames: [],
      error: error instanceof Error ? error.message : 'MCP-B WebMCP runtime initialization failed.',
    };
    renderUi();
  }
}

if (!installUi()) {
  const observer = new MutationObserver(() => {
    if (installUi()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

void initializeMcpBRuntime();

window.addEventListener('focus', () => {
  if (!registration.registered && registration.available) void registerTools();
  if (settings.relayEnabled && relayEmbedState !== 'loaded') void ensureRelayEmbed();
  else renderUi();
});
