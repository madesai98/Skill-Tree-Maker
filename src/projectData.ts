export type JsonRecord = Record<string, unknown>;

export type CanonicalProject = {
  version: 2;
  nodes: JsonRecord[];
  edges: JsonRecord[];
  stats: JsonRecord[];
  currencies: JsonRecord[];
};

export type AtomicHistoryChange = {
  key: string[];
  oldExists: boolean;
  oldValue: unknown;
  newExists: boolean;
  newValue: unknown;
  oldIndex?: number;
  newIndex?: number;
};

export type HistoryDirection = 'undo' | 'redo';

export type HistoryTransition = {
  direction: HistoryDirection;
  changes: AtomicHistoryChange[];
};

export type ValueAtKey = {
  exists: boolean;
  value: unknown;
  index?: number;
};

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function cloneValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function normalizeProject(raw: unknown): CanonicalProject | null {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!isRecord(parsed) || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges) || !Array.isArray(parsed.stats)) return null;

    const nodes = parsed.nodes.flatMap<JsonRecord>((item) => {
      if (!isRecord(item) || typeof item.id !== 'string') return [];
      return [{
        id: item.id,
        type: item.type ?? 'skill',
        position: cloneValue(item.position),
        data: cloneValue(item.data),
      }];
    });

    const edges = parsed.edges.flatMap<JsonRecord>((item) => {
      if (!isRecord(item) || typeof item.id !== 'string') return [];
      return [{
        id: item.id,
        source: item.source,
        target: item.target,
        type: item.type ?? 'skillLink',
      }];
    });

    return {
      version: 2,
      nodes,
      edges,
      stats: parsed.stats.filter(isRecord).map((item) => cloneValue(item)),
      currencies: Array.isArray(parsed.currencies)
        ? parsed.currencies.filter(isRecord).map((item) => cloneValue(item))
        : [],
    };
  } catch {
    return null;
  }
}

export function createStarterProject(): CanonicalProject {
  return {
    version: 2,
    nodes: [
      {
        id: 'skill-core',
        type: 'skill',
        position: { x: 80, y: 220 },
        data: {
          name: 'Core Calibration',
          cost: { currencyId: 'currency-knowledge', amount: 10 },
          upgrades: [{ id: 'upgrade-core', statId: 'stat-damage', operator: 'add', value: 2 }],
        },
      },
      {
        id: 'skill-range',
        type: 'skill',
        position: { x: 300, y: 95 },
        data: {
          name: 'Long Optics',
          cost: { currencyId: 'currency-knowledge', amount: 35 },
          upgrades: [{ id: 'upgrade-range', statId: 'stat-range', operator: 'multiply', value: 1.15 }],
        },
      },
      {
        id: 'skill-crit',
        type: 'skill',
        position: { x: 300, y: 345 },
        data: {
          name: 'Critical Circuit',
          cost: { currencyId: 'currency-knowledge', amount: 50 },
          upgrades: [{ id: 'upgrade-crit', statId: 'stat-crit', operator: 'set', value: true }],
        },
      },
      {
        id: 'skill-overdrive',
        type: 'skill',
        position: { x: 540, y: 220 },
        data: {
          name: 'Overdrive',
          cost: { currencyId: 'currency-cores', amount: 3 },
          upgrades: [{ id: 'upgrade-overdrive', statId: 'stat-damage', operator: 'multiply', value: 1.35 }],
        },
      },
    ],
    edges: [
      { id: 'edge-core-range', source: 'skill-core', target: 'skill-range', type: 'skillLink' },
      { id: 'edge-core-crit', source: 'skill-core', target: 'skill-crit', type: 'skillLink' },
      { id: 'edge-range-overdrive', source: 'skill-range', target: 'skill-overdrive', type: 'skillLink' },
      { id: 'edge-crit-overdrive', source: 'skill-crit', target: 'skill-overdrive', type: 'skillLink' },
    ],
    stats: [
      { id: 'stat-damage', key: 'tower.damage', name: 'Tower Damage', type: 'number' },
      { id: 'stat-range', key: 'tower.range', name: 'Tower Range', type: 'number' },
      { id: 'stat-crit', key: 'tower.canCrit', name: 'Can Critical Hit', type: 'boolean' },
    ],
    currencies: [
      { id: 'currency-knowledge', key: 'currency.knowledge', name: 'Knowledge', symbol: '◇' },
      { id: 'currency-cores', key: 'currency.cores', name: 'Tower Cores', symbol: '⬡' },
    ],
  };
}

