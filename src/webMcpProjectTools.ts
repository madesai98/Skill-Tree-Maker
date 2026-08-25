import { HISTORY_APPLY_EVENT, getHistoryProject, type HistoryApplyDetail } from './history';
import { sanitizeSvgMarkup } from './iconPool';
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

const TOOL_PREFIX = 'skill_tree_';
const REGISTER_INTERVAL_MS = 1500;

type ToolAnnotations = { readOnlyHint: boolean; openWorldHint: boolean; destructiveHint: boolean };
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
  registerTool: (tool: ToolDefinition) => void | Promise<void>;
  getTools?: () => Promise<Array<{ name?: string }>>;
};
type WebMcpDocument = Document & { modelContext?: ModelContextLike };
type StatRow = JsonRecord & {
  id: string;
  key: string;
  name: string;
  type: 'number' | 'boolean';
  baseValue: number | boolean;
  iconId: string | null;
  groupId: string;
  groupName: string;
  groupKey: string;
  groupIconId: string | null;
  groupColor: string;
};
type CurrencyRow = JsonRecord & {
  id: string;
  key: string;
  name: string;
  iconId: string | null;
  color: string;
  symbol?: string;
};
type IconRow = JsonRecord & { id: string; name: string; svg: string };
type ProjectModel = CanonicalProject & { stats: StatRow[]; currencies: CurrencyRow[]; icons: IconRow[] };

const registeredContexts = new WeakMap<ModelContextLike, Set<string>>();

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function currentProject(): ProjectModel {
  return (getHistoryProject() ?? readWorkingProject()) as ProjectModel;
}

function toolResult(value: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) ?? String(value) }] };
}

function idOf(entity: JsonRecord) {
  return typeof entity.id === 'string' ? entity.id : '';
}

function dataOf(entity: JsonRecord) {
  return isRecord(entity.data) ? entity.data : {};
}

function nameOf(entity: JsonRecord) {
  const data = dataOf(entity);
  return typeof data.name === 'string' ? data.name : '';
}

function requireString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string.`);
  return value.trim();
}

function optionalString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  return value.trim();
}

function optionalNullableString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${key} must be a string or null.`);
  const trimmed = value.trim();
  return trimmed || null;
}

function optionalFiniteNumber(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number.`);
  return value;
}

function keyPart(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'item';
}

function uniqueKey(base: string, used: Set<string>) {
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}.${suffix}`)) suffix += 1;
  return `${base}.${suffix}`;
}

function normalizeColor(value: string) {
  const color = value.trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('color must be a six-digit hex color such as #42ffa7.');
  return color.toLocaleLowerCase();
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

function resolveStat(project: ProjectModel, reference: string) {
  const normalized = reference.trim().toLocaleLowerCase();
  const byId = project.stats.find((stat) => stat.id === reference);
  if (byId) return byId;
  const byKey = project.stats.filter((stat) => stat.key.trim().toLocaleLowerCase() === normalized);
  if (byKey.length === 1) return byKey[0];
  const byName = project.stats.filter((stat) => stat.name.trim().toLocaleLowerCase() === normalized);
  if (byName.length === 1) return byName[0];
  if (byKey.length > 1 || byName.length > 1) throw new Error(`Stat “${reference}” is ambiguous. Use its ID or full key.`);
  throw new Error(`Stat “${reference}” was not found.`);
}

function statGroupRows(project: ProjectModel) {
  const groups = new Map<string, StatRow[]>();
  project.stats.forEach((stat) => {
    const list = groups.get(stat.groupId) ?? [];
    list.push(stat);
    groups.set(stat.groupId, list);
  });
  return groups;
}

function resolveStatGroup(project: ProjectModel, reference: string) {
  const normalized = reference.trim().toLocaleLowerCase();
  const groups = [...statGroupRows(project).entries()].map(([id, stats]) => ({
    id,
    name: stats[0]?.groupName ?? '',
    key: stats[0]?.groupKey ?? '',
    stats,
  }));
  const byId = groups.find((group) => group.id === reference);
  if (byId) return byId;
  const matches = groups.filter((group) =>
    group.name.trim().toLocaleLowerCase() === normalized || group.key.trim().toLocaleLowerCase() === normalized);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Stat group “${reference}” is ambiguous. Use its group ID.`);
  throw new Error(`Stat group “${reference}” was not found.`);
}

function resolveCurrency(project: ProjectModel, reference: string) {
  const normalized = reference.trim().toLocaleLowerCase();
  const byId = project.currencies.find((currency) => currency.id === reference);
  if (byId) return byId;
  const matches = project.currencies.filter((currency) =>
    currency.name.trim().toLocaleLowerCase() === normalized || currency.key.trim().toLocaleLowerCase() === normalized);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Currency “${reference}” is ambiguous. Use its ID.`);
  throw new Error(`Currency “${reference}” was not found.`);
}

