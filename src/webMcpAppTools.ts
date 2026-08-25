import { HISTORY_APPLY_EVENT, getHistoryProject, type HistoryApplyDetail } from './history';
import { readWorkingProject } from './localProjectStore';
import {
  diffProjects,
  isRecord,
  normalizeProject,
  sameValue,
  validateProjectGraph,
  type CanonicalProject,
  type JsonRecord,
} from './projectData';

const TOOL_PREFIX = 'skill_tree_';
const REGISTER_INTERVAL_MS = 1500;
const DEFAULT_WAIT_MS = 10000;

type ToolAnnotations = { readOnlyHint: boolean; openWorldHint: boolean; destructiveHint: boolean };
type ToolResponse = { content: Array<{ type: 'text'; text: string }> };
type ToolDefinition = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  execute: (input: Record<string, unknown>) => ToolResponse | Promise<ToolResponse>;
};
type ModelContextLike = {
  registerTool: (tool: ToolDefinition) => void | Promise<void>;
  getTools?: () => Promise<Array<{ name?: string }>>;
};
type WebMcpDocument = Document & { modelContext?: ModelContextLike };
type EditorView = 'tree' | 'perks' | 'playtest' | 'stats' | 'currencies' | 'icons';
type StorageMode = 'local' | 'online';
type PlaytestState = 'locked' | 'available' | 'unlocked';

type ProjectManagerSnapshot = {
  mode: StorageMode;
  status: string;
  activeProjectId: string | null;
  projects: Array<{ id: string; name: string; selected: boolean; updatedLabel: string }>;
};

type HistorySnapshot = {
  cursor: number;
  maxCursor: number;
  canUndo: boolean;
  canRedo: boolean;
  entries: Array<{ index: number; label: string; detail: string; time: string; current: boolean }>;
};

const registeredContexts = new WeakMap<ModelContextLike, Set<string>>();

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const write = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };
const destructive = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };

function toolResult(value: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) ?? String(value) }] };
}

function currentProject(): CanonicalProject {
  return getHistoryProject() ?? readWorkingProject();
}

function requireString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string.`);
  return value.trim();
}

function optionalString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  return value.trim();
}

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

async function waitFrames(count = 2) {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }
}

async function waitFor<T>(reader: () => T, predicate: (value: T) => boolean, timeoutMs = DEFAULT_WAIT_MS) {
  const startedAt = Date.now();
  let value = reader();
  while (!predicate(value)) {
    if (Date.now() - startedAt >= timeoutMs) return value;
    await wait(60);
    value = reader();
  }
  return value;
}

function textOf(element: Element | null) {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function clickElement(element: Element | null, errorMessage: string) {
  if (!(element instanceof HTMLElement)) throw new Error(errorMessage);
  element.click();
}

function exactButton(container: ParentNode, label: string) {
  const normalized = label.trim().toLocaleLowerCase();
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    textOf(button).toLocaleLowerCase() === normalized) ?? null;
}

const viewLabels: Record<EditorView, string> = {
  tree: 'Skill tree',
  perks: 'Perks',
  playtest: 'Playtest',
  stats: 'Stat pool',
  currencies: 'Currencies',
  icons: 'Icon pool',
};

function currentView(): EditorView | null {
  const button = document.querySelector<HTMLButtonElement>('.view-switcher button.active');
  if (!button) return null;
  const label = textOf(button).toLocaleLowerCase();
  return (Object.entries(viewLabels).find(([, value]) => value.toLocaleLowerCase() === label)?.[0] as EditorView | undefined) ?? null;
}

async function setView(view: EditorView) {
  if (currentView() === view) return view;
  const switcher = document.querySelector<HTMLElement>('.view-switcher');
  if (!switcher) throw new Error('The editor view switcher is not available yet.');
  clickElement(exactButton(switcher, viewLabels[view]), `Could not find the ${viewLabels[view]} view button.`);
  const resolved = await waitFor(currentView, (value) => value === view, 3000);
  if (resolved !== view) throw new Error(`The editor did not switch to ${viewLabels[view]}.`);
  await waitFrames();
  return view;
}

function entityData(entity: JsonRecord) {
  return isRecord(entity.data) ? entity.data : {};
}

function skillName(entity: JsonRecord) {
  const data = entityData(entity);
  return typeof data.name === 'string' ? data.name : '';
}

function skillId(entity: JsonRecord) {
  return typeof entity.id === 'string' ? entity.id : '';
}

function resolveSkill(reference: string) {
  const project = currentProject();
  const byId = project.nodes.find((node) => skillId(node) === reference);
  if (byId) return byId;
  const normalized = reference.trim().toLocaleLowerCase();
  const matches = project.nodes.filter((node) => skillName(node).trim().toLocaleLowerCase() === normalized);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Skill name “${reference}” is ambiguous. Use its ID.`);
  throw new Error(`Skill “${reference}” was not found.`);
}