export function createBlankProject(seed?: CanonicalProject | null): CanonicalProject {
  const basis = seed ?? createStarterProject();
  return {
    version: 2,
    nodes: [],
    edges: [],
    stats: cloneValue(basis.stats),
    currencies: cloneValue(basis.currencies),
  };
}

function arraysUseIds(before: unknown[], after: unknown[]) {
  const combined = [...before, ...after];
  return combined.length > 0 && combined.every((item) => isRecord(item) && typeof item.id === 'string');
}

function pushChange(
  changes: AtomicHistoryChange[],
  key: string[],
  oldExists: boolean,
  oldValue: unknown,
  newExists: boolean,
  newValue: unknown,
  oldIndex?: number,
  newIndex?: number,
) {
  changes.push({
    key,
    oldExists,
    oldValue: oldExists ? cloneValue(oldValue) : null,
    newExists,
    newValue: newExists ? cloneValue(newValue) : null,
    ...(oldIndex === undefined ? {} : { oldIndex }),
    ...(newIndex === undefined ? {} : { newIndex }),
  });
}

function diffValue(
  oldValue: unknown,
  newValue: unknown,
  key: string[],
  changes: AtomicHistoryChange[],
  oldExists = true,
  newExists = true,
) {
  if (!oldExists || !newExists) {
    pushChange(changes, key, oldExists, oldValue, newExists, newValue);
    return;
  }

  if (sameValue(oldValue, newValue)) return;

  if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    if (!arraysUseIds(oldValue, newValue)) {
      pushChange(changes, key, true, oldValue, true, newValue);
      return;
    }

    const oldMap = new Map<string, { value: JsonRecord; index: number }>();
    const newMap = new Map<string, { value: JsonRecord; index: number }>();
    oldValue.forEach((item, index) => oldMap.set(String((item as JsonRecord).id), { value: item as JsonRecord, index }));
    newValue.forEach((item, index) => newMap.set(String((item as JsonRecord).id), { value: item as JsonRecord, index }));
    const ids = [...oldMap.keys(), ...[...newMap.keys()].filter((id) => !oldMap.has(id))];

    ids.forEach((id) => {
      const before = oldMap.get(id);
      const after = newMap.get(id);
      if (!before || !after) {
        pushChange(
          changes,
          [...key, id],
          Boolean(before),
          before?.value,
          Boolean(after),
          after?.value,
          before?.index,
          after?.index,
        );
        return;
      }
      diffValue(before.value, after.value, [...key, id], changes);
    });
    return;
  }

  if (isRecord(oldValue) && isRecord(newValue)) {
    const keys = [...Object.keys(oldValue), ...Object.keys(newValue).filter((item) => !(item in oldValue))];
    keys.forEach((property) => {
      const beforeExists = Object.prototype.hasOwnProperty.call(oldValue, property);
      const afterExists = Object.prototype.hasOwnProperty.call(newValue, property);
      diffValue(oldValue[property], newValue[property], [...key, property], changes, beforeExists, afterExists);
    });
    return;
  }

  pushChange(changes, key, true, oldValue, true, newValue);
}

export function diffProjects(before: CanonicalProject, after: CanonicalProject) {
  const changes: AtomicHistoryChange[] = [];
  diffValue(before.nodes, after.nodes, ['nodes'], changes);
  diffValue(before.edges, after.edges, ['edges'], changes);
  diffValue(before.stats, after.stats, ['stats'], changes);
  diffValue(before.currencies, after.currencies, ['currencies'], changes);
  return changes;
}

