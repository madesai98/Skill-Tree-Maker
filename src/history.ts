type ProjectShape = {
  version?: number;
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  stats?: Array<Record<string, unknown>>;
  currencies?: Array<Record<string, unknown>>;
};

type HistoryEntry = {
  snapshot: string;
  timestamp: number;
  label: string;
};

type HistoryState = {
  entries: HistoryEntry[];
  cursor: number;
};

const PROJECT_STORAGE_KEY = 'incremental-td-skill-tree:v2';
const HISTORY_STORAGE_KEY = 'incremental-td-skill-tree:history:v1';
const HISTORY_LIMIT = 50;
const nativeSetItem = Storage.prototype.setItem;

function canonicalizeProject(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as ProjectShape;
    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.stats)) return null;

    return JSON.stringify({
      version: 2,
      nodes: value.nodes.map((node) => ({
        id: node.id,
        type: node.type ?? 'skill',
        position: node.position,
        data: node.data,
      })),
      edges: value.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.type ?? 'skillLink',
      })),
      stats: value.stats,
      currencies: Array.isArray(value.currencies) ? value.currencies : [],
    });
  } catch {
    return null;
  }
}

function readHistory(): HistoryState {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) ?? '') as HistoryState;
    if (!Array.isArray(parsed.entries) || typeof parsed.cursor !== 'number') throw new Error('Invalid history');
    const entries = parsed.entries
      .filter((entry) => entry && typeof entry.snapshot === 'string')
      .slice(-HISTORY_LIMIT);
    const cursor = Math.max(0, Math.min(parsed.cursor - Math.max(0, parsed.entries.length - HISTORY_LIMIT), entries.length - 1));
    return { entries, cursor };
  } catch {
    return { entries: [], cursor: -1 };
  }
}

function writeHistory(state: HistoryState) {
  nativeSetItem.call(localStorage, HISTORY_STORAGE_KEY, JSON.stringify(state));
}

function projectFromSnapshot(snapshot: string): ProjectShape {
  try {
    return JSON.parse(snapshot) as ProjectShape;
  } catch {
    return {};
  }
}

function describeChange(beforeSnapshot: string, afterSnapshot: string) {
  const before = projectFromSnapshot(beforeSnapshot);
  const after = projectFromSnapshot(afterSnapshot);
  const beforeNodes = before.nodes ?? [];
  const afterNodes = after.nodes ?? [];
  const beforeEdges = before.edges ?? [];
  const afterEdges = after.edges ?? [];
  const beforeStats = before.stats ?? [];
  const afterStats = after.stats ?? [];
  const beforeCurrencies = before.currencies ?? [];
  const afterCurrencies = after.currencies ?? [];

  if (afterNodes.length > beforeNodes.length) return `Added ${afterNodes.length - beforeNodes.length} skill${afterNodes.length - beforeNodes.length === 1 ? '' : 's'}`;
  if (afterNodes.length < beforeNodes.length) return `Removed ${beforeNodes.length - afterNodes.length} skill${beforeNodes.length - afterNodes.length === 1 ? '' : 's'}`;
  if (afterEdges.length > beforeEdges.length) return `Added ${afterEdges.length - beforeEdges.length} prerequisite${afterEdges.length - beforeEdges.length === 1 ? '' : 's'}`;
  if (afterEdges.length < beforeEdges.length) return `Removed ${beforeEdges.length - afterEdges.length} prerequisite${beforeEdges.length - afterEdges.length === 1 ? '' : 's'}`;
  if (afterStats.length > beforeStats.length) return 'Added stat';
  if (afterStats.length < beforeStats.length) return 'Removed stat';
  if (afterCurrencies.length > beforeCurrencies.length) return 'Added currency';
  if (afterCurrencies.length < beforeCurrencies.length) return 'Removed currency';

  const beforeNodeMap = new Map(beforeNodes.map((node) => [String(node.id), JSON.stringify({ position: node.position, data: node.data })]));
  const changedNode = afterNodes.find((node) => beforeNodeMap.get(String(node.id)) !== JSON.stringify({ position: node.position, data: node.data }));
  if (changedNode) {
    const data = changedNode.data as { name?: unknown } | undefined;
    const name = typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : 'skill';
    return `Edited ${name}`;
  }
  if (JSON.stringify(beforeStats) !== JSON.stringify(afterStats)) return 'Edited stat pool';
  if (JSON.stringify(beforeCurrencies) !== JSON.stringify(afterCurrencies)) return 'Edited currencies';
  return 'Project change';
}

function initializeHistory() {
  const rawProject = localStorage.getItem(PROJECT_STORAGE_KEY);
  const currentSnapshot = rawProject ? canonicalizeProject(rawProject) : null;
  const state = readHistory();

  if (!currentSnapshot) return state;
  if (state.entries.length === 0) {
    const initial: HistoryState = {
      entries: [{ snapshot: currentSnapshot, timestamp: Date.now(), label: 'Initial state' }],
      cursor: 0,
    };
    writeHistory(initial);
    return initial;
  }

  if (state.entries[state.cursor]?.snapshot === currentSnapshot) return state;
  const existingIndex = state.entries.findIndex((entry) => entry.snapshot === currentSnapshot);
  if (existingIndex >= 0) {
    const next = { ...state, cursor: existingIndex };
    writeHistory(next);
    return next;
  }

  const entries = [
    ...state.entries.slice(0, state.cursor + 1),
    { snapshot: currentSnapshot, timestamp: Date.now(), label: 'Restored project' },
  ].slice(-HISTORY_LIMIT);
  const next = { entries, cursor: entries.length - 1 };
  writeHistory(next);
  return next;
}

