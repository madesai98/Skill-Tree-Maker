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

const SETTINGS_KEY = 'skill-tree:webmcp-settings:v1';
const LEGACY_SETTINGS_KEY = 'skill-tree:local-mcp-settings:v1';
const PROJECT_SETTINGS_KEY = 'skill-tree:project-settings:v1';
const TUNNELS_URL = 'https://platform.openai.com/settings/organization/tunnels';
const API_KEYS_URL = 'https://platform.openai.com/settings/organization/api-keys';
const TUNNEL_CLIENT_URL = 'https://github.com/openai/tunnel-client/releases/latest';
const CHROME_MCP_URL = 'https://github.com/ChromeDevTools/chrome-devtools-mcp';
const WEBMCP_DOCS_URL = 'https://developer.chrome.com/docs/ai/webmcp/';
const TOOL_PREFIX = 'skill_tree_';

type Settings = { tunnelId: string };
type ToolAnnotations = { readOnlyHint?: boolean; untrustedContentHint?: boolean };
type ToolDefinition = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  execute: (input: Record<string, unknown>) => unknown | Promise<unknown>;
};
type ModelContextLike = {
  registerTool: (tool: ToolDefinition, options?: { signal?: AbortSignal }) => void | Promise<void>;
  getTools?: () => Promise<Array<{ name?: string }>>;
};
type WebMcpDocument = Document & { modelContext?: ModelContextLike };

type RegistrationState = {
  available: boolean;
  registering: boolean;
  registered: boolean;
  toolNames: string[];
  error: string | null;
};

let panelOpen = false;
let uiInstalled = false;
let settings = readSettings();
let registration: RegistrationState = {
  available: Boolean((document as WebMcpDocument).modelContext),
  registering: false,
  registered: false,
  toolNames: [],
  error: null,
};

function readSettings(): Settings {
  for (const key of [SETTINGS_KEY, LEGACY_SETTINGS_KEY]) {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? '') as Partial<Settings>;
      if (typeof value.tunnelId === 'string') return { tunnelId: value.tunnelId.trim() };
    } catch {
      // Try the next settings source.
    }
  }
  return { tunnelId: '' };
}

function saveTunnelId(value: string) {
  settings = { tunnelId: value.trim() };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
    webMcpAvailable: registration.available,
    registeredTools: registration.toolNames,
  };
}