function resolveIcon(project: ProjectModel, reference: string) {
  const normalized = reference.trim().toLocaleLowerCase();
  const byId = project.icons.find((icon) => icon.id === reference);
  if (byId) return byId;
  const matches = project.icons.filter((icon) => icon.name.trim().toLocaleLowerCase() === normalized);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Icon “${reference}” is ambiguous. Use its ID.`);
  throw new Error(`Icon “${reference}” was not found.`);
}

function resolveIconId(project: ProjectModel, reference: string | null) {
  return reference === null ? null : resolveIcon(project, reference).id;
}

function resolveTarget(project: ProjectModel, kind: string, reference: string) {
  if (kind === 'skill') return resolveEntity(project.nodes, reference, 'Skill');
  if (kind === 'perk') return resolveEntity(project.perks, reference, 'Perk');
  throw new Error('kind must be either "skill" or "perk".');
}

function upgradesOf(entity: JsonRecord) {
  const upgrades = dataOf(entity).upgrades;
  return Array.isArray(upgrades) ? upgrades.filter(isRecord) : [];
}

function findUpgrade(entity: JsonRecord, reference: string) {
  const upgrades = upgradesOf(entity);
  const byId = upgrades.find((upgrade) => upgrade.id === reference);
  if (byId) return byId;
  throw new Error(`Upgrade effect “${reference}” was not found on ${nameOf(entity) || idOf(entity)}.`);
}

function validateUpgrade(stat: StatRow, operator: unknown, value: unknown) {
  if (stat.type === 'boolean') {
    if (operator !== 'set') throw new Error(`Boolean stat ${stat.key} only supports the "set" operator.`);
    if (typeof value !== 'boolean') throw new Error(`Boolean stat ${stat.key} requires a boolean value.`);
    return;
  }
  if (!['add', 'subtract', 'multiply', 'divide'].includes(String(operator))) {
    throw new Error(`Number stat ${stat.key} requires add, subtract, multiply, or divide.`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Number stat ${stat.key} requires a finite numeric value.`);
}

function removeStatEffects(project: ProjectModel, removedIds: Set<string>) {
  const clean = (collection: JsonRecord[]) => collection.forEach((entity) => {
    const data = dataOf(entity);
    const upgrades = upgradesOf(entity);
    if (!upgrades.some((upgrade) => removedIds.has(String(upgrade.statId)))) return;
    data.upgrades = upgrades.filter((upgrade) => !removedIds.has(String(upgrade.statId)));
    entity.data = data;
  });
  clean(project.nodes);
  clean(project.perks);
}

function clearIconReferences(project: ProjectModel, iconId: string) {
  project.stats.forEach((stat) => {
    if (stat.iconId === iconId) stat.iconId = null;
    if (stat.groupIconId === iconId) stat.groupIconId = null;
  });
  project.currencies.forEach((currency) => {
    if (currency.iconId === iconId) currency.iconId = null;
  });
  [...project.nodes, ...project.perks].forEach((entity) => {
    const data = dataOf(entity);
    if (data.primaryIconId === iconId) data.primaryIconId = null;
    if (data.secondaryIconId === iconId) data.secondaryIconId = null;
    entity.data = data;
  });
}

function setCollectionEntity(project: ProjectModel, kind: string, entity: JsonRecord) {
  const collection = kind === 'skill' ? project.nodes : project.perks;
  const index = collection.findIndex((item) => item.id === entity.id);
  if (index < 0) throw new Error(`${kind} no longer exists.`);
  collection[index] = entity;
}

