export type DirectedEdge = { source: string; target: string };

export function buildPrerequisiteIssueChecker(
  targetId: string | null,
  edges: readonly DirectedEdge[],
) {
  if (!targetId) return (_sourceId: string) => null as string | null;

  const directSources = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.target === targetId) directSources.add(edge.source);
    const list = outgoing.get(edge.source);
    if (list) list.push(edge.target);
    else outgoing.set(edge.source, [edge.target]);
  }

  const descendants = new Set<string>();
  const stack = [...(outgoing.get(targetId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (descendants.has(current)) continue;
    descendants.add(current);
    const next = outgoing.get(current);
    if (next) stack.push(...next);
  }

  return (sourceId: string): string | null => {
    if (sourceId === targetId) return 'A skill cannot unlock itself.';
    if (directSources.has(sourceId)) return 'That prerequisite link already exists.';
    if (descendants.has(sourceId)) return 'That link would create a recursive loop.';
    return null;
  };
}
