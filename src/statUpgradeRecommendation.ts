export type UpgradeRecommendationStat = {
  id: string;
  key: string;
  name: string;
  type: 'number' | 'boolean';
  groupId: string;
  groupName: string;
  groupKey: string;
};

export type UpgradeRecommendationNode = {
  id: string;
  data: {
    name: string;
    upgrades: Array<{ statId: string }>;
  };
};

export type UpgradeRecommendationEdge = {
  source: string;
  target: string;
};

type RecommendationSource = 'node' | 'ancestor' | 'name' | 'fallback';

export type UpgradeStatRecommendation = {
  recommendedStatId: string | null;
  preferredGroupIds: string[];
  scoreByStatId: ReadonlyMap<string, number>;
  source: RecommendationSource;
};

type RecommendUpgradeStatInput = {
  nodeId: string;
  nodeName: string;
  currentStatIds: string[];
  stats: UpgradeRecommendationStat[];
  nodes: UpgradeRecommendationNode[];
  edges: UpgradeRecommendationEdge[];
  eligibleStatIds: ReadonlySet<string>;
};

const MEANINGFUL_MATCH_SCORE = 42;
const NOISE_TOKENS = new Set(['upgrade', 'upgrades', 'skill', 'skills', 'node', 'nodes', 'level', 'lvl', 'rank']);
const ROMAN_LEVEL = /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)$/;

function tokenize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !NOISE_TOKENS.has(token) && !/^\d+$/.test(token) && !ROMAN_LEVEL.test(token));
}

function compact(tokens: string[]) {
  return tokens.join('');
}

function bigramDice(left: string, right: string) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;

  const counts = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }

  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    const count = counts.get(pair) ?? 0;
    if (count <= 0) continue;
    overlap += 1;
    counts.set(pair, count - 1);
  }

  return (2 * overlap) / ((left.length - 1) + (right.length - 1));
}

function prefixRelated(left: string, right: string) {
  if (left === right) return true;
  if (left.length < 3 || right.length < 3) return false;
  return left.startsWith(right) || right.startsWith(left);
}

function phraseScore(queryTokens: string[], candidateTokens: string[]) {
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

  const queryPhrase = queryTokens.join(' ');
  const candidatePhrase = candidateTokens.join(' ');
  if (queryPhrase === candidatePhrase) return 100;
  if (queryPhrase.includes(candidatePhrase)) {
    return Math.min(98, 88 + (10 * candidateTokens.length) / queryTokens.length);
  }
  if (candidatePhrase.includes(queryPhrase)) {
    return Math.min(92, 80 + (10 * queryTokens.length) / candidateTokens.length);
  }

  const candidateExact = candidateTokens.filter((token) => queryTokens.includes(token)).length;
  const queryExact = queryTokens.filter((token) => candidateTokens.includes(token)).length;
  const candidatePrefix = candidateTokens.filter((token) => queryTokens.some((queryToken) => prefixRelated(token, queryToken))).length;
  const dice = bigramDice(compact(queryTokens), compact(candidateTokens));

  return (
    50 * (candidateExact / candidateTokens.length)
    + 15 * (queryExact / queryTokens.length)
    + 20 * (candidatePrefix / candidateTokens.length)
    + 15 * dice
  );
}

function statLocalKey(stat: UpgradeRecommendationStat) {
  const prefix = stat.groupKey ? `${stat.groupKey}.` : '';
  if (prefix && stat.key.startsWith(prefix)) return stat.key.slice(prefix.length);
  const separator = stat.key.lastIndexOf('.');
  return separator >= 0 ? stat.key.slice(separator + 1) : stat.key;
}

export function upgradeStatMatchScore(nodeName: string, stat: UpgradeRecommendationStat) {
  const queryTokens = tokenize(nodeName);
  if (queryTokens.length === 0) return 0;
  const nameScore = phraseScore(queryTokens, tokenize(stat.name));
  const keyScore = phraseScore(queryTokens, tokenize(statLocalKey(stat)));
  return Math.max(nameScore, keyScore);
}