function skillElement(id: string) {
  return [...document.querySelectorAll<HTMLElement>('[data-skill-node-id]')].find((element) => element.dataset.skillNodeId === id) ?? null;
}

function domPlaytestState(id: string): PlaytestState | null {
  const element = skillElement(id);
  if (!element) return null;
  if (element.classList.contains('is-playtest-unlocked')) return 'unlocked';
  if (element.classList.contains('is-playtest-available')) return 'available';
  if (element.classList.contains('is-playtest-locked')) return 'locked';
  return null;
}

async function ensurePlaytest() {
  await setView('playtest');
  const nodes = currentProject().nodes;
  await waitFor(
    () => nodes.length === 0 || nodes.every((node) => domPlaytestState(skillId(node)) !== null),
    Boolean,
    3000,
  );
}

function playtestSnapshot() {
  const project = currentProject();
  const states = project.nodes.map((node) => ({
    id: skillId(node),
    name: skillName(node),
    state: domPlaytestState(skillId(node)) ?? 'locked' as PlaytestState,
  }));
  return {
    unlockedCount: states.filter((item) => item.state === 'unlocked').length,
    totalNodes: states.length,
    skills: states,
  };
}

async function unlockPlaytestSkillById(id: string) {
  await ensurePlaytest();
  const before = domPlaytestState(id);
  if (before === 'unlocked') return { changed: false, state: before };
  if (before !== 'available') throw new Error('That skill is locked. Unlock every prerequisite first.');
  const element = skillElement(id);
  clickElement(element, 'The skill node is not currently rendered in Playtest.');
  const after = await waitFor(() => domPlaytestState(id), (state) => state === 'unlocked', 3000);
  if (after !== 'unlocked') throw new Error('The skill could not be unlocked in Playtest.');
  return { changed: true, state: after };
}

async function lockPlaytestSkillById(id: string) {
  await ensurePlaytest();
  const before = domPlaytestState(id);
  if (before !== 'unlocked') return { changed: false, state: before ?? 'locked' };
  const element = skillElement(id);
  if (!element) throw new Error('The skill node is not currently rendered in Playtest.');
  const rect = element.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  element.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    button: 2,
    buttons: 2,
    clientX,
    clientY,
    pointerId: 1,
    pointerType: 'mouse',
  }));
  window.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    button: 2,
    buttons: 0,
    clientX,
    clientY,
    pointerId: 1,
    pointerType: 'mouse',
  }));
  const after = await waitFor(() => domPlaytestState(id), (state) => state !== 'unlocked', 3000);
  if (after === 'unlocked') throw new Error('That skill is still required by another unlocked skill. Lock its dependents first.');
  return { changed: true, state: after ?? 'locked' };
}

async function resetPlaytest() {
  await ensurePlaytest();
  const project = currentProject();
  const children = new Map<string, Set<string>>();
  project.nodes.forEach((node) => children.set(skillId(node), new Set()));
  project.edges.forEach((edge) => {
    if (typeof edge.source === 'string' && typeof edge.target === 'string') children.get(edge.source)?.add(edge.target);
  });
  let changed = 0;
  for (let attempt = 0; attempt <= project.nodes.length; attempt += 1) {
    const unlocked = new Set(project.nodes.map(skillId).filter((id) => domPlaytestState(id) === 'unlocked'));
    if (!unlocked.size) return { changed: changed > 0, lockedCount: changed, ...playtestSnapshot() };
    const leaf = [...unlocked].find((id) => ![...(children.get(id) ?? [])].some((child) => unlocked.has(child)));
    if (!leaf) throw new Error('Could not find a lockable Playtest skill.');
    const result = await lockPlaytestSkillById(leaf);
    if (result.changed) changed += 1;
  }
  throw new Error('Playtest reset did not converge.');
}

