import { changePathId, type AtomicHistoryChange, type HistoryDirection } from './projectData';

export type FieldGuardEntry = {
  changes: AtomicHistoryChange[];
  fieldGuards?: Record<string, string>;
};

export function updateFieldGuardsAfterStep<T extends FieldGuardEntry>(
  entries: T[],
  entryIndex: number,
  direction: HistoryDirection,
  mutationId: string,
): T[] {
  const next = entries.map((entry) => ({
    ...entry,
    ...(entry.fieldGuards ? { fieldGuards: { ...entry.fieldGuards } } : {}),
  })) as T[];
  const current = next[entryIndex];
  if (!current) return next;

  const paths = [...new Set(current.changes.map(changePathId))];
  current.fieldGuards = { ...(current.fieldGuards ?? {}) };
  paths.forEach((path) => { current.fieldGuards![path] = mutationId; });

  for (const path of paths) {
    const step = direction === 'undo' ? -1 : 1;
    for (let index = entryIndex + step; index >= 0 && index < next.length; index += step) {
      const candidate = next[index];
      if (!candidate.changes.some((change) => changePathId(change) === path)) continue;
      candidate.fieldGuards = { ...(candidate.fieldGuards ?? {}), [path]: mutationId };
      break;
    }
  }
  return next;
}