let historyState = initializeHistory();
let panelOpen = false;

function recordProject(rawProject: string) {
  const snapshot = canonicalizeProject(rawProject);
  if (!snapshot || historyState.entries[historyState.cursor]?.snapshot === snapshot) return;

  const previousSnapshot = historyState.entries[historyState.cursor]?.snapshot;
  const entries = [
    ...historyState.entries.slice(0, historyState.cursor + 1),
    {
      snapshot,
      timestamp: Date.now(),
      label: previousSnapshot ? describeChange(previousSnapshot, snapshot) : 'Project change',
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

function restoreIndex(index: number) {
  if (index < 0 || index >= historyState.entries.length || index === historyState.cursor) return;
  historyState = { ...historyState, cursor: index };
  writeHistory(historyState);
  nativeSetItem.call(localStorage, PROJECT_STORAGE_KEY, historyState.entries[index].snapshot);
  window.location.reload();
}

function undo() {
  restoreIndex(historyState.cursor - 1);
}

function redo() {
  restoreIndex(historyState.cursor + 1);
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

function renderPanel() {
  const panel = document.querySelector<HTMLElement>('.history-panel');
  if (!panel) return;

  const canUndo = historyState.cursor > 0;
  const canRedo = historyState.cursor >= 0 && historyState.cursor < historyState.entries.length - 1;
  const recent = historyState.entries
    .map((entry, index) => ({ entry, index }))
    .reverse();

  panel.hidden = !panelOpen;
  panel.innerHTML = `
    <div class="history-panel-head">
      <div><strong>Change history</strong><span>${historyState.entries.length}/${HISTORY_LIMIT} states</span></div>
      <div class="history-step-actions">
        <button type="button" data-history-action="undo" ${canUndo ? '' : 'disabled'} title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
        <button type="button" data-history-action="redo" ${canRedo ? '' : 'disabled'} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
      </div>
    </div>
    <div class="history-list">
      ${recent.map(({ entry, index }) => `
        <button type="button" class="history-entry${index === historyState.cursor ? ' is-current' : ''}" data-history-index="${index}">
          <span class="history-dot"></span>
          <span class="history-entry-copy"><strong>${escapeHtml(entry.label)}</strong><small>${formatTime(entry.timestamp)}${index === historyState.cursor ? ' · Current' : ''}</small></span>
        </button>
      `).join('')}
    </div>
    <div class="history-panel-foot">Ctrl+Z undo · Ctrl+Shift+Z redo</div>
  `;
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
      .history-panel { position: absolute; top: calc(100% + 9px); right: 0; width: min(330px, calc(100vw - 24px)); max-height: min(520px, calc(100vh - 92px)); overflow: hidden; border: 1px solid rgba(255,255,255,.12); border-radius: 12px; background: rgba(14,17,23,.98); box-shadow: 0 20px 60px rgba(0,0,0,.45); backdrop-filter: blur(18px); color: #dfe4e9; z-index: 100; }
      .history-panel[hidden] { display: none; }
      .history-panel-head { min-height: 54px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 11px 10px 13px; border-bottom: 1px solid rgba(255,255,255,.08); }
      .history-panel-head > div:first-child { display: grid; gap: 3px; }
      .history-panel-head strong { font-size: 11px; }
      .history-panel-head span { color: #6f7886; font-size: 9px; }
      .history-step-actions { display: flex; gap: 5px; }
      .history-step-actions button { width: 30px; height: 30px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; background: #151a22; color: #aab2bd; font-size: 17px; line-height: 1; }
      .history-step-actions button:hover:not(:disabled) { color: #f3f5f7; background: #1b212b; }
      .history-step-actions button:disabled { opacity: .3; cursor: not-allowed; }
      .history-list { max-height: 390px; overflow: auto; padding: 6px; scrollbar-width: thin; scrollbar-color: #2b323c transparent; }
      .history-entry { width: 100%; min-height: 48px; display: grid; grid-template-columns: 13px 1fr; align-items: center; gap: 8px; padding: 7px 9px; border: 0; border-radius: 8px; background: transparent; color: #a8b0bb; text-align: left; }
      .history-entry:hover { background: rgba(255,255,255,.045); color: #eef2f6; }
      .history-entry.is-current { background: rgba(182,255,86,.055); color: #eef2f6; }
      .history-dot { width: 7px; height: 7px; justify-self: center; border: 1px solid #596372; border-radius: 50%; background: #252b34; }
      .history-entry.is-current .history-dot { border-color: #b6ff56; background: #b6ff56; box-shadow: 0 0 10px rgba(182,255,86,.35); }
      .history-entry-copy { min-width: 0; display: grid; gap: 3px; }
      .history-entry-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; font-weight: 680; }
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
    if (entryButton?.dataset.historyIndex) restoreIndex(Number(entryButton.dataset.historyIndex));
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