function jsonResult(value: unknown) {
  return JSON.stringify(value, null, 2);
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
  const readOnly: ToolAnnotations = { readOnlyHint: true, untrustedContentHint: false };
  const write: ToolAnnotations = { readOnlyHint: false, untrustedContentHint: false };
  const emptySchema = { type: 'object', properties: {}, additionalProperties: false };

  return [
    {
      name: `${TOOL_PREFIX}get_context`,
      title: 'Get Skill Tree Maker context',
      description: 'Return the active Skill Tree Maker project mode, project ID, editor view, origin, and registered WebMCP tools.',
      inputSchema: emptySchema,
      annotations: readOnly,
      execute: () => jsonResult(runtimeContext()),
    },
    {
      name: `${TOOL_PREFIX}get_project`,
      title: 'Get current project',
      description: 'Return the complete currently open Skill Tree Maker project. This is the canonical live browser state for either Local or Online mode.',
      inputSchema: emptySchema,
      annotations: readOnly,
      execute: () => jsonResult(currentProject()),
    },
    {
      name: `${TOOL_PREFIX}list_skills`,
      title: 'List skills',
      description: 'List skills in the current project with IDs, positions, costs, upgrade effects, prerequisites, and unlocked children.',
      inputSchema: emptySchema,
      annotations: readOnly,
      execute: () => {
        const project = currentProject();
        return jsonResult(project.nodes.map((node) => skillSummary(project, node)));
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
        return jsonResult(skillSummary(project, node));
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
        return jsonResult(applied);
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
        return jsonResult(applied);
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
      annotations: write,
      execute: async (input) => {
        const reference = requireString(input, 'skill');
        const applied = await applyProjectMutation((project) => {
          const node = resolveEntity(project.nodes, reference, 'Skill');
          const id = idOf(node);
          project.nodes = project.nodes.filter((item) => idOf(item) !== id);
          project.edges = project.edges.filter((edge) => edge.source !== id && edge.target !== id);
          return { id, name: nameOf(node) };
        });
        return jsonResult(applied);
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
        return jsonResult(applied);
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
        return jsonResult(applied);
      },
    },
    {
      name: `${TOOL_PREFIX}list_perks`,
      title: 'List perks',
      description: 'List all standalone perk nodes in the current project.',
      inputSchema: emptySchema,
      annotations: readOnly,
      execute: () => jsonResult(currentProject().perks.map((perk) => ({
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
        return jsonResult(applied);
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
        return jsonResult(applied);
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
      annotations: write,
      execute: async (input) => {
        const reference = requireString(input, 'perk');
        const applied = await applyProjectMutation((project) => {
          const perk = resolveEntity(project.perks, reference, 'Perk');
          const id = idOf(perk);
          project.perks = project.perks.filter((item) => idOf(item) !== id);
          return { id, name: nameOf(perk) };
        });
        return jsonResult(applied);
      },
    },
    {
      name: `${TOOL_PREFIX}list_stats`,
      title: 'List stat pool',
      description: 'Return all stat definitions in the current project, including keys, groups, types, and base values.',
      inputSchema: emptySchema,
      annotations: readOnly,
      execute: () => jsonResult(currentProject().stats),
    },
    {
      name: `${TOOL_PREFIX}list_currencies`,
      title: 'List currencies',
      description: 'Return all currency definitions in the current project.',
      inputSchema: emptySchema,
      annotations: readOnly,
      execute: () => jsonResult(currentProject().currencies),
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
      names = names.filter((name) => discovered.includes(name));
    }
    registration = { available: true, registering: false, registered: true, toolNames: names, error: null };
  } catch (error) {
    registration = {
      available: true,
      registering: false,
      registered: false,
      toolNames: [],
      error: error instanceof Error ? error.message : 'WebMCP tool registration failed.',
    };
  }
  renderUi();
}

function tunnelCommand() {
  const tunnelId = settings.tunnelId || '<YOUR_TUNNEL_ID>';
  return `tunnel-client runtimes connect --alias skill-tree-maker --tunnel-id ${tunnelId} --runtime-api-key env:TUNNEL_RUNTIME_KEY --mcp-command "npx -y chrome-devtools-mcp@latest --autoConnect --categoryExperimentalWebmcp=true"`;
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

function statusRow(label: string, state: 'ready' | 'missing' | 'external', detail: string) {
  const stateText = state === 'ready' ? 'Ready' : state === 'missing' ? 'Action needed' : 'External';
  return `<div class="webmcp-status-row"><span class="webmcp-dot is-${state}"></span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></div><span>${stateText}</span></div>`;
}

function renderPanel(panel: HTMLElement) {
  const apiState = registration.available ? 'ready' : 'missing';
  const apiDetail = registration.available
    ? registration.registered
      ? `${registration.toolNames.length} Skill Tree Maker tools registered in this tab.`
      : registration.registering
        ? 'Registering Skill Tree Maker tools…'
        : registration.error ?? 'WebMCP API detected; tools are waiting to register.'
    : 'Enable WebMCP in Chrome, then reload this page.';

  panel.hidden = !panelOpen;
  panel.innerHTML = `
    <div class="webmcp-head"><div><strong>ChatGPT / WebMCP</strong><small>Native page tools · no extension or local Skill Tree Maker server</small></div><button type="button" data-webmcp-action="close" aria-label="Close">×</button></div>
    <div class="webmcp-intro">Skill Tree Maker exposes structured tools directly from the running page. The tools operate on the active editor state, so the same setup works for Local and Online projects. No Cloudflare routing is involved.</div>
    <div class="webmcp-status">
      ${statusRow('WebMCP page tools', apiState, apiDetail)}
      ${statusRow('Chrome DevTools MCP', 'external', 'Runs locally and discovers this page’s WebMCP tools through Chrome.')}
      ${statusRow('OpenAI Secure Tunnel', 'external', settings.tunnelId || 'Paste your tunnel ID below to generate the connect command.')}
    </div>
    ${registration.error ? `<div class="webmcp-error">${escapeHtml(registration.error)}</div>` : ''}
    <div class="webmcp-section">
      <div class="webmcp-section-title"><strong>1. Enable WebMCP in Chrome</strong><small>The site can verify the API automatically once Chrome exposes it.</small></div>
      <ol class="webmcp-steps">
        <li>Use Chrome 150 or newer. Until the WebMCP origin trial is enabled for this site, open <code>chrome://flags/#enable-webmcp-testing</code>, set it to Enabled, and relaunch Chrome.</li>
        <li>Open <code>chrome://inspect/#remote-debugging</code> and enable remote debugging so Chrome DevTools MCP can attach to your existing browser profile.</li>
        <li>Keep Skill Tree Maker open in that Chrome profile. The page registers its tools automatically whenever <code>document.modelContext</code> is available.</li>
      </ol>
      <div class="webmcp-actions"><button type="button" data-webmcp-action="check">Check WebMCP</button><a href="${WEBMCP_DOCS_URL}" target="_blank" rel="noreferrer">WebMCP docs</a><a href="${CHROME_MCP_URL}" target="_blank" rel="noreferrer">Chrome DevTools MCP</a></div>
    </div>
    <div class="webmcp-section">
      <div class="webmcp-section-title"><strong>2. Connect your OpenAI tunnel</strong><small>The tunnel ID is not secret. Keep the runtime API key in an environment variable on your computer, never in this page.</small></div>
      <label class="webmcp-field"><span>Tunnel ID</span><input type="text" data-webmcp-tunnel-id spellcheck="false" placeholder="tunnel_0123456789abcdef..." value="${escapeHtml(settings.tunnelId)}"></label>
      <div class="webmcp-actions"><button type="button" data-webmcp-action="save-tunnel">Save tunnel ID</button><a href="${TUNNELS_URL}" target="_blank" rel="noreferrer">Open Tunnels</a><a href="${API_KEYS_URL}" target="_blank" rel="noreferrer">Runtime API keys</a><a href="${TUNNEL_CLIENT_URL}" target="_blank" rel="noreferrer">tunnel-client</a></div>
      <div class="webmcp-command"><code>${escapeHtml(tunnelCommand())}</code><button type="button" data-webmcp-action="copy-command">Copy</button></div>
      <small class="webmcp-note">Set <code>TUNNEL_RUNTIME_KEY</code> on your computer first. This one command starts the tunnel runtime and launches Chrome DevTools MCP through <code>npx</code>; no Skill Tree Maker extension, companion, localhost API, or Firebase-specific bridge is required.</small>
    </div>
    <div class="webmcp-section compact">
      <div class="webmcp-section-title"><strong>What the page exposes now</strong><small>${registration.toolNames.length ? registration.toolNames.map((name) => name.replace(TOOL_PREFIX, '')).join(' · ') : 'Tools appear here after WebMCP is enabled.'}</small></div>
    </div>
    <div class="webmcp-footer"><span>The page can verify WebMCP itself. Chrome DevTools MCP and tunnel-client run outside the browser, so their connection state cannot be inspected directly by the site.</span></div>`;
}

function renderUi() {
  const panel = document.querySelector<HTMLElement>('.webmcp-panel');
  const trigger = document.querySelector<HTMLElement>('.webmcp-button');
  if (trigger) {
    const ready = registration.registered && registration.toolNames.length > 0;
    trigger.classList.toggle('is-ready', ready);
    trigger.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
    const status = trigger.querySelector<HTMLElement>('.webmcp-button-status');
    if (status) status.textContent = ready ? `${registration.toolNames.length} tools` : registration.available ? 'Setup' : 'Enable';
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
  control.innerHTML = `<button type="button" class="ghost webmcp-button" aria-expanded="false"><span class="webmcp-icon" aria-hidden="true">⌁</span><span class="webmcp-button-label">ChatGPT</span><small class="webmcp-button-status">Setup</small></button><div class="webmcp-panel" hidden></div>`;
  actions.insertBefore(control, actions.firstChild);

  control.querySelector<HTMLButtonElement>('.webmcp-button')?.addEventListener('click', (event) => {
    event.stopPropagation();
    panelOpen = !panelOpen;
    renderUi();
    if (panelOpen) void registerTools();
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
      registration.available = Boolean((document as WebMcpDocument).modelContext);
      registration.error = null;
      if (!registration.available) registration.registered = false;
      void registerTools();
    } else if (action === 'save-tunnel') {
      saveTunnelId(control.querySelector<HTMLInputElement>('[data-webmcp-tunnel-id]')?.value ?? '');
      renderUi();
    } else if (action === 'copy-command') {
      void copyText(tunnelCommand());
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
  void registerTools();
  return true;
}

if (!installUi()) {
  const observer = new MutationObserver(() => {
    if (installUi()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

window.addEventListener('focus', () => {
  registration.available = Boolean((document as WebMcpDocument).modelContext);
  if (!registration.registered) void registerTools();
  else renderUi();
});
