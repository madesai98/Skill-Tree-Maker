export type PlaytestStatType = 'number' | 'boolean';

export type PlaytestStat = {
  id: string;
  type: PlaytestStatType;
  baseValue: number | boolean;
};

export type PlaytestUpgrade = {
  statId: string;
  operator: 'add' | 'subtract' | 'multiply' | 'divide' | 'set';
  value: number | boolean;
};

export type PlaytestNode = {
  id: string;
  data: {
    upgrades: PlaytestUpgrade[];
  };
};

export type PlaytestEdge = {
  source: string;
  target: string;
};

export function canUnlockPlaytestNode(
  nodeId: string,
  unlockedNodeIds: ReadonlySet<string>,
  edges: readonly PlaytestEdge[],
) {
  if (unlockedNodeIds.has(nodeId)) return false;
  return edges.every((edge) => edge.target !== nodeId || unlockedNodeIds.has(edge.source));
}

export function canLockPlaytestNode(
  nodeId: string,
  unlockedNodeIds: ReadonlySet<string>,
  edges: readonly PlaytestEdge[],
) {
  if (!unlockedNodeIds.has(nodeId)) return false;
  return !edges.some((edge) => edge.source === nodeId && unlockedNodeIds.has(edge.target));
}

export function simulateStatValues(
  stats: readonly PlaytestStat[],
  nodes: readonly PlaytestNode[],
  unlockedNodeIds: ReadonlySet<string>,
) {
  const effectsByStat = new Map<string, PlaytestUpgrade[]>();

  nodes.forEach((node) => {
    if (!unlockedNodeIds.has(node.id)) return;
    node.data.upgrades.forEach((upgrade) => {
      const effects = effectsByStat.get(upgrade.statId) ?? [];
      effects.push(upgrade);
      effectsByStat.set(upgrade.statId, effects);
    });
  });

  return new Map<string, number | boolean>(stats.map((stat) => {
    const effects = effectsByStat.get(stat.id) ?? [];

    if (stat.type === 'boolean') {
      const setEffect = effects.find((effect) => effect.operator === 'set');
      return [stat.id, setEffect ? Boolean(setEffect.value) : Boolean(stat.baseValue)];
    }

    let flatAdditions = 0;
    let flatSubtractions = 0;
    let multiplierDelta = 0;
    let divisorDelta = 0;

    effects.forEach((effect) => {
      const value = Number(effect.value);
      if (!Number.isFinite(value)) return;
      if (effect.operator === 'add') flatAdditions += value;
      else if (effect.operator === 'subtract') flatSubtractions += value;
      else if (effect.operator === 'multiply') multiplierDelta += value - 1;
      else if (effect.operator === 'divide') divisorDelta += value - 1;
    });

    const base = typeof stat.baseValue === 'number' && Number.isFinite(stat.baseValue)
      ? stat.baseValue
      : 0;
    const numerator = (base + flatAdditions - flatSubtractions) * (1 + multiplierDelta);
    const denominator = 1 + divisorDelta;
    return [stat.id, numerator / denominator];
  }));
}