function historyPanel() {
  return document.querySelector<HTMLElement>('.history-panel');
}

async function ensureHistoryPanel() {
  let panel = historyPanel();
  if (!panel) throw new Error('Change history is not available yet.');
  if (panel.hidden) {
    clickElement(document.querySelector('.history-button'), 'History button is not available.');
    await waitFrames();
    panel = historyPanel();
  }
  if (!panel || panel.hidden) throw new Error('Could not open change history.');
  return panel;
}

function readHistorySnapshot(): HistorySnapshot {
  const panel = historyPanel();
  if (!panel || panel.hidden) return { cursor: -1, maxCursor: -1, canUndo: false, canRedo: false, entries: [] };
  const entries = [...panel.querySelectorAll<HTMLElement>('.history-entry[data-history-index]')].map((element) => {
    const index = Number(element.dataset.historyIndex ?? -1);
    const smalls = element.querySelectorAll('small');
    return {
      index,
      label: textOf(element.querySelector('strong')),
      detail: textOf(smalls[0] ?? null),
      time: textOf(smalls[1] ?? null),
      current: element.classList.contains('is-current'),
    };
  }).sort((a, b) => a.index - b.index);
  const cursor = entries.find((entry) => entry.current)?.index ?? -1;
  const maxCursor = Math.max(-1, ...entries.map((entry) => entry.index));
  return { cursor, maxCursor, canUndo: cursor >= 0, canRedo: cursor < maxCursor, entries };
}

async function getHistorySnapshot() {
  await ensureHistoryPanel();
  return readHistorySnapshot();
}

async function triggerHistory(direction: 'undo' | 'redo') {
  const before = await getHistorySnapshot();
  const canMove = direction === 'undo' ? before.canUndo : before.canRedo;
  if (!canMove) return { changed: false, history: before };
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'z',
    code: 'KeyZ',
    ctrlKey: true,
    shiftKey: direction === 'redo',
    bubbles: true,
    cancelable: true,
  }));
  const history = await waitFor(
    readHistorySnapshot,
    (next) => next.cursor !== before.cursor,
    DEFAULT_WAIT_MS,
  );
  if (history.cursor === before.cursor) throw new Error(`${direction === 'undo' ? 'Undo' : 'Redo'} did not change the history cursor.`);
  return { changed: true, history };
}

async function restoreHistoryCursor(target: number) {
  const before = await getHistorySnapshot();
  const clamped = Math.max(-1, Math.min(Math.round(target), before.maxCursor));
  if (clamped === before.cursor) return { changed: false, history: before };
  const panel = await ensureHistoryPanel();
  const entry = [...panel.querySelectorAll<HTMLElement>('.history-entry[data-history-index]')].find((element) => Number(element.dataset.historyIndex) === clamped);
  clickElement(entry ?? null, `History cursor ${clamped} is not available.`);
  const history = await waitFor(readHistorySnapshot, (next) => next.cursor === clamped, DEFAULT_WAIT_MS);
  if (history.cursor !== clamped) throw new Error(`History did not reach cursor ${clamped}.`);
  return { changed: true, history };
}

async function ensureProjectPanel() {
  let panel = document.querySelector<HTMLElement>('.project-manager-panel');
  if (!panel) throw new Error('Project manager is not available yet.');
  if (panel.hidden) {
    clickElement(document.querySelector('.project-manager-button'), 'Project manager button is not available.');
    await waitFrames();
    panel = document.querySelector<HTMLElement>('.project-manager-panel');
  }
  if (!panel || panel.hidden) throw new Error('Could not open the project manager.');
  return panel;
}

function currentStorageMode(): StorageMode {
  const active = document.querySelector<HTMLButtonElement>('.project-manager-tabs button.active');
  return textOf(active).toLocaleLowerCase() === 'online' ? 'online' : 'local';
}