export function applyAtKey(
  current: unknown,
  key: string[],
  exists: boolean,
  value: unknown,
  index?: number,
): unknown {
  if (key.length === 0) return exists ? cloneValue(value) : undefined;

  const [segment, ...rest] = key;

  if (Array.isArray(current)) {
    const itemIndex = current.findIndex((item) => isRecord(item) && item.id === segment);

    if (rest.length === 0) {
      const next = [...current];
      if (!exists) {
        if (itemIndex >= 0) next.splice(itemIndex, 1);
        return next;
      }

      const nextValue = cloneValue(value);
      if (itemIndex >= 0) {
        next[itemIndex] = nextValue;
      } else {
        const insertIndex = Math.max(0, Math.min(index ?? next.length, next.length));
        next.splice(insertIndex, 0, nextValue);
      }
      return next;
    }

    if (itemIndex < 0) return current;
    const next = [...current];
    next[itemIndex] = applyAtKey(next[itemIndex], rest, exists, value, index);
    return next;
  }

  if (isRecord(current)) {
    const next = { ...current };
    if (rest.length === 0) {
      if (exists) next[segment] = cloneValue(value);
      else delete next[segment];
      return next;
    }

    next[segment] = applyAtKey(next[segment], rest, exists, value, index);
    return next;
  }

  return current;
}

export function sideForDirection(change: AtomicHistoryChange, direction: HistoryDirection) {
  return direction === 'undo'
    ? { exists: change.oldExists, value: change.oldValue, index: change.oldIndex }
    : { exists: change.newExists, value: change.newValue, index: change.newIndex };
}

export function sourceSideForDirection(change: AtomicHistoryChange, direction: HistoryDirection) {
  return direction === 'undo'
    ? { exists: change.newExists, value: change.newValue, index: change.newIndex }
    : { exists: change.oldExists, value: change.oldValue, index: change.oldIndex };
}

export function applyHistoryTransitionsToCollection<T>(
  current: T[],
  collection: 'nodes' | 'edges' | 'stats' | 'currencies',
  transitions: HistoryTransition[],
): T[] {
  let next: unknown = current;

  transitions.forEach((transition) => {
    const relevant = transition.changes.filter((change) => change.key[0] === collection);
    const ordered = transition.direction === 'undo' ? [...relevant].reverse() : relevant;
    ordered.forEach((change) => {
      const side = sideForDirection(change, transition.direction);
      next = applyAtKey(next, change.key.slice(1), side.exists, side.value, side.index);
    });
  });

  return next as T[];
}

export function applyTransitionsToProject(project: CanonicalProject, transitions: HistoryTransition[]) {
  let next: unknown = project;

  transitions.forEach((transition) => {
    const ordered = transition.direction === 'undo' ? [...transition.changes].reverse() : transition.changes;
    ordered.forEach((change) => {
      const side = sideForDirection(change, transition.direction);
      next = applyAtKey(next, change.key, side.exists, side.value, side.index);
    });
  });

  return next as CanonicalProject;
}

export function readAtKey(current: unknown, key: string[]): ValueAtKey {
  if (key.length === 0) return { exists: current !== undefined, value: cloneValue(current) };
  const [segment, ...rest] = key;

  if (Array.isArray(current)) {
    const index = current.findIndex((item) => isRecord(item) && item.id === segment);
    if (index < 0) return { exists: false, value: null };
    if (rest.length === 0) return { exists: true, value: cloneValue(current[index]), index };
    return readAtKey(current[index], rest);
  }

  if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
    return { exists: false, value: null };
  }

  if (rest.length === 0) return { exists: true, value: cloneValue(current[segment]) };
  return readAtKey(current[segment], rest);
}

export function valueMatchesSide(current: CanonicalProject, change: AtomicHistoryChange, direction: HistoryDirection) {
  const expected = sourceSideForDirection(change, direction);
  const actual = readAtKey(current, change.key);
  return actual.exists === expected.exists && (!expected.exists || sameValue(actual.value, expected.value));
}

export function changePathId(change: AtomicHistoryChange) {
  return change.key.join('\u001f');
}

function entityKey(collection: string, id: string) {
  const singular = collection === 'nodes'
    ? 'node'
    : collection === 'edges'
      ? 'edge'
      : collection === 'stats'
        ? 'stat'
        : collection === 'currencies'
          ? 'currency'
          : collection;
  return `${singular}:${id}`;
}

function collectionEntity(project: CanonicalProject, collection: keyof CanonicalProject, id: string) {
  const value = project[collection];
  if (!Array.isArray(value)) return null;
  return value.find((item) => isRecord(item) && item.id === id) ?? null;
}

