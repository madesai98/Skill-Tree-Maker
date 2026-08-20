import {
  applyHistoryTransitionsToCollection,
  applyTransitionsToProject,
  changePathId,
  cloneValue,
  diffProjects,
  normalizeProject,
  sameValue,
} from './projectData';
import type {
  AtomicHistoryChange,
  CanonicalProject,
  HistoryDirection,
  HistoryTransition,
} from './projectData';

export type { AtomicHistoryChange, HistoryDirection, HistoryTransition } from './projectData';
export { applyHistoryTransitionsToCollection } from './projectData';

export type HistoryApplyDetail = {
  transitions: HistoryTransition[];
};

export type HistoryEntry = {
  id: string;
  timestamp: number;
  label: string;
  changes: AtomicHistoryChange[];
  mutationId?: string;
  status?: 'applied' | 'undone' | 'conflicted';
  conflictReason?: string;
};

export type HistoryState = {
  entries: HistoryEntry[];
  cursor: number;
};

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
let panelOpen = false;
let nodeDragActive = false;
let pendingDragProject: CanonicalProject | null = null;
let dragFlushTimer: number | null = null;
let lastProject: CanonicalProject | null = null;
let externalRecording = false;
let onlineController: OnlineHistoryController | null = null;
let applyingHistory = false;

function historyStorageKey() {
  return `${HISTORY_PREFIX}${historyScope}`;
}

function validChange(value: unknown): value is AtomicHistoryChange {
  if (!value || typeof value !== 'object') return false;
  const change = value as Record<string, unknown>;
  if (!Array.isArray(change.key) || !change.key.every((part) => typeof part === 'string')) return false;
  return typeof change.oldExists === 'boolean' && typeof change.newExists === 'boolean';
}

function normalizeHistoryState(raw: unknown): HistoryState {
  if (!raw || typeof raw !== 'object') return { entries: [], cursor: -1 };
  const parsed = raw as Partial<HistoryState>;
  if (!Array.isArray(parsed.entries) || typeof parsed.cursor !== 'number') return { entries: [], cursor: -1 };
  const entries = parsed.entries
    .filter((entry): entry is HistoryEntry => Boolean(entry)
      && Array.isArray(entry.changes)
      && entry.changes.every(validChange))
    .slice(-HISTORY_LIMIT);
  const removedCount = Math.max(0, parsed.entries.length - entries.length);
  return {
    entries,
    cursor: Math.max(-1, Math.min(parsed.cursor - removedCount, entries.length - 1)),
  };
}

function readLocalHistory() {
  try {
    return normalizeHistoryState(JSON.parse(localStorage.getItem(historyStorageKey()) ?? ''));
  } catch {
    return { entries: [], cursor: -1 };
  }
}

async function writeHistory(state: HistoryState) {
  if (onlineController) {
    await onlineController.save(state);
  } else {
    nativeSetItem.call(localStorage, historyStorageKey(), JSON.stringify(state));
  }
}

function formatKey(key: string[]) {
  return key.join(' › ');
}

function describeEntry(changes: AtomicHistoryChange[]) {
  const createdNode = changes.find((change) => change.key[0] === 'nodes' && change.key.length === 2 && !change.oldExists && change.newExists);
  if (createdNode) return 'Added skill';
  const deletedNode = changes.find((change) => change.key[0] === 'nodes' && change.key.length === 2 && change.oldExists && !change.newExists);
  if (deletedNode) return 'Removed skill';
  const createdEdge = changes.find((change) => change.key[0] === 'edges' && change.key.length === 2 && !change.oldExists && change.newExists);
  if (createdEdge) return 'Added prerequisite';
  const deletedEdge = changes.find((change) => change.key[0] === 'edges' && change.key.length === 2 && change.oldExists && !change.newExists);
  if (deletedEdge) return 'Removed prerequisite';
  const createdStat = changes.find((change) => change.key[0] === 'stats' && change.key.length === 2 && !change.oldExists && change.newExists);
  if (createdStat) return 'Added stat';
  const deletedStat = changes.find((change) => change.key[0] === 'stats' && change.key.length === 2 && change.oldExists && !change.newExists);
  if (deletedStat) return 'Removed stat';
  const createdCurrency = changes.find((change) => change.key[0] === 'currencies' && change.key.length === 2 && !change.oldExists && change.newExists);
  if (createdCurrency) return 'Added currency';
  const deletedCurrency = changes.find((change) => change.key[0] === 'currencies' && change.key.length === 2 && change.oldExists && !change.newExists);
  if (deletedCurrency) return 'Removed currency';
  if (changes.some((change) => change.key.includes('upgrades') && !change.oldExists && change.newExists)) return 'Added skill effect';
  if (changes.some((change) => change.key.includes('upgrades') && change.oldExists && !change.newExists)) return 'Removed skill effect';
  if (changes.some((change) => change.key[0] === 'nodes' && change.key.includes('position'))) return 'Moved skill';
  if (changes.some((change) => change.key.at(-1) === 'name' && change.key[0] === 'nodes')) return 'Renamed skill';
  if (changes.some((change) => change.key[0] === 'stats')) return 'Edited stat pool';
  if (changes.some((change) => change.key[0] === 'currencies')) return 'Edited currencies';
  if (changes.some((change) => change.key[0] === 'nodes')) return 'Edited skill';
  return 'Project change';
}

