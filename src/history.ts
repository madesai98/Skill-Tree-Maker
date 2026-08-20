import {
  applyHistoryTransitionsToCollection,
  applyTransitionsToProject,
  changePathId,
  cloneValue,
  diffProjects,
  normalizeProject,
  sameValue,
} from './projectData';
import { updateFieldGuardsAfterStep } from './historyGuards';
import type {
  AtomicHistoryChange,
  CanonicalProject,
  HistoryDirection,
  HistoryTransition,
} from './projectData';
import './history.css';

export type { AtomicHistoryChange, HistoryDirection, HistoryTransition } from './projectData';
export { applyHistoryTransitionsToCollection } from './projectData';

export type HistoryApplyDetail = { transitions: HistoryTransition[] };

export type EntityTouchVector = Record<string, number>;

export type CollaborationHistoryMeta = {
  mutationId: string;
  ownerId: string;
  fieldGuards: Record<string, string>;
  entityTouchGuards: Record<string, EntityTouchVector>;
};

export type HistoryEntry = {
  id: string;
  timestamp: number;
  label: string;
  changes: AtomicHistoryChange[];
  mutationId?: string;
  ownerId?: string;
  fieldGuards?: Record<string, string>;
  entityTouchGuards?: Record<string, EntityTouchVector>;
  status?: 'applied' | 'undone' | 'conflicted';
  conflictReason?: string;
};

export type HistoryState = { entries: HistoryEntry[]; cursor: number };

export type OnlineHistoryResult = {
  ok: boolean;
  project?: CanonicalProject;
  mutationId?: string;
  reason?: string;
};

export type OnlineHistoryController = {
  load: () => Promise<HistoryState>;
  save: (state: HistoryState) => Promise<void>;
  apply: (direction: HistoryDirection, entry: HistoryEntry) => Promise<OnlineHistoryResult>;
};

const PROJECT_STORAGE_KEY = 'incremental-td-skill-tree:v2';
const LEGACY_HISTORY_STORAGE_KEY = 'incremental-td-skill-tree:history:v1';
const HISTORY_PREFIX = 'incremental-td-skill-tree:history:v3:';
const HISTORY_LIMIT = 50;
const COALESCE_WINDOW_MS = 600;
const DRAG_FLUSH_DELAY_MS = 50;
export const HISTORY_APPLY_EVENT = 'skill-tree-history-apply';
export const PROJECT_SAVED_EVENT = 'skill-tree-project-saved';

const nativeSetItem = Storage.prototype.setItem;
const nativeRemoveItem = Storage.prototype.removeItem;

let historyScope = 'legacy';
let historyState: HistoryState = { entries: [], cursor: -1 };
let lastProject: CanonicalProject | null = null;
let latestEditorProject: CanonicalProject | null = null;
let onlineController: OnlineHistoryController | null = null;
let historyWriteChain: Promise<void> = Promise.resolve();
let externalRecording = false;
let applyingHistory = false;
let panelOpen = false;
let nodeDragActive = false;
let pendingDragProject: CanonicalProject | null = null;
let dragFlushTimer: number | null = null;

function historyStorageKey() {
  return `${HISTORY_PREFIX}${historyScope}`;
}

function validChange(value: unknown): value is AtomicHistoryChange {
  if (!value || typeof value !== 'object') return false;
  const change = value as Record<string, unknown>;
  return Array.isArray(change.key)
    && change.key.every((part) => typeof part === 'string')
    && typeof change.oldExists === 'boolean'
    && typeof change.newExists === 'boolean';
}

function normalizeHistoryState(raw: unknown): HistoryState {
  if (!raw || typeof raw !== 'object') return { entries: [], cursor: -1 };
  const state = raw as Partial<HistoryState>;
  if (!Array.isArray(state.entries) || typeof state.cursor !== 'number') return { entries: [], cursor: -1 };
  const entries = state.entries
    .filter((entry): entry is HistoryEntry => Boolean(entry) && Array.isArray(entry.changes) && entry.changes.every(validChange))
    .slice(-HISTORY_LIMIT);
  const removed = Math.max(0, state.entries.length - entries.length);
  return { entries, cursor: Math.max(-1, Math.min(state.cursor - removed, entries.length - 1)) };
}