function uniqueInOrder(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function bestEligibleInGroup(
  groupId: string,
  stats: UpgradeRecommendationStat[],
  eligibleStatIds: ReadonlySet<string>,
  scoreByStatId: ReadonlyMap<string, number>,
) {
  const eligible = stats.filter((stat) => stat.groupId === groupId && eligibleStatIds.has(stat.id));
  if (eligible.length === 0) return null;
  return eligible.reduce((best, stat) => {
    const bestScore = scoreByStatId.get(best.id) ?? 0;
    const statScore = scoreByStatId.get(stat.id) ?? 0;
    return statScore > bestScore ? stat : best;
  });
}

function firstEligibleInGroups(
  groupIds: string[],
  stats: UpgradeRecommendationStat[],
  eligibleStatIds: ReadonlySet<string>,
) {
  for (const groupId of groupIds) {
    const stat = stats.find((item) => item.groupId === groupId && eligibleStatIds.has(item.id));
    if (stat) return stat;
  }
  return null;
}

function stableSortGroupsByBestScore(
  groupIds: string[],
  stats: UpgradeRecommendationStat[],
  eligibleStatIds: ReadonlySet<string>,
  scoreByStatId: ReadonlyMap<string, number>,
) {
  return groupIds
    .map((groupId, index) => {
      const best = bestEligibleInGroup(groupId, stats, eligibleStatIds, scoreByStatId);
      return { groupId, index, score: best ? scoreByStatId.get(best.id) ?? 0 : 0 };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.groupId);
}

function nearestAncestorContext(
  nodeId: string,
  stats: UpgradeRecommendationStat[],
  nodes: UpgradeRecommendationNode[],
  edges: UpgradeRecommendationEdge[],
) {
  const statById = new Map(stats.map((stat) => [stat.id, stat]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>([nodeId]);
  let frontier = [nodeId];

  while (frontier.length > 0) {
    const frontierSet = new Set(frontier);
    const parents = uniqueInOrder(edges
      .filter((edge) => frontierSet.has(edge.target) && !visited.has(edge.source))
      .map((edge) => edge.source));
    if (parents.length === 0) return null;
    parents.forEach((parentId) => visited.add(parentId));

    const seeds = parents.flatMap((parentId) => {
      const parent = nodeById.get(parentId);
      const firstUpgrade = parent?.data.upgrades.find((upgrade) => statById.has(upgrade.statId));
      if (!firstUpgrade) return [];
      const stat = statById.get(firstUpgrade.statId);
      return stat ? [{ groupId: stat.groupId, statId: stat.id }] : [];
    });

    if (seeds.length > 0) {
      return {
        groupIds: uniqueInOrder(seeds.map((seed) => seed.groupId)),
        seedStatByGroup: new Map(seeds.map((seed) => [seed.groupId, seed.statId])),
      };
    }

    frontier = parents;
  }

  return null;
}

function fallbackStat(stats: UpgradeRecommendationStat[], eligibleStatIds: ReadonlySet<string>) {
  return stats.find((stat) => stat.type === 'number' && eligibleStatIds.has(stat.id))
    ?? stats.find((stat) => eligibleStatIds.has(stat.id))
    ?? null;
}

export function recommendUpgradeStat({
  nodeId,
  nodeName,
  currentStatIds,
  stats,
  nodes,
  edges,
  eligibleStatIds,
}: RecommendUpgradeStatInput): UpgradeStatRecommendation {
  const statById = new Map(stats.map((stat) => [stat.id, stat]));
  const scoreByStatId = new Map(stats.map((stat) => [stat.id, upgradeStatMatchScore(nodeName, stat)]));
  const ownGroupIds = uniqueInOrder(currentStatIds.flatMap((statId) => {
    const stat = statById.get(statId);
    return stat ? [stat.groupId] : [];
  }));

  if (ownGroupIds.length > 0) {
    for (const groupId of ownGroupIds) {
      const best = bestEligibleInGroup(groupId, stats, eligibleStatIds, scoreByStatId);
      if (best && (scoreByStatId.get(best.id) ?? 0) >= MEANINGFUL_MATCH_SCORE) {
        return { recommendedStatId: best.id, preferredGroupIds: ownGroupIds, scoreByStatId, source: 'node' };
      }
      const first = stats.find((stat) => stat.groupId === groupId && eligibleStatIds.has(stat.id));
      if (first) return { recommendedStatId: first.id, preferredGroupIds: ownGroupIds, scoreByStatId, source: 'node' };
    }
  }

  const ancestor = nearestAncestorContext(nodeId, stats, nodes, edges);
  if (ancestor) {
    const rankedGroups = stableSortGroupsByBestScore(ancestor.groupIds, stats, eligibleStatIds, scoreByStatId);
    const firstGroup = rankedGroups[0];
    const best = firstGroup ? bestEligibleInGroup(firstGroup, stats, eligibleStatIds, scoreByStatId) : null;
    if (best && (scoreByStatId.get(best.id) ?? 0) >= MEANINGFUL_MATCH_SCORE) {
      return { recommendedStatId: best.id, preferredGroupIds: rankedGroups, scoreByStatId, source: 'ancestor' };
    }

    for (const groupId of rankedGroups) {
      const seedStatId = ancestor.seedStatByGroup.get(groupId);
      if (seedStatId && eligibleStatIds.has(seedStatId)) {
        return { recommendedStatId: seedStatId, preferredGroupIds: rankedGroups, scoreByStatId, source: 'ancestor' };
      }
    }

    const first = firstEligibleInGroups(rankedGroups, stats, eligibleStatIds);
    if (first) return { recommendedStatId: first.id, preferredGroupIds: rankedGroups, scoreByStatId, source: 'ancestor' };
  }

  const eligible = stats.filter((stat) => eligibleStatIds.has(stat.id));
  const bestGlobal = eligible.reduce<UpgradeRecommendationStat | null>((best, stat) => {
    if (!best) return stat;
    return (scoreByStatId.get(stat.id) ?? 0) > (scoreByStatId.get(best.id) ?? 0) ? stat : best;
  }, null);
  if (bestGlobal && (scoreByStatId.get(bestGlobal.id) ?? 0) >= MEANINGFUL_MATCH_SCORE) {
    return {
      recommendedStatId: bestGlobal.id,
      preferredGroupIds: [bestGlobal.groupId],
      scoreByStatId,
      source: 'name',
    };
  }

  const fallback = fallbackStat(stats, eligibleStatIds);
  return {
    recommendedStatId: fallback?.id ?? null,
    preferredGroupIds: fallback ? [fallback.groupId] : [],
    scoreByStatId,
    source: 'fallback',
  };
}
