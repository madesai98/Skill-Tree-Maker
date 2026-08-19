type JsonRecord = Record<string, unknown>;

type CanonicalProject = {
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

export type HistoryApplyDetail = {
  transitions: HistoryTransition[];
};

type HistoryEntry = {
  id: string;
  timestamp: number;
  label: string;
  changes: AtomicHistoryChange[];
};

type HistoryState = {
  entries: HistoryEntry[];
  cursor: number;
};

const PROJECT_STORAGE_KEY = 'incremental-td-skill-tree:v2';
const LEGACY_HISTORY_STORAGE_KEY = 'incremental-td-skill-tree:history:v1';
const HISTORY_STORAGE_KEY = 'incremental-td-skill-tree:history:v2';
const HISTORY_LIMIT = 50;
export const HISTORY_APPLY_EVENT = 'skill-tree-history-apply';

const nativeSetItem = Storage.prototype.setItem;
const nativeRemoveItem = Storage.prototype.removeItem;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeProject(raw: string): CanonicalProject | null {
  try {
    const value = JSON.parse(raw) as JsonRecord;
    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.stats)) return null;

    const nodes = value.nodes.flatMap<JsonRecord>((item) => {
      if (!isRecord(item) || typeof item.id !== 'string') return [];
      return [{
        id: item.id,
        type: item.type ?? 'skill',
        position: cloneValue(item.position),
        data: cloneValue(item.data),
      }];
    });

    const edges = value.edges.flatMap<JsonRecord>((item) => {
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
      stats: value.stats.filter(isRecord).map((item) => cloneValue(item)),
      currencies: Array.isArray(value.currencies)
        ? value.currencies.filter(isRecord).map((item) => cloneValue(item))
        : [],
    };
  } catch {
    return null;
  }
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
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
    const ids = [...oldMap.keys(), ...newMap.keys().filter((id) => !oldMap.has(id))];

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

function diffProjects(before: CanonicalProject, after: CanonicalProject) {
  const changes: AtomicHistoryChange[] = [];
  diffValue(before.nodes, after.nodes, ['nodes'], changes);
  diffValue(before.edges, after.edges, ['edges'], changes);
  diffValue(before.stats, after.stats, ['stats'], changes);
  diffValue(before.currencies, after.currencies, ['currencies'], changes);
  return changes;
}

function applyAtKey(
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

function targetSide(change: AtomicHistoryChange, direction: HistoryDirection) {
  return direction === 'undo'
    ? { exists: change.oldExists, value: change.oldValue, index: change.oldIndex }
    : { exists: change.newExists, value: change.newValue, index: change.newIndex };
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
      const side = targetSide(change, transition.direction);
      next = applyAtKey(next, change.key.slice(1), side.exists, side.value, side.index);
    });
  });

  return next as T[];
}

function applyTransitionsToProject(project: CanonicalProject, transitions: HistoryTransition[]) {
  let next: unknown = project;

  transitions.forEach((transition) => {
    const ordered = transition.direction === 'undo' ? [...transition.changes].reverse() : transition.changes;
    ordered.forEach((change) => {
      const side = targetSide(change, transition.direction);
      next = applyAtKey(next, change.key, side.exists, side.value, side.index);
    });
  });

  return next as CanonicalProject;
}

function validChange(value: unknown): value is AtomicHistoryChange {
  if (!isRecord(value) || !Array.isArray(value.key) || !value.key.every((part) => typeof part === 'string')) return false;
  return typeof value.oldExists === 'boolean' && typeof value.newExists === 'boolean';
}

function readHistory(): HistoryState {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) ?? '') as HistoryState;
    if (!Array.isArray(parsed.entries) || typeof parsed.cursor !== 'number') throw new Error('Invalid history');

    const entries = parsed.entries
      .filter((entry) => entry && Array.isArray(entry.changes) && entry.changes.every(validChange))
      .slice(-HISTORY_LIMIT);
    const removedCount = Math.max(0, parsed.entries.length - entries.length);
    const cursor = Math.max(-1, Math.min(parsed.cursor - removedCount, entries.length - 1));
    return { entries, cursor };
  } catch {
    return { entries: [], cursor: -1 };
  }
}

