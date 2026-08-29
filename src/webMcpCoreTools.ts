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
import {
  MCP_PROTOCOL_VERSION,
  type BrowserMcpTool,
  type BrowserModelContext,
  type McpToolResponse,
} from './webMcpSchema';

const TOOL_PREFIX = 'skill_tree_';
const REGISTER_INTERVAL_MS = 1500;
const MCP_READY_EVENT = 'skill-tree:mcp-ready';
const PROJECT_SETTINGS_KEY = 'skill-tree:project-settings:v1';

const registeredContexts = new WeakMap<BrowserModelContext, Set<string>>();
const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const write = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };
const destructive = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };
const emptySchema = { type: 'object', properties: {}, additionalProperties: false };

type WebMcpDocument = Document & { modelContext?: BrowserModelContext };

function toolResult(value: unknown): McpToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) ?? String(value) }] };
}

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function currentProject() {
  return getHistoryProject() ?? readWorkingProject();
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
  const matches = collection.filter((item) => nameOf(item).trim().toLocaleLowerCase() === normalized);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`${kind} name “${reference}” is ambiguous. Use its ID instead.`);
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

async function runtimeContext() {
  let storageMode: 'local' | 'online' = 'local';
  let projectId: string | null = null;
  try {
    const value = JSON.parse(localStorage.getItem(PROJECT_SETTINGS_KEY) ?? '') as Record<string, unknown>;
    storageMode = value.mode === 'online' ? 'online' : 'local';
    const selected = storageMode === 'online' ? value.selectedOnlineProjectId : value.selectedLocalProjectId;
    projectId = typeof selected === 'string' ? selected : null;
  } catch {
    // Local mode is the safe fallback while project settings initialize.
  }

  const activeView = document.querySelector<HTMLElement>('.view-switcher button.active')
    ?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  let registeredTools: string[] = [];
  const context = (document as WebMcpDocument).modelContext;
  if (context?.getTools) {
    try {
      registeredTools = (await context.getTools())
        .map((tool) => tool.name)
        .filter((name): name is string => typeof name === 'string' && name.startsWith(TOOL_PREFIX));
    } catch {
      // Tool discovery is optional.
    }
  }
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    storageMode,
    projectId,
    activeView,
    origin: window.location.origin,
    registeredTools,
  };
}