function historyId() {
  return `history-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function canCoalesce(previous: HistoryEntry, changes: AtomicHistoryChange[], now: number) {
  if (previous.status === 'conflicted' || now - previous.timestamp > COALESCE_WINDOW_MS || previous.changes.length !== changes.length) return false;
  if (previous.changes.some((change) => !change.oldExists || !change.newExists)) return false;
  if (changes.some((change) => !change.oldExists || !change.newExists)) return false;
  return previous.changes.every((change, index) => changePathId(change) === changePathId(changes[index]));
}

function mergeChanges(previous: AtomicHistoryChange[], changes: AtomicHistoryChange[]) {
  return previous.map((change, index) => ({
    ...change,
    newExists: changes[index].newExists,
    newValue: cloneValue(changes[index].newValue),
    ...(changes[index].newIndex === undefined ? {} : { newIndex: changes[index].newIndex }),
  })).filter((change) => change.oldExists !== change.newExists || !sameValue(change.oldValue, change.newValue));
}

function appendChanges(changes: AtomicHistoryChange[], mutationId?: string) {
  if (changes.length === 0) return;
  const now = Date.now();
  const appliedEntries = historyState.entries.slice(0, historyState.cursor + 1);
  const previous = appliedEntries.at(-1);

  if (!mutationId && previous && historyState.cursor === historyState.entries.length - 1 && canCoalesce(previous, changes, now)) {
    const merged = mergeChanges(previous.changes, changes);
    const entries = merged.length === 0
      ? appliedEntries.slice(0, -1)
      : [...appliedEntries.slice(0, -1), { ...previous, timestamp: now, label: describeEntry(merged), changes: merged }];
    historyState = { entries, cursor: entries.length - 1 };
    void writeHistory(historyState);
    renderPanel();
    return;
  }

  const entries = [
    ...appliedEntries,
    {
      id: historyId(),
      timestamp: now,
      label: describeEntry(changes),
      changes,
      ...(mutationId ? { mutationId } : {}),
      status: 'applied' as const,
    },
  ].slice(-HISTORY_LIMIT);
  historyState = { entries, cursor: entries.length - 1 };
  void writeHistory(historyState);
  renderPanel();
}

function recordProject(rawProject: string) {
  const nextProject = normalizeProject(rawProject);
  if (!nextProject) return;
  if (!lastProject) {
    lastProject = nextProject;
    return;
  }
  if (externalRecording || applyingHistory) {
    lastProject = nextProject;
    return;
  }
  if (nodeDragActive) {
    pendingDragProject = nextProject;
    return;
  }
  pendingDragProject = null;
  const changes = diffProjects(lastProject, nextProject);
  lastProject = nextProject;
  appendChanges(changes);
}

export function recordHistoryProject(project: unknown) {
  try {
    recordProject(typeof project === 'string' ? project : JSON.stringify(project));
  } catch {
    // Ignore transient non-serializable editor state.
  }
}

export function setHistoryExternalRecording(enabled: boolean) {
  externalRecording = enabled;
}

export function recordCommittedHistory(before: CanonicalProject, after: CanonicalProject, mutationId: string) {
  const changes = diffProjects(before, after);
  lastProject = cloneValue(after);
  appendChanges(changes, mutationId);
}

export async function setHistoryScope(scope: string, project: CanonicalProject, controller: OnlineHistoryController | null = null) {
  historyScope = scope;
  onlineController = controller;
  lastProject = cloneValue(project);
  pendingDragProject = null;
  historyState = controller ? normalizeHistoryState(await controller.load()) : readLocalHistory();
  renderPanel();
}

export function getHistoryState() {
  return cloneValue(historyState);
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
  if (dragFlushTimer !== null) {
    window.clearTimeout(dragFlushTimer);
    dragFlushTimer = null;
  }
}, true);
window.addEventListener('pointerup', finishNodeDrag, true);
window.addEventListener('pointercancel', finishNodeDrag, true);

Storage.prototype.setItem = function patchedSetItem(key: string, value: string) {
  nativeSetItem.call(this, key, value);
  if (this === localStorage && key === PROJECT_STORAGE_KEY) {
    recordProject(value);
    window.dispatchEvent(new CustomEvent(PROJECT_SAVED_EVENT, { detail: { rawProject: value } }));
  }
};

function transitionsForCursor(targetCursor: number): HistoryTransition[] {
  const target = Math.max(-1, Math.min(targetCursor, historyState.entries.length - 1));
  if (target === historyState.cursor) return [];
  if (target < historyState.cursor) {
    return historyState.entries.slice(target + 1, historyState.cursor + 1).reverse()
      .map((entry) => ({ direction: 'undo' as const, changes: entry.changes }));
  }
  return historyState.entries.slice(historyState.cursor + 1, target + 1)
    .map((entry) => ({ direction: 'redo' as const, changes: entry.changes }));
}

function dispatchTransitions(transitions: HistoryTransition[]) {
  window.dispatchEvent(new CustomEvent<HistoryApplyDetail>(HISTORY_APPLY_EVENT, { detail: { transitions } }));
}

async function applyOnlineStep(direction: HistoryDirection, targetCursor: number) {
  if (!onlineController || applyingHistory) return;
  const entryIndex = direction === 'undo' ? historyState.cursor : historyState.cursor + 1;
  const entry = historyState.entries[entryIndex];
  if (!entry) return;
  applyingHistory = true;
  try {
    const result = await onlineController.apply(direction, entry);
    if (!result.ok || !result.project) {
      const entries = historyState.entries.map((candidate, index) => index === entryIndex
        ? { ...candidate, status: 'conflicted' as const, conflictReason: result.reason ?? 'The shared project changed after this action.' }
        : candidate);
      historyState = { ...historyState, entries };
      await writeHistory(historyState);
      renderPanel();
      return;
    }

    const previous = lastProject;
    const project = result.project;
    lastProject = cloneValue(project);
    historyState = {
      ...historyState,
      cursor: targetCursor,
      entries: historyState.entries.map((candidate, index) => index === entryIndex
        ? { ...candidate, status: direction === 'undo' ? 'undone' as const : 'applied' as const, conflictReason: undefined }
        : candidate),
    };
    await writeHistory(historyState);
    nativeSetItem.call(localStorage, PROJECT_STORAGE_KEY, JSON.stringify(project));
    if (previous) dispatchTransitions([{ direction, changes: diffProjects(previous, project) }]);
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
    if (Math.abs(target - historyState.cursor) !== 1) return;
    void applyOnlineStep(target < historyState.cursor ? 'undo' : 'redo', target);
    return;
  }

  const transitions = transitionsForCursor(target);
  if (transitions.length === 0) return;
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
  if (event.shiftKey) redo();
  else undo();
}, true);

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]!);
}

function renderPanel() {
  const panel = document.querySelector<HTMLElement>('.history-panel');
  if (!panel) return;
  const canUndo = historyState.cursor >= 0;
  const canRedo = historyState.cursor < historyState.entries.length - 1;
  const recent = historyState.entries.map((entry, index) => ({ entry, index })).reverse();

  panel.hidden = !panelOpen;
  panel.innerHTML = `
    <div class="history-panel-head">
      <div><strong>Change history</strong><span>${historyState.entries.length}/${HISTORY_LIMIT} transactions${onlineController ? ' · this user' : ''}</span></div>
      <div class="history-step-actions">
        <button type="button" data-history-action="undo" ${canUndo ? '' : 'disabled'} title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
        <button type="button" data-history-action="redo" ${canRedo ? '' : 'disabled'} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
      </div>
    </div>
    <div class="history-list">
      ${recent.map(({ entry, index }) => `
        <button type="button" class="history-entry${index === historyState.cursor ? ' is-current' : ''}${entry.status === 'conflicted' ? ' is-conflicted' : ''}" data-history-index="${index}" ${onlineController && Math.abs(index - historyState.cursor) > 1 ? 'disabled' : ''}>
          <span class="history-dot"></span>
          <span class="history-entry-copy">
            <strong>${escapeHtml(entry.label)}</strong>
            <small>${entry.changes.length} change${entry.changes.length === 1 ? '' : 's'} · ${escapeHtml(formatKey(entry.changes[0]?.key ?? []))}</small>
            <small>${entry.status === 'conflicted' ? escapeHtml(entry.conflictReason ?? 'Conflict') : `${formatTime(entry.timestamp)}${index === historyState.cursor ? ' · Current' : index > historyState.cursor ? ' · Redo' : ''}`}</small>
          </span>
        </button>
      `).join('')}
      <button type="button" class="history-entry${historyState.cursor === -1 ? ' is-current' : ''}" data-history-index="-1" ${onlineController && historyState.cursor > 0 ? 'disabled' : ''}>
        <span class="history-dot"></span>
        <span class="history-entry-copy"><strong>Start of history</strong><small>Project baseline</small></span>
      </button>
    </div>
    <div class="history-panel-foot">Atomic changes · Ctrl+Z undo · Ctrl+Shift+Z redo${onlineController ? ' · collaborative guard checks enabled' : ''}</div>
  `;
}

function installHistoryUi() {
  if (document.querySelector('.history-control')) return true;
  const actions = document.querySelector<HTMLElement>('.top-actions');
  if (!actions) return false;
  if (!document.getElementById('history-control-styles')) {
    const style = document.createElement('style');
    style.id = 'history-control-styles';
    style.textContent = `
      .history-control { position: relative; display: inline-flex; }
      .history-button svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
      .history-panel { position: absolute; top: calc(100% + 9px); right: 0; width: min(350px, calc(100vw - 24px)); max-height: min(540px, calc(100vh - 92px)); overflow: hidden; border: 1px solid rgba(255,255,255,.12); border-radius: 12px; background: rgba(14,17,23,.98); box-shadow: 0 20px 60px rgba(0,0,0,.45); backdrop-filter: blur(18px); color: #dfe4e9; z-index: 100; }
      .history-panel[hidden] { display: none; }
      .history-panel-head { min-height: 54px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 11px 10px 13px; border-bottom: 1px solid rgba(255,255,255,.08); }
      .history-panel-head > div:first-child { display: grid; gap: 3px; }
      .history-panel-head strong { font-size: 11px; }
      .history-panel-head span, .history-entry small { color: #6f7886; font-size: 9px; }
      .history-step-actions { display: flex; gap: 5px; }
      .history-step-actions button { width: 30px; height: 30px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; background: #151a22; color: #aab2bd; font-size: 17px; line-height: 1; }
      .history-step-actions button:disabled { opacity: .3; cursor: not-allowed; }
      .history-list { max-height: 410px; overflow: auto; padding: 6px; scrollbar-width: thin; }
      .history-entry { width: 100%; min-height: 52px; display: grid; grid-template-columns: 13px 1fr; align-items: center; gap: 8px; padding: 7px 9px; border: 0; border-radius: 8px; background: transparent; color: #a8b0bb; text-align: left; }
      .history-entry:hover:not(:disabled) { background: rgba(255,255,255,.045); color: #eef2f6; }
      .history-entry:disabled { cursor: default; opacity: .72; }
      .history-entry.is-current { background: rgba(182,255,86,.055); color: #eef4e8; }
      .history-entry.is-conflicted { background: rgba(255,112,96,.06); }
      .history-dot { width: 7px; height: 7px; border: 1px solid #58606b; border-radius: 999px; justify-self: center; }
      .history-entry.is-current .history-dot { border-color: #b6ff56; background: #b6ff56; box-shadow: 0 0 9px rgba(182,255,86,.3); }
      .history-entry.is-conflicted .history-dot { border-color: #ff7060; background: #ff7060; }
      .history-entry-copy { min-width: 0; display: grid; gap: 2px; }
      .history-entry-copy strong, .history-entry-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .history-entry-copy strong { font-size: 10px; font-weight: 600; }
      .history-panel-foot { padding: 8px 12px 10px; border-top: 1px solid rgba(255,255,255,.07); color: #59616d; font-size: 8px; }
    `;
    document.head.appendChild(style);
  }

  const control = document.createElement('div');
  control.className = 'history-control';
  control.innerHTML = `<button type="button" class="ghost history-button" title="Change history" aria-label="Change history"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.34-5.66L4 8.68"></path><path d="M4 4v4.68h4.68"></path><path d="M12 7v5l3 2"></path></svg><span>History</span></button><div class="history-panel" hidden></div>`;
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
    const indexValue = target.closest<HTMLElement>('[data-history-index]')?.dataset.historyIndex;
    if (indexValue !== undefined) restoreCursor(Number(indexValue));
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
historyState = readLocalHistory();

if (!installHistoryUi()) {
  const observer = new MutationObserver(() => {
    if (installHistoryUi()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