function readProjectManagerSnapshot(): ProjectManagerSnapshot {
  const panel = document.querySelector<HTMLElement>('.project-manager-panel');
  const rows = panel ? [...panel.querySelectorAll<HTMLElement>('.project-manager-row[data-project-id]')] : [];
  const projects = rows.map((row) => ({
    id: row.dataset.projectId ?? '',
    name: textOf(row.querySelector('strong')),
    selected: row.classList.contains('is-selected'),
    updatedLabel: textOf(row.querySelector('small')),
  }));
  return {
    mode: currentStorageMode(),
    status: textOf(document.querySelector('.project-manager-status')),
    activeProjectId: projects.find((project) => project.selected)?.id ?? null,
    projects,
  };
}

async function getProjectManagerSnapshot() {
  await ensureProjectPanel();
  return readProjectManagerSnapshot();
}

async function setStorageMode(mode: StorageMode) {
  const panel = await ensureProjectPanel();
  if (currentStorageMode() === mode) return readProjectManagerSnapshot();
  clickElement(exactButton(panel, mode === 'local' ? 'Local' : 'Online'), `Could not find the ${mode} project tab.`);
  const snapshot = await waitFor(readProjectManagerSnapshot, (value) => value.mode === mode, DEFAULT_WAIT_MS);
  if (snapshot.mode !== mode) throw new Error(`Could not switch to ${mode} project mode.`);
  await waitFrames();
  return readProjectManagerSnapshot();
}