function readLocalHistory() {
  try {
    return normalizeHistoryState(JSON.parse(localStorage.getItem(historyStorageKey()) ?? ''));
  } catch {
    return { entries: [], cursor: -1 };
  }
}

function writeHistory(state: HistoryState) {
  const snapshot = cloneValue(state);
  const controller = onlineController;
  if (!controller) {
    nativeSetItem.call(localStorage, historyStorageKey(), JSON.stringify(snapshot));
    return Promise.resolve();
  }
  historyWriteChain = historyWriteChain.catch(() => undefined).then(() => controller.save(snapshot));
  return historyWriteChain;
}

export function flushHistoryWrites() {
  return historyWriteChain.catch(() => undefined);
}

function describeEntry(changes: AtomicHistoryChange[]) {
  const structural = (collection: string, created: boolean) => changes.find((change) =>
    change.key[0] === collection && change.key.length === 2
    && (created ? !change.oldExists && change.newExists : change.oldExists && !change.newExists));
  if (structural('nodes', true)) return 'Added skill';
  if (structural('nodes', false)) return 'Removed skill';
  if (structural('edges', true)) return 'Added prerequisite';
  if (structural('edges', false)) return 'Removed prerequisite';
  if (structural('stats', true)) return 'Added stat';
  if (structural('stats', false)) return 'Removed stat';
  if (structural('currencies', true)) return 'Added currency';
  if (structural('currencies', false)) return 'Removed currency';
  if (structural('icons', true)) return 'Added icon';
  if (structural('icons', false)) return 'Removed icon';
  if (changes.some((change) => change.key.includes('upgrades') && !change.oldExists && change.newExists)) return 'Added skill effect';
  if (changes.some((change) => change.key.includes('upgrades') && change.oldExists && !change.newExists)) return 'Removed skill effect';
  if (changes.some((change) => change.key[0] === 'nodes' && change.key.includes('position'))) return 'Moved skill';
  if (changes.some((change) => change.key[0] === 'nodes' && change.key.at(-1) === 'name')) return 'Renamed skill';
  if (changes.some((change) => change.key[0] === 'stats')) return 'Edited stat pool';
  if (changes.some((change) => change.key[0] === 'currencies')) return 'Edited currencies';
  if (changes.some((change) => change.key[0] === 'icons')) return 'Edited icon pool';
  if (changes.some((change) => change.key[0] === 'nodes')) return 'Edited skill';
  return 'Project change';
}