const tools: BrowserMcpTool[] = [
  {
    name: `${TOOL_PREFIX}get_context`,
    title: 'Get Skill Tree Maker context',
    description: 'Return the current MCP protocol revision, project storage mode, active project ID, editor view, browser origin, and visible Skill Tree Maker tools.',
    inputSchema: emptySchema,
    annotations: readOnly,
    execute: async () => toolResult(await runtimeContext()),
  },
  {
    name: `${TOOL_PREFIX}get_project`,
    title: 'Get current project',
    description: 'Return the complete canonical project currently open in Skill Tree Maker, using the live browser state for Local or Online mode.',
    inputSchema: emptySchema,
    annotations: readOnly,
    execute: () => toolResult(currentProject()),
  },
  {
    name: `${TOOL_PREFIX}list_skills`,
    title: 'List skills',
    description: 'List every skill with its ID, display name, position, cost, upgrade effects, prerequisite IDs, and child skill IDs.',
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
    description: 'Return one skill and its prerequisite relationships by skill ID or exact display name.',
    inputSchema: {
      type: 'object',
      properties: { skill: { type: 'string', minLength: 1, description: 'Skill ID or exact skill name. Use the ID when a name is ambiguous.' } },
      required: ['skill'],
      additionalProperties: false,
    },
    annotations: readOnly,
    execute: (input) => {
      const project = currentProject();
      return toolResult(skillSummary(project, resolveEntity(project.nodes, requireString(input, 'skill'), 'Skill')));
    },
  },
  {
    name: `${TOOL_PREFIX}create_skill`,
    title: 'Create skill',
    description: 'Create a skill in the active project and optionally connect an existing skill as its prerequisite. Omitted coordinates use an automatic position.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Display name for the new skill. Defaults to New Skill.' },
        x: { type: 'number', description: 'Canvas X coordinate. Omit for automatic placement.' },
        y: { type: 'number', description: 'Canvas Y coordinate. Omit for automatic placement.' },
        prerequisite: { type: 'string', minLength: 1, description: 'Optional prerequisite skill ID or exact skill name.' },
      },
      additionalProperties: false,
    },
    annotations: write,
    execute: async (input) => {
      const requestedName = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'New Skill';
      const x = optionalFiniteNumber(input, 'x');
      const y = optionalFiniteNumber(input, 'y');
      const prerequisite = typeof input.prerequisite === 'string' && input.prerequisite.trim() ? input.prerequisite.trim() : null;
      return toolResult(await applyProjectMutation((project) => {
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
      }));
    },
  },
  {
    name: `${TOOL_PREFIX}update_skill`,
    title: 'Update skill',
    description: 'Rename or move an existing skill and optionally update its currency cost. Unspecified fields are preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', minLength: 1, description: 'Skill ID or exact skill name.' },
        name: { type: 'string', minLength: 1, description: 'Replacement display name.' },
        x: { type: 'number', description: 'Replacement canvas X coordinate.' },
        y: { type: 'number', description: 'Replacement canvas Y coordinate.' },
        currencyId: { type: 'string', description: 'Replacement currency ID. Empty string clears the currency when supported by project data.' },
        costAmount: { type: 'number', minimum: 0, description: 'Replacement non-negative cost amount.' },
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
      return toolResult(await applyProjectMutation((project) => {
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
      }));
    },
  },
  {
    name: `${TOOL_PREFIX}delete_skill`,
    title: 'Delete skill',
    description: 'Delete one skill and all prerequisite edges connected to it.',
    inputSchema: {
      type: 'object',
      properties: { skill: { type: 'string', minLength: 1, description: 'Skill ID or exact skill name.' } },
      required: ['skill'],
      additionalProperties: false,
    },
    annotations: destructive,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const node = resolveEntity(project.nodes, requireString(input, 'skill'), 'Skill');
      const id = idOf(node);
      project.nodes = project.nodes.filter((item) => idOf(item) !== id);
      project.edges = project.edges.filter((edge) => edge.source !== id && edge.target !== id);
      return { id, name: nameOf(node) };
    })),
  },
  {
    name: `${TOOL_PREFIX}connect_skills`,
    title: 'Connect prerequisite',
    description: 'Create a directed prerequisite edge from one existing skill to another. Duplicate edges, self-links, and cycles are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        prerequisite: { type: 'string', minLength: 1, description: 'Parent prerequisite skill ID or exact name.' },
        skill: { type: 'string', minLength: 1, description: 'Target child skill ID or exact name.' },
      },
      required: ['prerequisite', 'skill'],
      additionalProperties: false,
    },
    annotations: write,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const source = resolveEntity(project.nodes, requireString(input, 'prerequisite'), 'Prerequisite skill');
      const target = resolveEntity(project.nodes, requireString(input, 'skill'), 'Target skill');
      const sourceId = idOf(source);
      const targetId = idOf(target);
      if (sourceId === targetId) throw new Error('A skill cannot unlock itself.');
      if (project.edges.some((edge) => edge.source === sourceId && edge.target === targetId)) throw new Error('That prerequisite relationship already exists.');
      project.edges.push({ id: uid('edge'), source: sourceId, target: targetId, type: 'skillLink' });
      return { prerequisite: sourceId, skill: targetId };
    })),
  },
  {
    name: `${TOOL_PREFIX}disconnect_skills`,
    title: 'Disconnect prerequisite',
    description: 'Remove one directed prerequisite edge between two existing skills.',
    inputSchema: {
      type: 'object',
      properties: {
        prerequisite: { type: 'string', minLength: 1, description: 'Parent prerequisite skill ID or exact name.' },
        skill: { type: 'string', minLength: 1, description: 'Target child skill ID or exact name.' },
      },
      required: ['prerequisite', 'skill'],
      additionalProperties: false,
    },
    annotations: write,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const source = resolveEntity(project.nodes, requireString(input, 'prerequisite'), 'Prerequisite skill');
      const target = resolveEntity(project.nodes, requireString(input, 'skill'), 'Target skill');
      const sourceId = idOf(source);
      const targetId = idOf(target);
      const beforeCount = project.edges.length;
      project.edges = project.edges.filter((edge) => !(edge.source === sourceId && edge.target === targetId));
      if (project.edges.length === beforeCount) throw new Error('That prerequisite relationship does not exist.');
      return { prerequisite: sourceId, skill: targetId };
    })),
  },
  {
    name: `${TOOL_PREFIX}list_perks`,
    title: 'List perks',
    description: 'List every standalone perk with its ID, display name, snapped grid position, and upgrade effects.',
    inputSchema: emptySchema,
    annotations: readOnly,
    execute: () => toolResult(currentProject().perks.map((perk) => ({
      id: idOf(perk),
      name: nameOf(perk),
      position: positionOf(perk),
      upgrades: cloneValue(dataOf(perk).upgrades ?? []),
    }))),
  },
  {
    name: `${TOOL_PREFIX}create_perk`,
    title: 'Create perk',
    description: 'Create a standalone perk. Perk names are unique, the ID is derived from the lowercase name with spaces replaced by periods, and the position snaps to the configured perk grid.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Unique display name for the new perk.' },
        x: { type: 'number', description: 'Desired canvas X coordinate before grid snapping. Defaults to 0.' },
        y: { type: 'number', description: 'Desired canvas Y coordinate before grid snapping. Defaults to 0.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: write,
    execute: async (input) => {
      const name = requireString(input, 'name');
      const x = optionalFiniteNumber(input, 'x') ?? 0;
      const y = optionalFiniteNumber(input, 'y') ?? 0;
      return toolResult(await applyProjectMutation((project) => {
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
      }));
    },
  },
  {
    name: `${TOOL_PREFIX}update_perk`,
    title: 'Update perk',
    description: 'Rename or move a perk. Renaming updates its derived ID; changed coordinates snap to the current perk grid.',
    inputSchema: {
      type: 'object',
      properties: {
        perk: { type: 'string', minLength: 1, description: 'Perk ID or exact perk name.' },
        name: { type: 'string', minLength: 1, description: 'Replacement unique display name.' },
        x: { type: 'number', description: 'Replacement X coordinate before grid snapping.' },
        y: { type: 'number', description: 'Replacement Y coordinate before grid snapping.' },
      },
      required: ['perk'],
      additionalProperties: false,
    },
    annotations: write,
    execute: async (input) => {
      const reference = requireString(input, 'perk');
      const x = optionalFiniteNumber(input, 'x');
      const y = optionalFiniteNumber(input, 'y');
      return toolResult(await applyProjectMutation((project) => {
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
      }));
    },
  },
  {
    name: `${TOOL_PREFIX}delete_perk`,
    title: 'Delete perk',
    description: 'Delete one standalone perk by ID or exact name.',
    inputSchema: {
      type: 'object',
      properties: { perk: { type: 'string', minLength: 1, description: 'Perk ID or exact perk name.' } },
      required: ['perk'],
      additionalProperties: false,
    },
    annotations: destructive,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const perk = resolveEntity(project.perks, requireString(input, 'perk'), 'Perk');
      const id = idOf(perk);
      project.perks = project.perks.filter((item) => idOf(item) !== id);
      return { id, name: nameOf(perk) };
    })),
  },
  {
    name: `${TOOL_PREFIX}list_stats`,
    title: 'List stat pool',
    description: 'Return every stat definition in the active project, including IDs, keys, groups, types, base values, icons, and group appearance metadata.',
    inputSchema: emptySchema,
    annotations: readOnly,
    execute: () => toolResult(currentProject().stats),
  },
  {
    name: `${TOOL_PREFIX}list_currencies`,
    title: 'List currencies',
    description: 'Return every currency definition in the active project, including IDs, keys, names, icons, colors, and symbols when present.',
    inputSchema: emptySchema,
    annotations: readOnly,
    execute: () => toolResult(currentProject().currencies),
  },
];

async function registerCoreTools() {
  const context = (document as WebMcpDocument).modelContext;
  if (!context?.registerTool) return;

  const known = registeredContexts.get(context) ?? new Set<string>();
  try {
    if (context.getTools) {
      (await context.getTools()).forEach((tool) => {
        if (typeof tool.name === 'string') known.add(tool.name);
      });
    }
  } catch {
    // Some native runtimes expose registerTool without getTools.
  }

  for (const tool of tools) {
    if (known.has(tool.name)) continue;
    try {
      await context.registerTool(tool);
      known.add(tool.name);
    } catch (error) {
      console.warn(`[Skill Tree MCP] Failed to register ${tool.name}:`, error);
    }
  }
  registeredContexts.set(context, known);
}

void registerCoreTools();
window.addEventListener(MCP_READY_EVENT, () => void registerCoreTools());
window.addEventListener('load', () => void registerCoreTools());
window.setInterval(() => void registerCoreTools(), REGISTER_INTERVAL_MS);
