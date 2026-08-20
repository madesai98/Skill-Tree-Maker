import type { EntityTouchVector } from './history';
import {
  applyAtKey,
  diffProjects,
  guardEntityKeys,
  readAtKey,
  sameValue,
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

export function foreignTouchesMatch(current: EntityTouchVector | undefined, expected: EntityTouchVector | undefined, ownerId: string) {
  const users = new Set([...Object.keys(current ?? {}), ...Object.keys(expected ?? {})]);
  for (const user of users) {
    if (user === ownerId) continue;
    if ((current?.[user] ?? 0) !== (expected?.[user] ?? 0)) return false;
  }
  return true;
}

function changeMatchesOldValue(project: CanonicalProject, change: AtomicHistoryChange) {
  const actual = readAtKey(project, change.key);
  return actual.exists === change.oldExists && (!change.oldExists || sameValue(actual.value, change.oldValue));
}

function applyChangeTargets(project: CanonicalProject, changes: AtomicHistoryChange[]) {
  let next: unknown = project;
  for (const change of changes) {
    next = applyAtKey(next, change.key, change.newExists, change.newValue, change.newIndex);
  }
  return next as CanonicalProject;
}

export function rebaseQueuedProject(
  server: WriterDocument,
  base: WriterDocument,
  submitted: CanonicalProject,
  latestLocal: CanonicalProject,
  committed: CommittedMutation,
  ownerId: string,
): { ok: true; project: CanonicalProject; changes: AtomicHistoryChange[] } | { ok: false; reason: string } {
  const changes = diffProjects(submitted, latestLocal);
  if (!changes.length) return { ok: true, project: server.project, changes };
  const committedPaths = new Set(committed.changes.map(projectPath));

  for (const change of changes) {
    if (!changeMatchesOldValue(server.project, change)) {
      return { ok: false, reason: 'A collaborator changed a field used by a queued edit.' };
    }
    const path = projectPath(change);
    const expectedWriter = committedPaths.has(path) ? committed.mutationId : base.fieldWriters[path];
    if ((server.fieldWriters[path] ?? null) !== (expectedWriter ?? null)) {
      return { ok: false, reason: 'A collaborator changed a field used by a queued edit.' };
    }
  }

  for (const key of guardEntityKeys(changes)) {
    if (Object.prototype.hasOwnProperty.call(base.entityTouches, key)) {
      if (!foreignTouchesMatch(server.entityTouches[key], base.entityTouches[key], ownerId)) {
        return { ok: false, reason: 'A collaborator touched an entity required by a queued structural edit.' };
      }
    } else if ((server.entityWriters[key] ?? null) !== (base.entityWriters[key] ?? null)
      && server.entityWriters[key] !== committed.mutationId) {
      return { ok: false, reason: 'A collaborator touched an entity required by a queued structural edit.' };
    }
  }

  const rebased = applyChangeTargets(server.project, changes);
  const graphIssue = validateProjectGraph(rebased);
  if (graphIssue) return { ok: false, reason: graphIssue };
  return { ok: true, project: rebased, changes };
}