function historyId() {
  return `history-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function canCoalesce(previous: HistoryEntry, changes: AtomicHistoryChange[], now: number) {
  return previous.status !== 'conflicted'
    && now - previous.timestamp <= COALESCE_WINDOW_MS
    && previous.changes.length === changes.length
    && previous.changes.every((change) => change.oldExists && change.newExists)
    && changes.every((change) => change.oldExists && change.newExists)
    && previous.changes.every((change, index) => changePathId(change) === changePathId(changes[index]));
}

function mergeChanges(previous: AtomicHistoryChange[], next: AtomicHistoryChange[]) {
  return previous.map((change, index) => ({
    ...change,
    newExists: next[index].newExists,
    newValue: cloneValue(next[index].newValue),
    ...(next[index].newIndex === undefined ? {} : { newIndex: next[index].newIndex }),
  })).filter((change) => change.oldExists !== change.newExists || !sameValue(change.oldValue, change.newValue));
}

function appendChanges(changes: AtomicHistoryChange[], collaboration?: CollaborationHistoryMeta) {
  if (!changes.length) return;
  const now = Date.now();
  const applied = historyState.entries.slice(0, historyState.cursor + 1);
  const previous = applied.at(-1);

  const canMerge = previous
    && historyState.cursor === historyState.entries.length - 1
    && canCoalesce(previous, changes, now)
    && (!collaboration || previous.ownerId === collaboration.ownerId);

  if (canMerge) {
    const merged = mergeChanges(previous.changes, changes);
    const mergedEntry: HistoryEntry | null = merged.length ? {
      ...previous,
      timestamp: now,
      label: describeEntry(merged),
      changes: merged,
      ...(collaboration ? {
        mutationId: collaboration.mutationId,
        ownerId: collaboration.ownerId,
        fieldGuards: { ...(previous.fieldGuards ?? {}), ...collaboration.fieldGuards },
        entityTouchGuards: cloneValue(collaboration.entityTouchGuards),
      } : {}),
    } : null;
    const entries: HistoryEntry[] = mergedEntry
      ? [...applied.slice(0, -1), mergedEntry]
      : applied.slice(0, -1);
    historyState = { entries, cursor: entries.length - 1 };
    void writeHistory(historyState);
    renderPanel();
    return;
  }

  const entry: HistoryEntry = {
    id: historyId(),
    timestamp: now,
    label: describeEntry(changes),
    changes,
    ...(collaboration ? {
      mutationId: collaboration.mutationId,
      ownerId: collaboration.ownerId,
      fieldGuards: cloneValue(collaboration.fieldGuards),
      entityTouchGuards: cloneValue(collaboration.entityTouchGuards),
    } : {}),
    status: 'applied',
  };
  const entries = [...applied, entry].slice(-HISTORY_LIMIT);
  historyState = { entries, cursor: entries.length - 1 };
  void writeHistory(historyState);
  renderPanel();
}

function recordProject(raw: string) {
  const next = normalizeProject(raw);
  if (!next) return;
  latestEditorProject = cloneValue(next);
  if (!lastProject) {
    lastProject = next;
    return;
  }
  if (externalRecording || applyingHistory || onlineController) {
    lastProject = next;
    return;
  }
  if (nodeDragActive) {
    pendingDragProject = next;
    return;
  }
  pendingDragProject = null;
  const changes = diffProjects(lastProject, next);
  lastProject = next;
  appendChanges(changes);
}

export function recordHistoryProject(project: unknown) {
  try {
    recordProject(typeof project === 'string' ? project : JSON.stringify(project));
  } catch {
    // Ignore transient editor state that is not serializable.
  }
}

export function setHistoryExternalRecording(enabled: boolean) {
  externalRecording = enabled;
}

export function getHistoryProject() {
  return latestEditorProject ? cloneValue(latestEditorProject) : null;
}

export function recordCommittedHistory(before: CanonicalProject, after: CanonicalProject, collaboration: CollaborationHistoryMeta) {
  lastProject = cloneValue(after);
  appendChanges(diffProjects(before, after), collaboration);
}

export async function setHistoryScope(scope: string, project: CanonicalProject, controller: OnlineHistoryController | null = null) {
  historyScope = scope;
  onlineController = controller;
  lastProject = cloneValue(project);
  latestEditorProject = cloneValue(project);
  pendingDragProject = null;
  historyState = controller ? normalizeHistoryState(await controller.load()) : readLocalHistory();
  renderPanel();
}

function isNodeDragPointerDown(event: PointerEvent) {
  if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey) return false;
  const target = event.target;
  return target instanceof Element && Boolean(target.closest('.react-flow__node, .react-flow__nodesselection-rect'));
}

function flushPendingDragProject() {
  dragFlushTimer = null;
  if (nodeDragActive || !pendingDragProject) return;
  const project = pendingDragProject;
  pendingDragProject = null;
  recordProject(JSON.stringify(project));
}

function finishNodeDrag() {
  if (!nodeDragActive) return;
  nodeDragActive = false;
  if (dragFlushTimer !== null) window.clearTimeout(dragFlushTimer);
  dragFlushTimer = window.setTimeout(flushPendingDragProject, DRAG_FLUSH_DELAY_MS);
}

window.addEventListener('pointerdown', (event) => {
  if (!isNodeDragPointerDown(event)) return;
  nodeDragActive = true;
  pendingDragProject = null;
  if (dragFlushTimer !== null) window.clearTimeout(dragFlushTimer);
  dragFlushTimer = null;
}, true);
window.addEventListener('pointerup', finishNodeDrag, true);
window.addEventListener('pointercancel', finishNodeDrag, true);

Storage.prototype.setItem = function patchedSetItem(key: string, value: string) {
  nativeSetItem.call(this, key, value);
  if (this !== localStorage || key !== PROJECT_STORAGE_KEY) return;
  recordProject(value);
  window.dispatchEvent(new CustomEvent(PROJECT_SAVED_EVENT, { detail: { rawProject: value } }));
};

function transitionsForCursor(targetCursor: number): HistoryTransition[] {
  const target = Math.max(-1, Math.min(targetCursor, historyState.entries.length - 1));
  if (target === historyState.cursor) return [];
  return target < historyState.cursor
    ? historyState.entries.slice(target + 1, historyState.cursor + 1).reverse().map((entry) => ({ direction: 'undo' as const, changes: entry.changes }))
    : historyState.entries.slice(historyState.cursor + 1, target + 1).map((entry) => ({ direction: 'redo' as const, changes: entry.changes }));
}

function dispatchTransitions(transitions: HistoryTransition[]) {
  window.dispatchEvent(new CustomEvent<HistoryApplyDetail>(HISTORY_APPLY_EVENT, { detail: { transitions } }));
}

async function applyOnlineStep(direction: HistoryDirection, targetCursor: number) {
  const controller = onlineController;
  if (!controller || applyingHistory) return;
  const entryIndex = direction === 'undo' ? historyState.cursor : historyState.cursor + 1;
  const entry = historyState.entries[entryIndex];
  if (!entry) return;
  applyingHistory = true;
  try {
    const result = await controller.apply(direction, entry);
    if (!result.ok || !result.project) {
      historyState = {
        ...historyState,
        entries: historyState.entries.map((candidate, index): HistoryEntry => index === entryIndex
          ? { ...candidate, status: 'conflicted', conflictReason: result.reason ?? 'The shared project changed after this action.' }
          : candidate),
      };
      await writeHistory(historyState);
      renderPanel();
      return;
    }

    const previous = lastProject;
    lastProject = cloneValue(result.project);
    let entries = historyState.entries.map((candidate, index): HistoryEntry => {
      if (index !== entryIndex) return candidate;
      const next: HistoryEntry = {
        ...candidate,
        status: direction === 'undo' ? 'undone' : 'applied',
        ...(result.mutationId ? { mutationId: result.mutationId } : {}),
      };
      delete next.conflictReason;
      return next;
    });
    if (result.mutationId) entries = updateFieldGuardsAfterStep(entries, entryIndex, direction, result.mutationId);
    historyState = { ...historyState, cursor: targetCursor, entries };
    await writeHistory(historyState);
    nativeSetItem.call(localStorage, PROJECT_STORAGE_KEY, JSON.stringify(result.project));
    if (previous) dispatchTransitions([{ direction, changes: diffProjects(previous, result.project) }]);
    renderPanel();
  } finally {
    applyingHistory = false;
  }
}

function restoreCursor(targetCursor: number) {
  if (!lastProject || applyingHistory) return;
  const target = Math.max(-1, Math.min(targetCursor, historyState.entries.length - 1));
  if (target === historyState.cursor) return;
  if (onlineController) {
    if (Math.abs(target - historyState.cursor) === 1) void applyOnlineStep(target < historyState.cursor ? 'undo' : 'redo', target);
    return;
  }
  const transitions = transitionsForCursor(target);
  if (!transitions.length) return;
  applyingHistory = true;
  lastProject = applyTransitionsToProject(lastProject, transitions);
  historyState = { ...historyState, cursor: target };
  void writeHistory(historyState);
  nativeSetItem.call(localStorage, PROJECT_STORAGE_KEY, JSON.stringify(lastProject));
  dispatchTransitions(transitions);
  applyingHistory = false;
  renderPanel();
}

function undo() {
  flushPendingDragProject();
  restoreCursor(historyState.cursor - 1);
}

function redo() {
  flushPendingDragProject();
  restoreCursor(historyState.cursor + 1);
}

window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'z') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.shiftKey) redo(); else undo();
}, true);

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);
}

function renderPanel() {
  const panel = document.querySelector<HTMLElement>('.history-panel');
  if (!panel) return;
  panel.hidden = !panelOpen;
  const recent = historyState.entries.map((entry, index) => ({ entry, index })).reverse();
  panel.innerHTML = `
    <div class="history-panel-head">
      <div><strong>Change history</strong><span>${historyState.entries.length}/${HISTORY_LIMIT} transactions${onlineController ? ' · this user' : ''}</span></div>
      <div class="history-step-actions"><button data-history-action="undo" ${historyState.cursor >= 0 ? '' : 'disabled'}>↶</button><button data-history-action="redo" ${historyState.cursor < historyState.entries.length - 1 ? '' : 'disabled'}>↷</button></div>
    </div>
    <div class="history-list">
      ${recent.map(({ entry, index }) => `<button class="history-entry${index === historyState.cursor ? ' is-current' : ''}${entry.status === 'conflicted' ? ' is-conflicted' : ''}" data-history-index="${index}" ${onlineController && Math.abs(index - historyState.cursor) > 1 ? 'disabled' : ''}><span class="history-dot"></span><span class="history-entry-copy"><strong>${escapeHtml(entry.label)}</strong><small>${entry.changes.length} change${entry.changes.length === 1 ? '' : 's'} · ${escapeHtml(entry.changes[0]?.key.join(' › ') ?? '')}</small><small>${entry.status === 'conflicted' ? escapeHtml(entry.conflictReason ?? 'Conflict') : new Date(entry.timestamp).toLocaleTimeString()}</small></span></button>`).join('')}
      <button class="history-entry${historyState.cursor === -1 ? ' is-current' : ''}" data-history-index="-1" ${onlineController && historyState.cursor > 0 ? 'disabled' : ''}><span class="history-dot"></span><span class="history-entry-copy"><strong>Start of history</strong><small>Project baseline</small></span></button>
    </div>
    <div class="history-panel-foot">Atomic changes · Ctrl+Z undo · Ctrl+Shift+Z redo${onlineController ? ' · collaborative guard checks enabled' : ''}</div>`;
}

function installHistoryUi() {
  if (document.querySelector('.history-control')) return true;
  const actions = document.querySelector<HTMLElement>('.top-actions');
  if (!actions) return false;
  const control = document.createElement('div');
  control.className = 'history-control';
  control.innerHTML = `<button type="button" class="ghost history-button" title="Change history"><span aria-hidden="true">↶</span><span>History</span></button><div class="history-panel" hidden></div>`;
  actions.insertBefore(control, actions.firstChild);
  control.querySelector('.history-button')?.addEventListener('click', (event) => {
    event.stopPropagation();
    panelOpen = !panelOpen;
    renderPanel();
  });
  control.querySelector('.history-panel')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-history-action]')?.dataset.historyAction;
    if (action === 'undo') undo();
    if (action === 'redo') redo();
    const index = target.closest<HTMLElement>('[data-history-index]')?.dataset.historyIndex;
    if (index !== undefined) restoreCursor(Number(index));
  });
  document.addEventListener('click', () => {
    if (!panelOpen) return;
    panelOpen = false;
    renderPanel();
  });
  renderPanel();
  return true;
}

nativeRemoveItem.call(localStorage, LEGACY_HISTORY_STORAGE_KEY);
const initialRaw = localStorage.getItem(PROJECT_STORAGE_KEY);
lastProject = initialRaw ? normalizeProject(initialRaw) : null;
latestEditorProject = lastProject ? cloneValue(lastProject) : null;
historyState = readLocalHistory();

if (!installHistoryUi()) {
  const observer = new MutationObserver(() => {
    if (installHistoryUi()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