function recordString(value: unknown, key: string) {
  return isRecord(value) && typeof value[key] === 'string' ? String(value[key]) : null;
}

function nodeDependencyIds(node: JsonRecord | null) {
  const currencies = new Set<string>();
  const stats = new Set<string>();
  const data = isRecord(node?.data) ? node.data : null;
  const cost = isRecord(data?.cost) ? data.cost : null;
  const currencyId = recordString(cost, 'currencyId');
  if (currencyId) currencies.add(currencyId);
  const upgrades = Array.isArray(data?.upgrades) ? data.upgrades : [];
  upgrades.forEach((upgrade) => {
    const statId = recordString(upgrade, 'statId');
    if (statId) stats.add(statId);
  });
  return { currencies, stats };
}

export function touchedEntityKeys(before: CanonicalProject, after: CanonicalProject, changes: AtomicHistoryChange[]) {
  const touched = new Set<string>();

  changes.forEach((change) => {
    const [collection, id, ...path] = change.key;
    if (!collection || !id) return;
    if (['nodes', 'edges', 'stats', 'currencies'].includes(collection)) touched.add(entityKey(collection, id));

    if (collection === 'edges') {
      const oldEdge = collectionEntity(before, 'edges', id);
      const newEdge = collectionEntity(after, 'edges', id);
      [oldEdge, newEdge].forEach((edge) => {
        const source = recordString(edge, 'source');
        const target = recordString(edge, 'target');
        if (source) touched.add(`node:${source}`);
        if (target) touched.add(`node:${target}`);
      });
    }

    if (collection === 'nodes') {
      const oldNode = collectionEntity(before, 'nodes', id);
      const newNode = collectionEntity(after, 'nodes', id);
      const touchesCostRelation = path.length === 0 || path.join('/').includes('data/cost/currencyId');
      const touchesUpgradeRelation = path.length === 0 || path.includes('upgrades');
      if (touchesCostRelation || touchesUpgradeRelation) {
        const oldDeps = nodeDependencyIds(oldNode);
        const newDeps = nodeDependencyIds(newNode);
        if (touchesCostRelation) {
          [...oldDeps.currencies, ...newDeps.currencies].forEach((currencyId) => touched.add(`currency:${currencyId}`));
        }
        if (touchesUpgradeRelation) {
          [...oldDeps.stats, ...newDeps.stats].forEach((statId) => touched.add(`stat:${statId}`));
        }
      }
    }
  });

  return [...touched];
}

export function guardEntityKeys(changes: AtomicHistoryChange[]) {
  const structural = changes.filter((change) => change.key.length === 2 && change.oldExists !== change.newExists);
  if (structural.length === 0) return [];

  const guards = new Set<string>();
  let guardChangedNodes = false;
  structural.forEach((change) => {
    const [collection, id] = change.key;
    if (!id) return;
    guards.add(entityKey(collection, id));
    if (collection === 'stats' || collection === 'currencies') guardChangedNodes = true;
  });

  if (guardChangedNodes) {
    changes.forEach((change) => {
      if (change.key[0] === 'nodes' && change.key[1]) guards.add(`node:${change.key[1]}`);
    });
  }

  return [...guards];
}

export function validateProjectGraph(project: CanonicalProject) {
  const nodeIds = new Set(project.nodes.flatMap((node) => typeof node.id === 'string' ? [node.id] : []));
  const seenPairs = new Set<string>();
  const outgoing = new Map<string, string[]>();

  for (const edge of project.edges) {
    const source = typeof edge.source === 'string' ? edge.source : '';
    const target = typeof edge.target === 'string' ? edge.target : '';
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) return 'An edge references a missing skill.';
    if (source === target) return 'A skill cannot unlock itself.';
    const pair = `${source}\u0000${target}`;
    if (seenPairs.has(pair)) return 'A prerequisite link is duplicated.';
    seenPairs.add(pair);
    const list = outgoing.get(source) ?? [];
    list.push(target);
    outgoing.set(source, list);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const next of outgoing.get(id) ?? []) {
      if (!visit(next)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };

  for (const id of nodeIds) {
    if (!visit(id)) return 'That change would create a recursive prerequisite loop.';
  }
  return null;
}