async function applyProjectMutation(mutator: (project: ProjectModel) => unknown) {
  const before = currentProject();
  const next = cloneValue(before) as ProjectModel;
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

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const write = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };
const destructive = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };

const tools: ToolDefinition[] = [
  {
    name: `${TOOL_PREFIX}list_stat_groups`, title: 'List stat groups',
    description: 'List stat-pool groups with group metadata and the stat IDs/keys they contain.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: readOnly,
    execute: () => {
      const project = currentProject();
      return toolResult([...statGroupRows(project).entries()].map(([groupId, stats]) => ({
        groupId, groupName: stats[0]?.groupName ?? '', groupKey: stats[0]?.groupKey ?? '',
        groupIconId: stats[0]?.groupIconId ?? null, groupColor: stats[0]?.groupColor ?? '#737373',
        stats: stats.map((stat) => ({ id: stat.id, key: stat.key, name: stat.name, type: stat.type, baseValue: stat.baseValue })),
      })));
    },
  },
  {
    name: `${TOOL_PREFIX}create_stat_group`, title: 'Create stat group',
    description: 'Create a stat-pool group. Groups are stored on stat rows, so one initial stat is created with it.',
    inputSchema: { type: 'object', required: ['name'], properties: {
      name: { type: 'string' }, key: { type: 'string' }, color: { type: 'string' }, iconId: { type: ['string', 'null'] },
      firstStatName: { type: 'string' }, firstStatKey: { type: 'string' }, firstStatType: { type: 'string', enum: ['number', 'boolean'] },
      firstStatBaseValue: { type: ['number', 'boolean'] }, firstStatIconId: { type: ['string', 'null'] },
    }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const name = requireString(input, 'name');
      const usedGroupKeys = new Set(project.stats.map((stat) => stat.groupKey));
      const groupKey = uniqueKey(keyPart(optionalString(input, 'key') || name), usedGroupKeys);
      const groupId = uid('stat-group');
      const groupIconId = resolveIconId(project, optionalNullableString(input, 'iconId') ?? null);
      const groupColor = input.color === undefined ? '#737373' : normalizeColor(requireString(input, 'color'));
      const statName = optionalString(input, 'firstStatName') || 'New Stat';
      const statType = input.firstStatType === undefined ? 'number' : requireString(input, 'firstStatType');
      if (statType !== 'number' && statType !== 'boolean') throw new Error('firstStatType must be number or boolean.');
      const localKey = keyPart(optionalString(input, 'firstStatKey') || statName);
      const baseValue = input.firstStatBaseValue ?? (statType === 'boolean' ? false : 0);
      if (statType === 'boolean' && typeof baseValue !== 'boolean') throw new Error('Boolean stat base value must be boolean.');
      if (statType === 'number' && (typeof baseValue !== 'number' || !Number.isFinite(baseValue))) throw new Error('Number stat base value must be finite.');
      const statIconId = resolveIconId(project, optionalNullableString(input, 'firstStatIconId') ?? null);
      const stat = { id: uid('stat'), key: `${groupKey}.${localKey}`, name: statName, type: statType, baseValue, iconId: statIconId,
        groupId, groupName: name, groupKey, groupIconId, groupColor } as StatRow;
      project.stats.push(stat);
      return { groupId, groupKey, stat };
    })),
  },
  {
    name: `${TOOL_PREFIX}update_stat_group`, title: 'Update stat group',
    description: 'Rename or re-key a stat group, or change its shared icon/color. Re-keying preserves each stat local key.',
    inputSchema: { type: 'object', required: ['group'], properties: {
      group: { type: 'string' }, name: { type: 'string' }, key: { type: 'string' }, color: { type: 'string' }, iconId: { type: ['string', 'null'] },
    }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const group = resolveStatGroup(project, requireString(input, 'group'));
      const nextName = optionalString(input, 'name') || group.name;
      let nextKey = group.key;
      const requestedKey = optionalString(input, 'key');
      if (requestedKey !== undefined) {
        const candidate = keyPart(requestedKey);
        if (project.stats.some((stat) => stat.groupId !== group.id && stat.groupKey === candidate)) throw new Error(`Stat group key ${candidate} is already in use.`);
        nextKey = candidate;
      }
      const iconInput = optionalNullableString(input, 'iconId');
      const nextIcon = iconInput === undefined ? undefined : resolveIconId(project, iconInput);
      const nextColor = input.color === undefined ? undefined : normalizeColor(requireString(input, 'color'));
      project.stats.forEach((stat) => {
        if (stat.groupId !== group.id) return;
        const local = stat.key.startsWith(`${group.key}.`) ? stat.key.slice(group.key.length + 1) : keyPart(stat.name);
        stat.groupName = nextName; stat.groupKey = nextKey; stat.key = `${nextKey}.${local}`;
        if (nextIcon !== undefined) stat.groupIconId = nextIcon;
        if (nextColor !== undefined) stat.groupColor = nextColor;
      });
      return { groupId: group.id, groupName: nextName, groupKey: nextKey };
    })),
  },
  {
    name: `${TOOL_PREFIX}delete_stat_group`, title: 'Delete stat group',
    description: 'Delete an entire stat group and remove all skill/perk upgrade effects that reference its stats.',
    inputSchema: { type: 'object', required: ['group'], properties: { group: { type: 'string' } }, additionalProperties: false }, annotations: destructive,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const group = resolveStatGroup(project, requireString(input, 'group'));
      const removedIds = new Set(group.stats.map((stat) => stat.id));
      project.stats = project.stats.filter((stat) => !removedIds.has(stat.id));
      removeStatEffects(project, removedIds);
      return { deletedGroupId: group.id, deletedStats: [...removedIds] };
    })),
  },
  {
    name: `${TOOL_PREFIX}create_stat`, title: 'Create stat', description: 'Add a number or boolean stat to an existing stat-pool group.',
    inputSchema: { type: 'object', required: ['group', 'name'], properties: {
      group: { type: 'string' }, name: { type: 'string' }, key: { type: 'string' }, type: { type: 'string', enum: ['number', 'boolean'] },
      baseValue: { type: ['number', 'boolean'] }, iconId: { type: ['string', 'null'] },
    }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const group = resolveStatGroup(project, requireString(input, 'group'));
      const name = requireString(input, 'name');
      const type = input.type === undefined ? 'number' : requireString(input, 'type');
      if (type !== 'number' && type !== 'boolean') throw new Error('type must be number or boolean.');
      const rawKey = optionalString(input, 'key') || name;
      const localBase = rawKey.startsWith(`${group.key}.`) ? rawKey.slice(group.key.length + 1) : rawKey;
      const used = new Set(group.stats.map((stat) => stat.key.startsWith(`${group.key}.`) ? stat.key.slice(group.key.length + 1) : stat.key));
      const local = uniqueKey(keyPart(localBase), used);
      const baseValue = input.baseValue ?? (type === 'boolean' ? false : 0);
      if (type === 'boolean' && typeof baseValue !== 'boolean') throw new Error('Boolean stat baseValue must be boolean.');
      if (type === 'number' && (typeof baseValue !== 'number' || !Number.isFinite(baseValue))) throw new Error('Number stat baseValue must be finite.');
      const iconInput = optionalNullableString(input, 'iconId');
      const first = group.stats[0];
      const stat = { id: uid('stat'), key: `${group.key}.${local}`, name, type, baseValue,
        iconId: iconInput === undefined ? null : resolveIconId(project, iconInput), groupId: group.id, groupName: group.name, groupKey: group.key,
        groupIconId: first?.groupIconId ?? null, groupColor: first?.groupColor ?? '#737373' } as StatRow;
      project.stats.push(stat);
      return stat;
    })),
  },
  {
    name: `${TOOL_PREFIX}update_stat`, title: 'Update stat',
    description: 'Edit a stat name, key, type, base value, or icon. Type changes normalize referencing upgrade effects like the editor.',
    inputSchema: { type: 'object', required: ['stat'], properties: {
      stat: { type: 'string' }, name: { type: 'string' }, key: { type: 'string' }, type: { type: 'string', enum: ['number', 'boolean'] },
      baseValue: { type: ['number', 'boolean'] }, iconId: { type: ['string', 'null'] },
    }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const stat = resolveStat(project, requireString(input, 'stat'));
      const oldType = stat.type;
      const name = optionalString(input, 'name');
      if (name !== undefined && !name) throw new Error('name must not be empty.');
      const type = input.type === undefined ? stat.type : requireString(input, 'type');
      if (type !== 'number' && type !== 'boolean') throw new Error('type must be number or boolean.');
      if (type === 'boolean' && oldType !== 'boolean') {
        const useCount = [...project.nodes, ...project.perks].reduce((total, entity) => total + upgradesOf(entity).filter((upgrade) => upgrade.statId === stat.id).length, 0);
        if (useCount > 1) throw new Error('Remove duplicate effects before converting this stat to a boolean, matching the editor rule.');
      }
      const keyInput = optionalString(input, 'key');
      if (keyInput !== undefined) {
        const local = keyPart(keyInput.startsWith(`${stat.groupKey}.`) ? keyInput.slice(stat.groupKey.length + 1) : keyInput);
        const nextKey = `${stat.groupKey}.${local}`;
        if (project.stats.some((other) => other.id !== stat.id && other.key === nextKey)) throw new Error(`Stat key ${nextKey} is already in use.`);
        stat.key = nextKey;
      }
      if (name !== undefined) stat.name = name;
      const iconInput = optionalNullableString(input, 'iconId');
      if (iconInput !== undefined) stat.iconId = resolveIconId(project, iconInput);
      if (type !== oldType) {
        stat.type = type; stat.baseValue = type === 'boolean' ? false : 0;
        [...project.nodes, ...project.perks].forEach((entity) => {
          const data = dataOf(entity);
          data.upgrades = upgradesOf(entity).map((upgrade) => upgrade.statId !== stat.id ? upgrade : {
            ...upgrade, operator: type === 'boolean' ? 'set' : 'add', value: type === 'boolean' ? true : 1,
          });
          entity.data = data;
        });
      }
      if (input.baseValue !== undefined) {
        if (stat.type === 'boolean' && typeof input.baseValue !== 'boolean') throw new Error('Boolean stat baseValue must be boolean.');
        if (stat.type === 'number' && (typeof input.baseValue !== 'number' || !Number.isFinite(input.baseValue))) throw new Error('Number stat baseValue must be finite.');
        stat.baseValue = input.baseValue as number | boolean;
      }
      return stat;
    })),
  },
  {
    name: `${TOOL_PREFIX}delete_stat`, title: 'Delete stat', description: 'Delete a stat and automatically remove every skill/perk upgrade effect that references it.',
    inputSchema: { type: 'object', required: ['stat'], properties: { stat: { type: 'string' } }, additionalProperties: false }, annotations: destructive,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const stat = resolveStat(project, requireString(input, 'stat'));
      project.stats = project.stats.filter((item) => item.id !== stat.id);
      removeStatEffects(project, new Set([stat.id]));
      return { deletedStatId: stat.id, key: stat.key };
    })),
  },
  {
    name: `${TOOL_PREFIX}create_currency`, title: 'Create currency', description: 'Add a currency definition to the current project.',
    inputSchema: { type: 'object', required: ['name'], properties: {
      name: { type: 'string' }, key: { type: 'string' }, color: { type: 'string' }, symbol: { type: 'string' }, iconId: { type: ['string', 'null'] },
    }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const name = requireString(input, 'name');
      const key = uniqueKey(keyPart(optionalString(input, 'key') || `currency.${name}`), new Set(project.currencies.map((currency) => currency.key)));
      const iconInput = optionalNullableString(input, 'iconId');
      const symbol = optionalString(input, 'symbol');
      const currency: CurrencyRow = { id: uid('currency'), key, name, iconId: iconInput === undefined ? null : resolveIconId(project, iconInput),
        color: input.color === undefined ? '#b6ff56' : normalizeColor(requireString(input, 'color')), ...(symbol ? { symbol } : {}) };
      project.currencies.push(currency);
      return currency;
    })),
  },
  {
    name: `${TOOL_PREFIX}update_currency`, title: 'Update currency', description: 'Edit a currency name, game key, color, symbol, or icon.',
    inputSchema: { type: 'object', required: ['currency'], properties: {
      currency: { type: 'string' }, name: { type: 'string' }, key: { type: 'string' }, color: { type: 'string' },
      symbol: { type: ['string', 'null'] }, iconId: { type: ['string', 'null'] },
    }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const currency = resolveCurrency(project, requireString(input, 'currency'));
      const name = optionalString(input, 'name');
      if (name !== undefined && !name) throw new Error('name must not be empty.');
      if (name !== undefined) currency.name = name;
      const key = optionalString(input, 'key');
      if (key !== undefined) {
        const normalized = keyPart(key);
        if (project.currencies.some((other) => other.id !== currency.id && other.key === normalized)) throw new Error(`Currency key ${normalized} is already in use.`);
        currency.key = normalized;
      }
      if (input.color !== undefined) currency.color = normalizeColor(requireString(input, 'color'));
      const iconInput = optionalNullableString(input, 'iconId');
      if (iconInput !== undefined) currency.iconId = resolveIconId(project, iconInput);
      if (input.symbol !== undefined) {
        if (input.symbol === null || input.symbol === '') delete currency.symbol;
        else if (typeof input.symbol === 'string') currency.symbol = input.symbol;
        else throw new Error('symbol must be a string or null.');
      }
      return currency;
    })),
  },
  {
    name: `${TOOL_PREFIX}delete_currency`, title: 'Delete currency',
    description: 'Delete a currency. Skills using it are reassigned to the first remaining currency, matching the editor.',
    inputSchema: { type: 'object', required: ['currency'], properties: { currency: { type: 'string' } }, additionalProperties: false }, annotations: destructive,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const currency = resolveCurrency(project, requireString(input, 'currency'));
      project.currencies = project.currencies.filter((item) => item.id !== currency.id);
      const replacement = project.currencies[0]?.id ?? '';
      project.nodes.forEach((node) => {
        const data = dataOf(node); const cost = isRecord(data.cost) ? data.cost : null;
        if (cost?.currencyId === currency.id) cost.currencyId = replacement;
        node.data = data;
      });
      return { deletedCurrencyId: currency.id, replacementCurrencyId: replacement || null };
    })),
  },
  {
    name: `${TOOL_PREFIX}list_icons`, title: 'List icons', description: 'List project icon assets, including SVG markup.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: readOnly,
    execute: () => toolResult(currentProject().icons),
  },
  {
    name: `${TOOL_PREFIX}create_icon`, title: 'Create icon', description: 'Add a sanitized SVG icon asset to the project icon pool.',
    inputSchema: { type: 'object', required: ['name', 'svg'], properties: { name: { type: 'string' }, svg: { type: 'string' } }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const name = requireString(input, 'name'); const svg = sanitizeSvgMarkup(requireString(input, 'svg'));
      if (!svg) throw new Error('svg must be valid SVG markup no larger than 256 KiB.');
      const icon: IconRow = { id: uid('icon'), name, svg }; project.icons.push(icon); return icon;
    })),
  },
  {
    name: `${TOOL_PREFIX}update_icon`, title: 'Update icon', description: 'Rename an icon and/or replace its SVG markup using the editor sanitizer.',
    inputSchema: { type: 'object', required: ['icon'], properties: { icon: { type: 'string' }, name: { type: 'string' }, svg: { type: 'string' } }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const icon = resolveIcon(project, requireString(input, 'icon'));
      const name = optionalString(input, 'name');
      if (name !== undefined) { if (!name) throw new Error('name must not be empty.'); icon.name = name; }
      if (input.svg !== undefined) {
        if (typeof input.svg !== 'string') throw new Error('svg must be a string.');
        const svg = sanitizeSvgMarkup(input.svg); if (!svg) throw new Error('svg must be valid SVG markup no larger than 256 KiB.'); icon.svg = svg;
      }
      return icon;
    })),
  },
  {
    name: `${TOOL_PREFIX}delete_icon`, title: 'Delete icon', description: 'Delete an icon and clear every stat, group, currency, skill, and perk reference to it.',
    inputSchema: { type: 'object', required: ['icon'], properties: { icon: { type: 'string' } }, additionalProperties: false }, annotations: destructive,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const icon = resolveIcon(project, requireString(input, 'icon')); project.icons = project.icons.filter((item) => item.id !== icon.id);
      clearIconReferences(project, icon.id); return { deletedIconId: icon.id, name: icon.name };
    })),
  },
  {
    name: `${TOOL_PREFIX}list_upgrades`, title: 'List upgrade effects', description: 'List upgrade effects on one skill or perk with resolved stat metadata.',
    inputSchema: { type: 'object', required: ['kind', 'target'], properties: { kind: { type: 'string', enum: ['skill', 'perk'] }, target: { type: 'string' } }, additionalProperties: false }, annotations: readOnly,
    execute: (input) => {
      const project = currentProject(); const kind = requireString(input, 'kind'); const entity = resolveTarget(project, kind, requireString(input, 'target'));
      return toolResult(upgradesOf(entity).map((upgrade) => {
        const stat = project.stats.find((item) => item.id === upgrade.statId);
        return { ...upgrade, stat: stat ? { id: stat.id, key: stat.key, name: stat.name, type: stat.type } : null };
      }));
    },
  },
  {
    name: `${TOOL_PREFIX}add_upgrade`, title: 'Add upgrade effect', description: 'Add an upgrade-stat effect to a skill or perk.',
    inputSchema: { type: 'object', required: ['kind', 'target', 'stat', 'value'], properties: {
      kind: { type: 'string', enum: ['skill', 'perk'] }, target: { type: 'string' }, stat: { type: 'string' },
      operator: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide', 'set'] }, value: { type: ['number', 'boolean'] },
    }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const kind = requireString(input, 'kind'); const entity = resolveTarget(project, kind, requireString(input, 'target'));
      const stat = resolveStat(project, requireString(input, 'stat')); const operator = input.operator ?? (stat.type === 'boolean' ? 'set' : 'add');
      validateUpgrade(stat, operator, input.value);
      if (stat.type === 'boolean' && upgradesOf(entity).some((upgrade) => upgrade.statId === stat.id)) throw new Error(`Boolean stat ${stat.key} is already present on this ${kind}.`);
      const upgrade: JsonRecord = { id: uid('upgrade'), statId: stat.id, operator, value: input.value };
      const data = dataOf(entity); data.upgrades = [...upgradesOf(entity), upgrade]; entity.data = data; setCollectionEntity(project, kind, entity);
      return { targetId: idOf(entity), upgrade };
    })),
  },
  {
    name: `${TOOL_PREFIX}update_upgrade`, title: 'Update upgrade effect', description: 'Edit an existing skill/perk upgrade effect stat, operator, or value.',
    inputSchema: { type: 'object', required: ['kind', 'target', 'upgrade'], properties: {
      kind: { type: 'string', enum: ['skill', 'perk'] }, target: { type: 'string' }, upgrade: { type: 'string' }, stat: { type: 'string' },
      operator: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide', 'set'] }, value: { type: ['number', 'boolean'] },
    }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const kind = requireString(input, 'kind'); const entity = resolveTarget(project, kind, requireString(input, 'target'));
      const current = findUpgrade(entity, requireString(input, 'upgrade'));
      const stat = input.stat === undefined ? resolveStat(project, String(current.statId)) : resolveStat(project, requireString(input, 'stat'));
      let operator = input.operator ?? current.operator; let value = input.value ?? current.value;
      if (input.stat !== undefined && stat.id !== current.statId) {
        if (input.operator === undefined) operator = stat.type === 'boolean' ? 'set' : 'add';
        if (input.value === undefined) value = stat.type === 'boolean' ? true : 1;
      }
      validateUpgrade(stat, operator, value);
      if (stat.type === 'boolean' && upgradesOf(entity).some((upgrade) => upgrade.id !== current.id && upgrade.statId === stat.id)) throw new Error(`Boolean stat ${stat.key} is already present on this ${kind}.`);
      const updated = { ...current, statId: stat.id, operator, value };
      const data = dataOf(entity); data.upgrades = upgradesOf(entity).map((upgrade) => upgrade.id === current.id ? updated : upgrade);
      entity.data = data; setCollectionEntity(project, kind, entity); return { targetId: idOf(entity), upgrade: updated };
    })),
  },
  {
    name: `${TOOL_PREFIX}delete_upgrade`, title: 'Delete upgrade effect', description: 'Remove one upgrade effect from a skill or perk by effect ID.',
    inputSchema: { type: 'object', required: ['kind', 'target', 'upgrade'], properties: {
      kind: { type: 'string', enum: ['skill', 'perk'] }, target: { type: 'string' }, upgrade: { type: 'string' },
    }, additionalProperties: false }, annotations: destructive,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const kind = requireString(input, 'kind'); const entity = resolveTarget(project, kind, requireString(input, 'target'));
      const current = findUpgrade(entity, requireString(input, 'upgrade')); const data = dataOf(entity);
      data.upgrades = upgradesOf(entity).filter((upgrade) => upgrade.id !== current.id); entity.data = data; setCollectionEntity(project, kind, entity);
      return { targetId: idOf(entity), deletedUpgradeId: current.id };
    })),
  },
  {
    name: `${TOOL_PREFIX}update_node_appearance`, title: 'Update node appearance', description: 'Set or clear primary/secondary icons and secondary color on a skill or perk.',
    inputSchema: { type: 'object', required: ['kind', 'target'], properties: {
      kind: { type: 'string', enum: ['skill', 'perk'] }, target: { type: 'string' }, primaryIconId: { type: ['string', 'null'] },
      secondaryIconId: { type: ['string', 'null'] }, secondaryColor: { type: ['string', 'null'] },
    }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const kind = requireString(input, 'kind'); const entity = resolveTarget(project, kind, requireString(input, 'target')); const data = dataOf(entity);
      const primary = optionalNullableString(input, 'primaryIconId'); const secondary = optionalNullableString(input, 'secondaryIconId'); const color = optionalNullableString(input, 'secondaryColor');
      if (primary !== undefined) data.primaryIconId = resolveIconId(project, primary);
      if (secondary !== undefined) data.secondaryIconId = resolveIconId(project, secondary);
      if (color !== undefined) data.secondaryColor = color === null ? null : normalizeColor(color);
      entity.data = data; setCollectionEntity(project, kind, entity);
      return { targetId: idOf(entity), primaryIconId: data.primaryIconId ?? null, secondaryIconId: data.secondaryIconId ?? null, secondaryColor: data.secondaryColor ?? null };
    })),
  },
  {
    name: `${TOOL_PREFIX}set_perk_grid_size`, title: 'Set perk grid size', description: 'Set Perks editor grid spacing. Existing perk positions are preserved.',
    inputSchema: { type: 'object', required: ['size'], properties: { size: { type: 'number', minimum: 72, maximum: 320 } }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await applyProjectMutation((project) => {
      const size = optionalFiniteNumber(input, 'size'); if (size === undefined || size < 72 || size > 320) throw new Error('size must be between 72 and 320.');
      project.perkGridSize = Math.round(size); return { perkGridSize: project.perkGridSize };
    })),
  },
];

async function registerExtendedTools() {
  const context = (document as WebMcpDocument).modelContext;
  if (!context?.registerTool) return;
  const known = registeredContexts.get(context) ?? new Set<string>();
  try {
    if (context.getTools) (await context.getTools()).forEach((tool) => { if (typeof tool.name === 'string') known.add(tool.name); });
  } catch {
    // Some native runtimes expose registerTool without getTools.
  }
  for (const tool of tools) {
    if (known.has(tool.name)) continue;
    try { await context.registerTool(tool); known.add(tool.name); }
    catch (error) { console.warn(`[Skill Tree MCP] Failed to register ${tool.name}:`, error); }
  }
  registeredContexts.set(context, known);
}

void registerExtendedTools();
window.addEventListener('load', () => void registerExtendedTools());
window.setInterval(() => void registerExtendedTools(), REGISTER_INTERVAL_MS);