function writeHistory(state: HistoryState) {
  nativeSetItem.call(localStorage, HISTORY_STORAGE_KEY, JSON.stringify(state));
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

nativeRemoveItem.call(localStorage, LEGACY_HISTORY_STORAGE_KEY);
let historyState = readHistory();
let panelOpen = false;
let lastProject = (() => {
  const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
  return raw ? normalizeProject(raw) : null;
})();

function recordProject(rawProject: string) {
  const nextProject = normalizeProject(rawProject);
  if (!nextProject) return;

  if (!lastProject) {
    lastProject = nextProject;
    return;
  }

  const changes = diffProjects(lastProject, nextProject);
  lastProject = nextProject;
  if (changes.length === 0) return;

  const entries = [
    ...historyState.entries.slice(0, historyState.cursor + 1),
    {
      id: historyId(),
      timestamp: Date.now(),
      label: describeEntry(changes),
      changes,
    },
  ].slice(-HISTORY_LIMIT);

  historyState = { entries, cursor: entries.length - 1 };
  writeHistory(historyState);
  renderPanel();
}

Storage.prototype.setItem = function patchedSetItem(key: string, value: string) {
  nativeSetItem.call(this, key, value);
  if (this === localStorage && key === PROJECT_STORAGE_KEY) recordProject(value);
};

function transitionsForCursor(targetCursor: number): HistoryTransition[] {
  const target = Math.max(-1, Math.min(targetCursor, historyState.entries.length - 1));
  if (target === historyState.cursor) return [];

  if (target < historyState.cursor) {
    return historyState.entries
      .slice(target + 1, historyState.cursor + 1)
      .reverse()
      .map((entry) => ({ direction: 'undo' as const, changes: entry.changes }));
  }

  return historyState.entries
    .slice(historyState.cursor + 1, target + 1)
    .map((entry) => ({ direction: 'redo' as const, changes: entry.changes }));
}

function restoreCursor(targetCursor: number) {
  if (!lastProject) return;
  const target = Math.max(-1, Math.min(targetCursor, historyState.entries.length - 1));
  const transitions = transitionsForCursor(target);
  if (transitions.length === 0) return;

  lastProject = applyTransitionsToProject(lastProject, transitions);
  historyState = { ...historyState, cursor: target };
  writeHistory(historyState);
  nativeSetItem.call(localStorage, PROJECT_STORAGE_KEY, JSON.stringify(lastProject));

  window.dispatchEvent(new CustomEvent<HistoryApplyDetail>(HISTORY_APPLY_EVENT, {
    detail: { transitions },
  }));
  renderPanel();
}

function undo() {
  restoreCursor(historyState.cursor - 1);
}

function redo() {
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
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
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
      <div><strong>Change history</strong><span>${historyState.entries.length}/${HISTORY_LIMIT} atomic transactions</span></div>
      <div class="history-step-actions">
        <button type="button" data-history-action="undo" ${canUndo ? '' : 'disabled'} title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
        <button type="button" data-history-action="redo" ${canRedo ? '' : 'disabled'} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
      </div>
    </div>
    <div class="history-list">
      ${recent.map(({ entry, index }) => `
        <button type="button" class="history-entry${index === historyState.cursor ? ' is-current' : ''}" data-history-index="${index}">
          <span class="history-dot"></span>
          <span class="history-entry-copy">
            <strong>${escapeHtml(entry.label)}</strong>
            <small>${entry.changes.length} change${entry.changes.length === 1 ? '' : 's'} · ${escapeHtml(formatKey(entry.changes[0]?.key ?? []))}</small>
            <small>${formatTime(entry.timestamp)}${index === historyState.cursor ? ' · Current' : index > historyState.cursor ? ' · Redo' : ''}</small>
          </span>
        </button>
      `).join('')}
      <button type="button" class="history-entry${historyState.cursor === -1 ? ' is-current' : ''}" data-history-index="-1">
        <span class="history-dot"></span>
        <span class="history-entry-copy"><strong>Start of history</strong><small>No stored snapshot · baseline project state</small></span>
      </button>
    </div>
    <div class="history-panel-foot">Atomic key/value changes only · Ctrl+Z undo · Ctrl+Shift+Z redo</div>
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
      .history-panel-head span { color: #6f7886; font-size: 9px; }
      .history-step-actions { display: flex; gap: 5px; }
      .history-step-actions button { width: 30px; height: 30px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; background: #151a22; color: #aab2bd; font-size: 17px; line-height: 1; }
      .history-step-actions button:hover:not(:disabled) { color: #f3f5f7; background: #1b212b; }
      .history-step-actions button:disabled { opacity: .3; cursor: not-allowed; }
      .history-list { max-height: 410px; overflow: auto; padding: 6px; scrollbar-width: thin; scrollbar-color: #2b323c transparent; }
      .history-entry { width: 100%; min-height: 52px; display: grid; grid-template-columns: 13px 1fr; align-items: center; gap: 8px; padding: 7px 9px; border: 0; border-radius: 8px; background: transparent; color: #a8b0bb; text-align: left; }
      .history-entry:hover { background: rgba(255,255,255,.045); color: #eef2f6; }
      .history-entry.is-current { background: rgba(182,255,86,.055); color: #eef2f6; }
      .history-dot { width: 7px; height: 7px; justify-self: center; border: 1px solid #596372; border-radius: 50%; background: #252b34; }
      .history-entry.is-current .history-dot { border-color: #b6ff56; background: #b6ff56; box-shadow: 0 0 10px rgba(182,255,86,.35); }
      .history-entry-copy { min-width: 0; display: grid; gap: 2px; }
      .history-entry-copy strong, .history-entry-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .history-entry-copy strong { font-size: 10px; font-weight: 680; }
      .history-entry-copy small { color: #687180; font-size: 9px; }
      .history-panel-foot { padding: 8px 12px 9px; border-top: 1px solid rgba(255,255,255,.07); color: #606978; font-size: 9px; text-align: center; }
      @media (max-width: 760px) { .history-panel { position: fixed; top: 68px; right: 8px; } }
    `;
    document.head.appendChild(style);
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'history-control';
  wrapper.innerHTML = `
    <button type="button" class="icon-button labeled history-button" aria-label="Change history" title="Change history">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2" /></svg>
      History
    </button>
    <div class="history-panel" hidden></div>
  `;

  const firstActionButton = actions.querySelector('.icon-button');
  actions.insertBefore(wrapper, firstActionButton);

  wrapper.querySelector('.history-button')?.addEventListener('click', (event) => {
    event.stopPropagation();
    panelOpen = !panelOpen;
    renderPanel();
  });
  wrapper.querySelector('.history-panel')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const actionButton = target.closest<HTMLElement>('[data-history-action]');
    if (actionButton?.dataset.historyAction === 'undo') undo();
    if (actionButton?.dataset.historyAction === 'redo') redo();
    const entryButton = target.closest<HTMLElement>('[data-history-index]');
    if (entryButton?.dataset.historyIndex !== undefined) restoreCursor(Number(entryButton.dataset.historyIndex));
  });
  document.addEventListener('click', () => {
    if (!panelOpen) return;
    panelOpen = false;
    renderPanel();
  });

  renderPanel();
  return true;
}

if (!installHistoryUi()) {
  const observer = new MutationObserver(() => {
    if (installHistoryUi()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