function resolveProjectRow(reference: string) {
  const rows = [...document.querySelectorAll<HTMLElement>('.project-manager-row[data-project-id]')];
  const byId = rows.find((row) => row.dataset.projectId === reference);
  if (byId) return byId;
  const normalized = reference.trim().toLocaleLowerCase();
  const matches = rows.filter((row) => textOf(row.querySelector('strong')).trim().toLocaleLowerCase() === normalized);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Project name “${reference}” is ambiguous. Use its ID.`);
  throw new Error(`Project “${reference}” was not found in ${currentStorageMode()} mode.`);
}

async function selectProject(reference: string) {
  await ensureProjectPanel();
  const row = resolveProjectRow(reference);
  const id = row.dataset.projectId ?? '';
  if (row.classList.contains('is-selected')) return readProjectManagerSnapshot();
  clickElement(row.querySelector('.project-manager-select'), 'Project select button is not available.');
  const snapshot = await waitFor(
    readProjectManagerSnapshot,
    (value) => value.activeProjectId === id,
    DEFAULT_WAIT_MS,
  );
  if (snapshot.activeProjectId !== id) throw new Error('The project did not become active.');
  await waitFrames();
  return snapshot;
}

async function waitForNewProject(beforeIds: Set<string>) {
  const snapshot = await waitFor(
    readProjectManagerSnapshot,
    (value) => value.projects.some((project) => !beforeIds.has(project.id)),
    DEFAULT_WAIT_MS,
  );
  const created = snapshot.projects.find((project) => !beforeIds.has(project.id));
  if (!created) throw new Error('The project operation did not create a new project.');
  return created;
}

async function renameProject(reference: string, name: string) {
  await ensureProjectPanel();
  const row = resolveProjectRow(reference);
  const id = row.dataset.projectId ?? '';
  const originalPrompt = window.prompt;
  window.prompt = () => name;
  try {
    clickElement(row.querySelector('[data-project-action="rename"]'), 'Project rename button is not available.');
  } finally {
    window.prompt = originalPrompt;
  }
  const snapshot = await waitFor(
    readProjectManagerSnapshot,
    (value) => value.projects.some((project) => project.id === id && project.name === name),
    DEFAULT_WAIT_MS,
  );
  const renamed = snapshot.projects.find((project) => project.id === id);
  if (renamed?.name !== name) throw new Error('The project was not renamed.');
  return renamed;
}

async function createProject(name?: string, duplicate = false) {
  const panel = await ensureProjectPanel();
  const before = readProjectManagerSnapshot();
  const beforeIds = new Set(before.projects.map((project) => project.id));
  const action = duplicate ? 'duplicate' : 'new';
  clickElement(panel.querySelector(`[data-project-action="${action}"]`), `${duplicate ? 'Duplicate' : 'New'} project button is not available.`);
  const created = await waitForNewProject(beforeIds);
  if (name && created.name !== name) await renameProject(created.id, name);
  const snapshot = readProjectManagerSnapshot();
  return { project: snapshot.projects.find((project) => project.id === created.id) ?? created, mode: snapshot.mode };
}

async function deleteProject(reference: string) {
  await ensureProjectPanel();
  const row = resolveProjectRow(reference);
  const id = row.dataset.projectId ?? '';
  const originalConfirm = window.confirm;
  window.confirm = () => true;
  try {
    clickElement(row.querySelector('[data-project-action="delete"]'), 'Project delete button is not available.');
    const snapshot = await waitFor(
      readProjectManagerSnapshot,
      (value) => !value.projects.some((project) => project.id === id),
      DEFAULT_WAIT_MS,
    );
    if (snapshot.projects.some((project) => project.id === id)) throw new Error('The project was not deleted. Local mode must keep at least one project, and cloud deletion may also fail if the connection is unavailable.');
    return { deletedProjectId: id, ...snapshot };
  } finally {
    window.confirm = originalConfirm;
  }
}

async function copyProjectToOtherMode() {
  const panel = await ensureProjectPanel();
  const beforeMode = currentStorageMode();
  const beforeIds = new Set(readProjectManagerSnapshot().projects.map((project) => project.id));
  const button = panel.querySelector<HTMLElement>('[data-project-action="copy"]');
  if (button?.hasAttribute('disabled')) throw new Error('Copying to the other storage mode is unavailable. Configure Firebase first when copying online.');
  clickElement(button, 'Copy project button is not available.');
  const targetMode: StorageMode = beforeMode === 'local' ? 'online' : 'local';
  const snapshot = await waitFor(
    readProjectManagerSnapshot,
    (value) => value.mode === targetMode && (value.activeProjectId !== null || value.projects.some((project) => !beforeIds.has(project.id))),
    DEFAULT_WAIT_MS,
  );
  if (snapshot.mode !== targetMode) throw new Error('The project was not copied to the other storage mode.');
  return snapshot;
}

async function configureFirebase(config: unknown) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config must be a Firebase web configuration object.');
  await setStorageMode('online');
  let panel = await ensureProjectPanel();
  let textarea = panel.querySelector<HTMLTextAreaElement>('.project-manager-config textarea');
  if (!textarea) {
    const configure = panel.querySelector<HTMLElement>('[data-project-action="configure"]');
    if (configure) {
      clickElement(configure, 'Change Firebase button is not available.');
      await waitFrames();
      panel = await ensureProjectPanel();
      textarea = panel.querySelector<HTMLTextAreaElement>('.project-manager-config textarea');
    }
  }
  if (!textarea) throw new Error('Firebase configuration input is not available.');
  textarea.value = JSON.stringify(config, null, 2);
  clickElement(panel.querySelector('[data-project-action="connect"]'), 'Connect Firebase button is not available.');
  const snapshot = await waitFor(
    readProjectManagerSnapshot,
    (value) => !['Not connected', 'Connecting…', 'Firebase unavailable', 'Error'].includes(value.status) && Boolean(value.activeProjectId),
    DEFAULT_WAIT_MS,
  );
  if (!snapshot.activeProjectId || ['Not connected', 'Connecting…', 'Firebase unavailable', 'Error'].includes(snapshot.status)) {
    throw new Error(`Firebase did not connect successfully. Current status: ${snapshot.status || 'unknown'}.`);
  }
  return snapshot;
}

async function disconnectFirebase() {
  await setStorageMode('online');
  const panel = await ensureProjectPanel();
  const configure = panel.querySelector<HTMLElement>('[data-project-action="configure"]');
  if (!configure) return readProjectManagerSnapshot();
  clickElement(configure, 'Change Firebase button is not available.');
  const snapshot = await waitFor(readProjectManagerSnapshot, (value) => value.status === 'Not connected', DEFAULT_WAIT_MS);
  if (snapshot.status !== 'Not connected') throw new Error('Firebase did not disconnect.');
  return snapshot;
}

async function replaceProject(input: unknown) {
  let raw: string;
  try {
    raw = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    throw new Error('project must be JSON-serializable.');
  }
  const next = normalizeProject(raw);
  if (!next) throw new Error('project is not a valid Skill Tree Maker project.');
  const issue = validateProjectGraph(next);
  if (issue) throw new Error(issue);
  const before = currentProject();
  if (sameValue(before, next)) return { changed: false, changeCount: 0 };
  const changes = diffProjects(before, next);
  const detail: HistoryApplyDetail = { transitions: [{ direction: 'redo', changes }] };
  window.dispatchEvent(new CustomEvent<HistoryApplyDetail>(HISTORY_APPLY_EVENT, { detail }));
  await waitFrames(3);
  return { changed: true, changeCount: changes.length };
}

const tools: ToolDefinition[] = [
  {
    name: `${TOOL_PREFIX}replace_project`,
    title: 'Replace current project',
    description: 'Replace the complete current project from a Skill Tree Maker project object or JSON string. This is the MCP equivalent of importing project JSON and is recorded atomically in history.',
    inputSchema: { type: 'object', required: ['project'], properties: { project: {} }, additionalProperties: false },
    annotations: destructive,
    execute: async (input) => toolResult(await replaceProject(input.project)),
  },
  {
    name: `${TOOL_PREFIX}get_history`,
    title: 'Get change history',
    description: 'Return the current atomic change-history cursor and visible history entries.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    execute: async () => toolResult(await getHistorySnapshot()),
  },
  {
    name: `${TOOL_PREFIX}undo`, title: 'Undo', description: 'Undo one atomic project change using the same local or collaborative history path as Ctrl+Z.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: write,
    execute: async () => toolResult(await triggerHistory('undo')),
  },
  {
    name: `${TOOL_PREFIX}redo`, title: 'Redo', description: 'Redo one atomic project change using the same local or collaborative history path as Ctrl+Shift+Z.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: write,
    execute: async () => toolResult(await triggerHistory('redo')),
  },
  {
    name: `${TOOL_PREFIX}restore_history`, title: 'Restore history cursor', description: 'Move change history to a specific cursor index, applying the same guarded local or collaborative undo/redo operations as the History panel.',
    inputSchema: { type: 'object', required: ['cursor'], properties: { cursor: { type: 'integer', minimum: -1 } }, additionalProperties: false }, annotations: write,
    execute: async (input) => {
      if (typeof input.cursor !== 'number' || !Number.isInteger(input.cursor)) throw new Error('cursor must be an integer.');
      return toolResult(await restoreHistoryCursor(input.cursor));
    },
  },
  {
    name: `${TOOL_PREFIX}set_view`, title: 'Set editor view', description: 'Switch the application to Skill tree, Perks, Playtest, Stat pool, Currencies, or Icon pool.',
    inputSchema: { type: 'object', required: ['view'], properties: { view: { type: 'string', enum: ['tree', 'perks', 'playtest', 'stats', 'currencies', 'icons'] } }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult({ view: await setView(requireString(input, 'view') as EditorView) }),
  },
  {
    name: `${TOOL_PREFIX}get_playtest`, title: 'Get playtest state', description: 'Open Playtest and return each skill’s locked, available, or unlocked state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: write,
    execute: async () => { await ensurePlaytest(); return toolResult(playtestSnapshot()); },
  },
  {
    name: `${TOOL_PREFIX}unlock_playtest_skill`, title: 'Unlock playtest skill', description: 'Unlock a skill in Playtest if every prerequisite is unlocked.',
    inputSchema: { type: 'object', required: ['skill'], properties: { skill: { type: 'string' } }, additionalProperties: false }, annotations: write,
    execute: async (input) => {
      const skill = resolveSkill(requireString(input, 'skill'));
      return toolResult({ skillId: skillId(skill), ...(await unlockPlaytestSkillById(skillId(skill))) });
    },
  },
  {
    name: `${TOOL_PREFIX}lock_playtest_skill`, title: 'Lock playtest skill', description: 'Lock an unlocked Playtest skill if no currently unlocked skill depends on it.',
    inputSchema: { type: 'object', required: ['skill'], properties: { skill: { type: 'string' } }, additionalProperties: false }, annotations: write,
    execute: async (input) => {
      const skill = resolveSkill(requireString(input, 'skill'));
      return toolResult({ skillId: skillId(skill), ...(await lockPlaytestSkillById(skillId(skill))) });
    },
  },
  {
    name: `${TOOL_PREFIX}reset_playtest`, title: 'Reset playtest', description: 'Lock every currently unlocked Playtest skill in a dependency-safe order.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: write,
    execute: async () => toolResult(await resetPlaytest()),
  },
  {
    name: `${TOOL_PREFIX}list_projects`, title: 'List projects', description: 'List projects in the current storage mode, including the active project and connection status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: readOnly,
    execute: async () => toolResult(await getProjectManagerSnapshot()),
  },
  {
    name: `${TOOL_PREFIX}set_storage_mode`, title: 'Set storage mode', description: 'Switch the project manager between Local and Online storage modes.',
    inputSchema: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['local', 'online'] } }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await setStorageMode(requireString(input, 'mode') as StorageMode)),
  },
  {
    name: `${TOOL_PREFIX}select_project`, title: 'Select project', description: 'Select a project by ID or exact name in the current storage mode.',
    inputSchema: { type: 'object', required: ['project'], properties: { project: { type: 'string' } }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await selectProject(requireString(input, 'project'))),
  },
  {
    name: `${TOOL_PREFIX}create_project`, title: 'Create project', description: 'Create and select a blank project in the current storage mode.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await createProject(optionalString(input, 'name'))),
  },
  {
    name: `${TOOL_PREFIX}duplicate_project`, title: 'Duplicate project', description: 'Duplicate the current project in the current storage mode and select the copy.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await createProject(optionalString(input, 'name'), true)),
  },
  {
    name: `${TOOL_PREFIX}rename_project`, title: 'Rename project', description: 'Rename a project by ID or exact name in the current storage mode.',
    inputSchema: { type: 'object', required: ['project', 'name'], properties: { project: { type: 'string' }, name: { type: 'string' } }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await renameProject(requireString(input, 'project'), requireString(input, 'name'))),
  },
  {
    name: `${TOOL_PREFIX}delete_project`, title: 'Delete project', description: 'Delete a project in the current storage mode. Cloud deletion affects collaborators; local mode always keeps at least one project.',
    inputSchema: { type: 'object', required: ['project'], properties: { project: { type: 'string' } }, additionalProperties: false }, annotations: destructive,
    execute: async (input) => toolResult(await deleteProject(requireString(input, 'project'))),
  },
  {
    name: `${TOOL_PREFIX}copy_project_to_other_mode`, title: 'Copy project to other mode', description: 'Copy the current project Local→Online or Online→Local using the Project manager behavior. Firebase must already be configured for Local→Online.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: write,
    execute: async () => toolResult(await copyProjectToOtherMode()),
  },
  {
    name: `${TOOL_PREFIX}configure_firebase`, title: 'Configure Firebase', description: 'Configure the app’s Firebase web connection, enter Online mode, and select or create the online project.',
    inputSchema: { type: 'object', required: ['config'], properties: { config: { type: 'object', additionalProperties: true } }, additionalProperties: false }, annotations: write,
    execute: async (input) => toolResult(await configureFirebase(input.config)),
  },
  {
    name: `${TOOL_PREFIX}disconnect_firebase`, title: 'Disconnect Firebase', description: 'Disconnect and clear the saved Firebase configuration from the application.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: destructive,
    execute: async () => toolResult(await disconnectFirebase()),
  },
];

async function registerAppTools() {
  const context = (document as WebMcpDocument).modelContext;
  if (!context?.registerTool) return;
  const known = registeredContexts.get(context) ?? new Set<string>();
  try {
    if (context.getTools) (await context.getTools()).forEach((tool) => { if (typeof tool.name === 'string') known.add(tool.name); });
  } catch {
    // Some native runtimes expose registerTool without getTools.
  }
  for (const tool of tools) {
    if (known.has(tool.name)) continue;
    try { await context.registerTool(tool); known.add(tool.name); }
    catch (error) { console.warn(`[Skill Tree MCP] Failed to register ${tool.name}:`, error); }
  }
  registeredContexts.set(context, known);
}

void registerAppTools();
window.addEventListener('load', () => void registerAppTools());
window.setInterval(() => void registerAppTools(), REGISTER_INTERVAL_MS);
