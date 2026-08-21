import type { EntityTouchVector } from './history';
import {
  applyAtKey,
  cloneValue,
  diffProjects,
  validateProjectGraph,
  type AtomicHistoryChange,
  type CanonicalProject,
} from './projectData';

export type WriterDocument = {
  project: CanonicalProject;
  fieldWriters: Record<string, string>;
  entityWriters: Record<string, string>;
  entityTouches: Record<string, EntityTouchVector>;
};

export type CommittedMutation = {
  mutationId: string;
  changes: AtomicHistoryChange[];
};

export function projectPath(change: AtomicHistoryChange) {
  return change.key.join('\u001f');
}

// Retained for compatibility with older persisted metadata and any callers that still
// inspect touch vectors. Shared linear history no longer uses this to permit or reject
// undo/redo operations.
export function foreignTouchesMatch(
  current: EntityTouchVector | undefined,
  expected: EntityTouchVector | undefined,
  ownerId: string,
) {
  const users = new Set([...Object.keys(current ?? {}), ...Object.keys(expected ?? {})]);
  for (const user of users) {
    if (user === ownerId) continue;
    if ((current?.[user] ?? 0) !== (expected?.[user] ?? 0)) return false;
  }
  return true;
}

function removeDanglingEdges(project: CanonicalProject) {
  const next = cloneValue(project);
  const nodeIds = new Set(next.nodes.flatMap((node) => typeof node.id === 'string' ? [node.id] : []));
  next.edges = next.edges.filter((edge) =>
    typeof edge.source === 'string'
    && typeof edge.target === 'string'
    && nodeIds.has(edge.source)
    && nodeIds.has(edge.target));
  return next;
}

/**
 * Rebase edits that were made locally while an earlier cloud write was in flight.
 *
 * The old implementation rejected this rebase when field-writer/entity-touch guards
 * changed and then opened an overwrite/cancel dialog. With one shared linear timeline,
 * queued edits instead become the next atomic transaction: only the delta made after the
 * submitted project is applied to the newest server project, preserving unrelated remote
 * work and giving same-field edits ordinary last-writer-wins ordering.
 */
export function rebaseQueuedProject(
  server: WriterDocument,
  _base: WriterDocument,
  submitted: CanonicalProject,
  latestLocal: CanonicalProject,
  _committed: CommittedMutation,
  _ownerId: string,
): { ok: true; project: CanonicalProject; changes: AtomicHistoryChange[] } | { ok: false; reason: string } {
  const changes = diffProjects(submitted, latestLocal);
  if (!changes.length) return { ok: true, project: cloneValue(server.project), changes };

  let next: unknown = server.project;
  for (const change of changes) {
    next = applyAtKey(next, change.key, change.newExists, change.newValue, change.newIndex);
  }
  const rebased = removeDanglingEdges(next as CanonicalProject);
  const graphIssue = validateProjectGraph(rebased);
  if (graphIssue) {
    // Throwing routes this through the normal save-error path. We intentionally do not
    // return a conflict result because that path presents the retired overwrite dialog.
    throw new Error(graphIssue);
  }
  return { ok: true, project: rebased, changes };
}
