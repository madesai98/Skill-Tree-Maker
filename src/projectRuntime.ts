import {
  deleteApp,
  getApp,
  getApps,
  initializeApp,
  type FirebaseApp,
  type FirebaseOptions,
} from 'firebase/app';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  runTransaction,
  setDoc,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  HISTORY_APPLY_EVENT,
  PROJECT_SAVED_EVENT,
  recordCommittedHistory,
  setHistoryExternalRecording,
  setHistoryScope,
  type HistoryEntry,
  type HistoryState,
  type OnlineHistoryController,
} from './history';
import {
  applyAtKey,
  cloneValue,
  createBlankProject,
  createStarterProject,
  diffProjects,
  guardEntityKeys,
  normalizeProject,
  readAtKey,
  sameValue,
  sideForDirection,
  sourceSideForDirection,
  touchedEntityKeys,
  validateProjectGraph,
  valueMatchesSide,
  type AtomicHistoryChange,
  type CanonicalProject,
  type HistoryDirection,
} from './projectData';

const WORKING_PROJECT_KEY = 'incremental-td-skill-tree:v2';
const USER_ID_KEY = 'skill-tree:user-id';
const SETTINGS_KEY = 'skill-tree:project-settings:v1';
const LOCAL_INDEX_KEY = 'skill-tree:local-projects:v1';
const LOCAL_PROJECT_PREFIX = 'skill-tree:local-project:v1:';
const LEGACY_HISTORY_V2_KEY = 'incremental-td-skill-tree:history:v2';
const HISTORY_V3_PREFIX = 'incremental-td-skill-tree:history:v3:';
const CLOUD_COLLECTION = 'skillTreeMakerProjects';
const FIREBASE_APP_NAME = 'skill-tree-maker-online';

export type StorageMode = 'local' | 'online';

type ProjectMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

type RuntimeSettings = {
  mode: StorageMode;
  selectedLocalProjectId: string | null;
  selectedOnlineProjectId: string | null;
  firebaseConfig: FirebaseOptions | null;
};

type CloudProjectDocument = {
  name: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  project: CanonicalProject;
  fieldWriters: Record<string, string>;
  entityWriters: Record<string, string>;
};

const userId = getOrCreateUserId();
let settings = readSettings();
let mode: StorageMode = 'local';
let localProjects = readLocalIndex();
let activeProjectId = '';
let activeProject: CanonicalProject = readWorkingProject();
let firebaseApp: FirebaseApp | null = null;
let firestore: Firestore | null = null;
let cloudProjects: ProjectMeta[] = [];
let cloudBaseProject: CanonicalProject | null = null;
let cloudBaseDocument: CloudProjectDocument | null = null;
let cloudUnsubscribe: Unsubscribe | null = null;
let applyingExternalProject = false;
let cloudWriteInFlight = false;
let projectPanelOpen = false;
let connectionStatus = 'Local';
let uiInstalled = false;

function randomId(prefix: string) {
  const id = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

function getOrCreateUserId() {
  const existing = localStorage.getItem(USER_ID_KEY);
  if (existing) return existing;
  const id = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(USER_ID_KEY, id);
  return id;
}

function readSettings(): RuntimeSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '') as Partial<RuntimeSettings>;
    return {
      mode: parsed.mode === 'online' ? 'online' : 'local',
      selectedLocalProjectId: typeof parsed.selectedLocalProjectId === 'string' ? parsed.selectedLocalProjectId : null,
      selectedOnlineProjectId: typeof parsed.selectedOnlineProjectId === 'string' ? parsed.selectedOnlineProjectId : null,
      firebaseConfig: parsed.firebaseConfig && typeof parsed.firebaseConfig === 'object' ? parsed.firebaseConfig : null,
    };
  } catch {
    return { mode: 'local', selectedLocalProjectId: null, selectedOnlineProjectId: null, firebaseConfig: null };
  }
}

function writeSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function readLocalIndex(): ProjectMeta[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_INDEX_KEY) ?? '') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as Partial<ProjectMeta>;
      if (typeof value.id !== 'string' || typeof value.name !== 'string') return [];
      const createdAt = typeof value.createdAt === 'number' ? value.createdAt : Date.now();
      const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : createdAt;
      return [{ id: value.id, name: value.name, createdAt, updatedAt }];
    });
  } catch {
    return [];
  }
}

function writeLocalIndex() {
  localStorage.setItem(LOCAL_INDEX_KEY, JSON.stringify(localProjects));
}

function localProjectKey(id: string) {
  return `${LOCAL_PROJECT_PREFIX}${id}`;
}

function readWorkingProject() {
  const normalized = normalizeProject(localStorage.getItem(WORKING_PROJECT_KEY) ?? '');
  return normalized ?? createStarterProject();
}

function readLocalProject(id: string) {
  return normalizeProject(localStorage.getItem(localProjectKey(id)) ?? '');
}

function saveLocalProject(id: string, project: CanonicalProject) {
  localStorage.setItem(localProjectKey(id), JSON.stringify(project));
  const now = Date.now();
  localProjects = localProjects.map((item) => item.id === id ? { ...item, updatedAt: now } : item);
  writeLocalIndex();
}

function ensureLocalMigration() {
  if (localProjects.length > 0) return;
  const now = Date.now();
  const id = randomId('project');
  const project = readWorkingProject();
  localProjects = [{ id, name: 'My Skill Tree', createdAt: now, updatedAt: now }];
  localStorage.setItem(localProjectKey(id), JSON.stringify(project));
  writeLocalIndex();
  settings = { ...settings, selectedLocalProjectId: id };
  writeSettings();

  const oldHistory = localStorage.getItem(LEGACY_HISTORY_V2_KEY);
  if (oldHistory && !localStorage.getItem(`${HISTORY_V3_PREFIX}local:${id}`)) {
    localStorage.setItem(`${HISTORY_V3_PREFIX}local:${id}`, oldHistory);
  }
}

function projectPath(change: AtomicHistoryChange) {
  return change.key.join('\u001f');
}

function dispatchProjectChange(before: CanonicalProject, after: CanonicalProject) {
  const changes = diffProjects(before, after);
  if (changes.length === 0) return;
  window.dispatchEvent(new CustomEvent(HISTORY_APPLY_EVENT, {
    detail: { transitions: [{ direction: 'redo', changes }] },
  }));
}

async function applyWorkingProject(project: CanonicalProject, scope: string, controller: OnlineHistoryController | null) {
  const before = readWorkingProject();
  applyingExternalProject = true;
  setHistoryExternalRecording(true);
  try {
    localStorage.setItem(WORKING_PROJECT_KEY, JSON.stringify(project));
    activeProject = cloneValue(project);
    await setHistoryScope(scope, project, controller);
    dispatchProjectChange(before, project);
  } finally {
    setHistoryExternalRecording(false);
    applyingExternalProject = false;
  }
}

function selectedLocalMeta() {
  return localProjects.find((item) => item.id === settings.selectedLocalProjectId) ?? localProjects[0] ?? null;
}

async function switchLocalProject(id: string) {
  const project = readLocalProject(id);
  if (!project) return;
  stopCloudSubscription();
  mode = 'local';
  settings = { ...settings, mode: 'local', selectedLocalProjectId: id };
  writeSettings();
  activeProjectId = id;
  connectionStatus = 'Local';
  await applyWorkingProject(project, `local:${id}`, null);
  renderProjectUi();
}

async function createLocalProject(source?: CanonicalProject, name?: string) {
  const now = Date.now();
  const id = randomId('project');
  const project = cloneValue(source ?? createBlankProject(activeProject));
  localProjects = [
    ...localProjects,
    { id, name: name ?? `Skill Tree ${localProjects.length + 1}`, createdAt: now, updatedAt: now },
  ];
  localStorage.setItem(localProjectKey(id), JSON.stringify(project));
  writeLocalIndex();
  await switchLocalProject(id);
}

async function deleteLocalProject(id: string) {
  if (localProjects.length <= 1) {
    window.alert('At least one local project must remain.');
    return;
  }
  const meta = localProjects.find((item) => item.id === id);
  if (!meta || !window.confirm(`Delete local project “${meta.name}”?`)) return;
  localStorage.removeItem(localProjectKey(id));
  localStorage.removeItem(`${HISTORY_V3_PREFIX}local:${id}`);
  localProjects = localProjects.filter((item) => item.id !== id);
  writeLocalIndex();
  if (settings.selectedLocalProjectId === id) await switchLocalProject(localProjects[0].id);
  else renderProjectUi();
}

function renameLocalProject(id: string) {
  const meta = localProjects.find((item) => item.id === id);
  if (!meta) return;
  const name = window.prompt('Project name', meta.name)?.trim();
  if (!name) return;
  localProjects = localProjects.map((item) => item.id === id ? { ...item, name, updatedAt: Date.now() } : item);
  writeLocalIndex();
  renderProjectUi();
}

async function configureFirebase(config: FirebaseOptions) {
  if (firebaseApp) {
    cloudUnsubscribe?.();
    cloudUnsubscribe = null;
    await deleteApp(firebaseApp);
    firebaseApp = null;
    firestore = null;
  }
  const existing = getApps().find((app) => app.name === FIREBASE_APP_NAME);
  if (existing) await deleteApp(getApp(FIREBASE_APP_NAME));
  firebaseApp = initializeApp(config, FIREBASE_APP_NAME);
  firestore = getFirestore(firebaseApp);
  settings = { ...settings, firebaseConfig: config };
  writeSettings();
  connectionStatus = 'Cloud ready';
  await refreshCloudProjects();
}

function parseCloudDocument(raw: unknown): CloudProjectDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<CloudProjectDocument>;
  const project = normalizeProject(value.project);
  if (!project || typeof value.name !== 'string') return null;
  return {
    name: value.name,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
    revision: typeof value.revision === 'number' ? value.revision : 0,
    project,
    fieldWriters: value.fieldWriters && typeof value.fieldWriters === 'object' ? value.fieldWriters : {},
    entityWriters: value.entityWriters && typeof value.entityWriters === 'object' ? value.entityWriters : {},
  };
}

async function refreshCloudProjects() {
  if (!firestore) return;
  const snapshot = await getDocs(query(collection(firestore, CLOUD_COLLECTION)));
  cloudProjects = snapshot.docs.flatMap((item) => {
    const parsed = parseCloudDocument(item.data());
    return parsed ? [{ id: item.id, name: parsed.name, createdAt: parsed.createdAt, updatedAt: parsed.updatedAt }] : [];
  }).sort((a, b) => b.updatedAt - a.updatedAt);
  renderProjectUi();
}

function onlineHistoryController(projectId: string): OnlineHistoryController {
  return {
    async load() {
      if (!firestore) return { entries: [], cursor: -1 };
      const snapshot = await getDoc(doc(firestore, CLOUD_COLLECTION, projectId, 'histories', userId));
      if (!snapshot.exists()) return { entries: [], cursor: -1 };
      const data = snapshot.data() as Partial<HistoryState>;
      return {
        entries: Array.isArray(data.entries) ? data.entries as HistoryEntry[] : [],
        cursor: typeof data.cursor === 'number' ? data.cursor : -1,
      };
    },
    async save(state) {
      if (!firestore) return;
      await setDoc(doc(firestore, CLOUD_COLLECTION, projectId, 'histories', userId), {
        entries: state.entries.slice(-50),
        cursor: state.cursor,
        updatedAt: Date.now(),
      });
    },
    async apply(direction, entry) {
      return applyCloudHistory(projectId, direction, entry);
    },
  };
}

async function createCloudProject(source?: CanonicalProject, name?: string) {
  if (!firestore) throw new Error('Configure Firebase first.');
  const id = randomId('project');
  const now = Date.now();
  const project = cloneValue(source ?? createBlankProject(activeProject));
  const cloud: CloudProjectDocument = {
    name: name ?? `Skill Tree ${cloudProjects.length + 1}`,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    project,
    fieldWriters: {},
    entityWriters: {},
  };
  await setDoc(doc(firestore, CLOUD_COLLECTION, id), cloud);
  await refreshCloudProjects();
  await switchOnlineProject(id);
}

async function deleteCloudProject(id: string) {
  if (!firestore) return;
  const meta = cloudProjects.find((item) => item.id === id);
  if (!meta || !window.confirm(`Delete shared project “${meta.name}”? This affects every collaborator.`)) return;
  await deleteDoc(doc(firestore, CLOUD_COLLECTION, id));
  cloudProjects = cloudProjects.filter((item) => item.id !== id);
  if (settings.selectedOnlineProjectId === id) {
    const next = cloudProjects[0];
    if (next) await switchOnlineProject(next.id);
    else await switchLocalProject(selectedLocalMeta()!.id);
  }
  renderProjectUi();
}

async function renameCloudProject(id: string) {
  if (!firestore) return;
  const meta = cloudProjects.find((item) => item.id === id);
  if (!meta) return;
  const name = window.prompt('Project name', meta.name)?.trim();
  if (!name) return;
  await runTransaction(firestore, async (transaction) => {
    const ref = doc(firestore!, CLOUD_COLLECTION, id);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) throw new Error('Project no longer exists.');
    transaction.update(ref, { name, updatedAt: Date.now() });
  });
  await refreshCloudProjects();
}

function stopCloudSubscription() {
  cloudUnsubscribe?.();
  cloudUnsubscribe = null;
  cloudBaseProject = null;
  cloudBaseDocument = null;
}

async function switchOnlineProject(id: string) {
  if (!firestore) return;
  const snapshot = await getDoc(doc(firestore, CLOUD_COLLECTION, id));
  if (!snapshot.exists()) return;
  const cloud = parseCloudDocument(snapshot.data());
  if (!cloud) throw new Error('Cloud project is invalid.');
  stopCloudSubscription();
  mode = 'online';
  settings = { ...settings, mode: 'online', selectedOnlineProjectId: id };
  writeSettings();
  activeProjectId = id;
  cloudBaseProject = cloneValue(cloud.project);
  cloudBaseDocument = cloneValue(cloud);
  connectionStatus = 'Online';
  await applyWorkingProject(cloud.project, `online:${id}:${userId}`, onlineHistoryController(id));

  cloudUnsubscribe = onSnapshot(doc(firestore, CLOUD_COLLECTION, id), (nextSnapshot) => {
    if (!nextSnapshot.exists()) return;
    const nextCloud = parseCloudDocument(nextSnapshot.data());
    if (!nextCloud) return;
    connectionStatus = 'Online';
    cloudBaseProject = cloneValue(nextCloud.project);
    cloudBaseDocument = cloneValue(nextCloud);
    if (cloudWriteInFlight) {
      renderProjectUi();
      return;
    }
    const working = readWorkingProject();
    if (sameValue(working, nextCloud.project)) {
      activeProject = cloneValue(nextCloud.project);
      renderProjectUi();
      return;
    }
    void applyRemoteSnapshot(nextCloud.project);
  }, () => {
    connectionStatus = 'Disconnected';
    renderProjectUi();
  });
  renderProjectUi();
}

async function applyRemoteSnapshot(project: CanonicalProject) {
  if (applyingExternalProject) return;
  const before = readWorkingProject();
  applyingExternalProject = true;
  setHistoryExternalRecording(true);
  try {
    localStorage.setItem(WORKING_PROJECT_KEY, JSON.stringify(project));
    activeProject = cloneValue(project);
    dispatchProjectChange(before, project);
  } finally {
    setHistoryExternalRecording(false);
    applyingExternalProject = false;
  }
}

function currentSideMatches(project: CanonicalProject, change: AtomicHistoryChange, expected: CanonicalProject) {
  const current = readAtKey(project, change.key);
  const base = readAtKey(expected, change.key);
  return current.exists === base.exists && (!base.exists || sameValue(current.value, base.value));
}

async function commitCloudEdit(requestedProject: CanonicalProject) {
  if (!firestore || !cloudBaseProject || mode !== 'online' || !activeProjectId || cloudWriteInFlight) return;
  const base = cloneValue(cloudBaseProject);
  const requestedChanges = diffProjects(base, requestedProject);
  if (requestedChanges.length === 0) return;
  const mutationId = randomId(`mutation-${userId.slice(0, 8)}`);
  cloudWriteInFlight = true;
  connectionStatus = 'Saving…';
  renderProjectUi();

  try {
    let committedBefore: CanonicalProject | null = null;
    let committedAfter: CanonicalProject | null = null;
    await runTransaction(firestore, async (transaction) => {
      const ref = doc(firestore!, CLOUD_COLLECTION, activeProjectId);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) throw new Error('The shared project was deleted.');
      const cloud = parseCloudDocument(snapshot.data());
      if (!cloud) throw new Error('The shared project is invalid.');

      for (const change of requestedChanges) {
        if (!currentSideMatches(cloud.project, change, base)) {
          throw new Error('A collaborator changed the same part of the project. Your edit was not applied.');
        }
      }

      let next: unknown = cloud.project;
      requestedChanges.forEach((change) => {
        next = applyAtKey(next, change.key, change.newExists, change.newValue, change.newIndex);
      });
      const nextProject = next as CanonicalProject;
      const graphIssue = validateProjectGraph(nextProject);
      if (graphIssue) throw new Error(graphIssue);

      const fieldWriters = { ...cloud.fieldWriters };
      requestedChanges.forEach((change) => { fieldWriters[projectPath(change)] = mutationId; });
      const entityWriters = { ...cloud.entityWriters };
      touchedEntityKeys(cloud.project, nextProject, requestedChanges).forEach((key) => { entityWriters[key] = mutationId; });
      committedBefore = cloneValue(cloud.project);
      committedAfter = cloneValue(nextProject);
      transaction.set(ref, {
        ...cloud,
        project: nextProject,
        revision: cloud.revision + 1,
        updatedAt: Date.now(),
        fieldWriters,
        entityWriters,
      });
    });

    if (committedBefore && committedAfter) {
      cloudBaseProject = cloneValue(committedAfter);
      activeProject = cloneValue(committedAfter);
      recordCommittedHistory(committedBefore, committedAfter, mutationId);
      connectionStatus = 'Online';
    }
  } catch (error) {
    connectionStatus = 'Conflict';
    window.alert(error instanceof Error ? error.message : 'The cloud edit could not be saved.');
    if (cloudBaseProject) await applyRemoteSnapshot(cloudBaseProject);
  } finally {
    cloudWriteInFlight = false;
    renderProjectUi();
  }
}

function entityGuardMatches(cloud: CloudProjectDocument, entry: HistoryEntry) {
  if (!entry.mutationId) return true;
  return guardEntityKeys(entry.changes).every((key) => cloud.entityWriters[key] === entry.mutationId);
}

async function applyCloudHistory(projectId: string, direction: HistoryDirection, entry: HistoryEntry) {
  if (!firestore || !entry.mutationId) return { ok: false, reason: 'This history entry predates collaborative mutation tracking.' };
  const inverseMutationId = randomId(`${direction}-${userId.slice(0, 8)}`);
  try {
    let resultProject: CanonicalProject | null = null;
    await runTransaction(firestore, async (transaction) => {
      const ref = doc(firestore!, CLOUD_COLLECTION, projectId);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) throw new Error('The shared project was deleted.');
      const cloud = parseCloudDocument(snapshot.data());
      if (!cloud) throw new Error('The shared project is invalid.');

      if (!entry.changes.every((change) => valueMatchesSide(cloud.project, change, direction))) {
        throw new Error('Another collaborator changed a field affected by this action.');
      }
      if (direction === 'undo' && !entityGuardMatches(cloud, entry)) {
        throw new Error('An entity created or removed by this action was modified by another collaborator.');
      }

      let next: unknown = cloud.project;
      const ordered = direction === 'undo' ? [...entry.changes].reverse() : entry.changes;
      ordered.forEach((change) => {
        const side = sideForDirection(change, direction);
        next = applyAtKey(next, change.key, side.exists, side.value, side.index);
      });
      const nextProject = next as CanonicalProject;
      const graphIssue = validateProjectGraph(nextProject);
      if (graphIssue) throw new Error(graphIssue);

      const fieldWriters = { ...cloud.fieldWriters };
      entry.changes.forEach((change) => { fieldWriters[projectPath(change)] = inverseMutationId; });
      const entityWriters = { ...cloud.entityWriters };
      touchedEntityKeys(cloud.project, nextProject, entry.changes).forEach((key) => { entityWriters[key] = inverseMutationId; });
      transaction.set(ref, {
        ...cloud,
        project: nextProject,
        revision: cloud.revision + 1,
        updatedAt: Date.now(),
        fieldWriters,
        entityWriters,
      });
      resultProject = cloneValue(nextProject);
    });
    if (!resultProject) return { ok: false, reason: 'The history transaction did not produce a project.' };
    cloudBaseProject = cloneValue(resultProject);
    activeProject = cloneValue(resultProject);
    return { ok: true, project: resultProject, mutationId: inverseMutationId };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'The shared project changed.' };
  }
}

async function copyCurrentToOtherMode() {
  if (mode === 'local') {
    if (!firestore) {
      window.alert('Configure Firebase before copying a project online.');
      return;
    }
    const meta = selectedLocalMeta();
    await createCloudProject(readWorkingProject(), meta ? `${meta.name} (Cloud)` : undefined);
  } else {
    const meta = cloudProjects.find((item) => item.id === activeProjectId);
    await createLocalProject(readWorkingProject(), meta ? `${meta.name} (Local)` : undefined);
  }
}

async function handleProjectSave(rawProject: string) {
  if (applyingExternalProject) return;
  const project = normalizeProject(rawProject);
  if (!project) return;
  activeProject = cloneValue(project);
  if (mode === 'local') {
    if (activeProjectId) saveLocalProject(activeProjectId, project);
    renderProjectUi();
    return;
  }
  await commitCloudEdit(project);
}

window.addEventListener(PROJECT_SAVED_EVENT, (event) => {
  const rawProject = (event as CustomEvent<{ rawProject?: string }>).detail?.rawProject;
  if (typeof rawProject === 'string') void handleProjectSave(rawProject);
});

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]!);
}

function projectButton(meta: ProjectMeta, selected: boolean) {
  return `<div class="project-manager-row${selected ? ' is-selected' : ''}" data-project-id="${escapeHtml(meta.id)}">
    <button type="button" class="project-manager-select"><strong>${escapeHtml(meta.name)}</strong><small>${new Date(meta.updatedAt).toLocaleDateString()}</small></button>
    <button type="button" class="project-manager-icon" data-project-action="rename" title="Rename">✎</button>
    <button type="button" class="project-manager-icon danger" data-project-action="delete" title="Delete">×</button>
  </div>`;
}

function renderProjectUi() {
  const panel = document.querySelector<HTMLElement>('.project-manager-panel');
  const trigger = document.querySelector<HTMLElement>('.project-manager-button');
  if (trigger) {
    const activeMeta = mode === 'local'
      ? localProjects.find((item) => item.id === activeProjectId)
      : cloudProjects.find((item) => item.id === activeProjectId);
    trigger.querySelector('.project-manager-button-label')!.textContent = activeMeta?.name ?? 'Projects';
    const status = trigger.querySelector('.project-manager-status')!;
    status.textContent = mode === 'local' ? 'Local' : connectionStatus;
  }
  if (!panel) return;
  panel.hidden = !projectPanelOpen;
  const list = mode === 'local' ? localProjects : cloudProjects;
  const configText = settings.firebaseConfig ? JSON.stringify(settings.firebaseConfig, null, 2) : '';
  panel.innerHTML = `
    <div class="project-manager-head"><div><strong>Projects</strong><small>User ${escapeHtml(userId.slice(0, 8))}</small></div><button type="button" data-project-action="close">×</button></div>
    <div class="project-manager-tabs">
      <button type="button" data-project-mode="local" class="${mode === 'local' ? 'active' : ''}">Local</button>
      <button type="button" data-project-mode="online" class="${mode === 'online' ? 'active' : ''}">Online</button>
    </div>
    ${mode === 'online' && !firestore ? `<div class="project-manager-config"><strong>Firebase configuration</strong><small>Trusted collaborators can use the same Firestore-enabled config.</small><textarea spellcheck="false" placeholder='{"apiKey":"...","projectId":"..."}'>${escapeHtml(configText)}</textarea><button type="button" data-project-action="connect">Connect Firebase</button></div>` : ''}
    ${mode === 'online' && firestore ? `<div class="project-manager-connection"><span>${escapeHtml(connectionStatus)}</span><button type="button" data-project-action="configure">Change Firebase</button></div>` : ''}
    <div class="project-manager-list">${list.length ? list.map((item) => projectButton(item, item.id === activeProjectId)).join('') : `<div class="project-manager-empty">${mode === 'online' && !firestore ? 'Connect Firebase to view cloud projects.' : 'No projects yet.'}</div>`}</div>
    <div class="project-manager-actions">
      <button type="button" data-project-action="new" ${mode === 'online' && !firestore ? 'disabled' : ''}>New</button>
      <button type="button" data-project-action="duplicate" ${!activeProjectId || (mode === 'online' && !firestore) ? 'disabled' : ''}>Duplicate</button>
      <button type="button" data-project-action="copy" ${!activeProjectId ? 'disabled' : ''}>${mode === 'local' ? 'Copy Online' : 'Copy Local'}</button>
    </div>
  `;
}

function installProjectUi() {
  if (uiInstalled) return true;
  const actions = document.querySelector<HTMLElement>('.top-actions');
  if (!actions) return false;
  uiInstalled = true;
  const style = document.createElement('style');
  style.textContent = `
    .project-manager-control { position: relative; display: inline-flex; }
    .project-manager-button { max-width: 190px; display: inline-grid!important; grid-template-columns: 1fr auto; grid-template-rows: auto auto; column-gap: 8px; text-align: left; }
    .project-manager-button-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .project-manager-status { grid-column: 1 / -1; font-size: 8px; opacity: .55; }
    .project-manager-panel { position: absolute; top: calc(100% + 9px); right: 0; width: min(390px, calc(100vw - 24px)); max-height: min(650px, calc(100vh - 90px)); overflow: auto; border: 1px solid rgba(255,255,255,.12); border-radius: 12px; background: rgba(14,17,23,.98); box-shadow: 0 20px 60px rgba(0,0,0,.45); color: #dfe4e9; z-index: 110; }
    .project-manager-panel[hidden] { display:none; }
    .project-manager-head, .project-manager-connection, .project-manager-actions { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.08); }
    .project-manager-head > div { display:grid; gap:2px; } .project-manager-head small,.project-manager-config small,.project-manager-select small { font-size:9px; color:#707987; }
    .project-manager-head button,.project-manager-icon { border:0; background:transparent; color:#89919d; }
    .project-manager-tabs { display:grid; grid-template-columns:1fr 1fr; gap:5px; padding:8px; }
    .project-manager-tabs button,.project-manager-actions button,.project-manager-config button,.project-manager-connection button { border:1px solid rgba(255,255,255,.1); border-radius:8px; background:#151a22; color:#abb3be; padding:8px 10px; }
    .project-manager-tabs button.active { color:#dfffb4; border-color:rgba(182,255,86,.28); background:rgba(182,255,86,.07); }
    .project-manager-config { display:grid; gap:7px; padding:10px 12px; border-top:1px solid rgba(255,255,255,.07); border-bottom:1px solid rgba(255,255,255,.07); }
    .project-manager-config textarea { min-height:130px; resize:vertical; border:1px solid rgba(255,255,255,.11); border-radius:8px; background:#0c1016; color:#cbd2db; padding:9px; font:10px/1.45 monospace; }
    .project-manager-list { display:grid; gap:3px; padding:6px; max-height:315px; overflow:auto; }
    .project-manager-row { display:grid; grid-template-columns:1fr 30px 30px; align-items:center; border-radius:8px; }
    .project-manager-row.is-selected { background:rgba(182,255,86,.055); }
    .project-manager-select { min-width:0; display:grid; gap:2px; padding:8px 9px; border:0; background:transparent; color:#cfd5dd; text-align:left; }
    .project-manager-select strong { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:10px; }
    .project-manager-icon.danger:hover { color:#ff7769; }
    .project-manager-empty { padding:24px 12px; text-align:center; color:#69727f; font-size:10px; }
    .project-manager-actions { border-top:1px solid rgba(255,255,255,.08); border-bottom:0; justify-content:flex-start; flex-wrap:wrap; }
    .project-manager-actions button:disabled { opacity:.35; }
  `;
  document.head.appendChild(style);

  const control = document.createElement('div');
  control.className = 'project-manager-control';
  control.innerHTML = `<button type="button" class="ghost project-manager-button"><span class="project-manager-button-label">Projects</span><span>▾</span><small class="project-manager-status">Local</small></button><div class="project-manager-panel" hidden></div>`;
  actions.insertBefore(control, actions.firstChild);
  control.querySelector('.project-manager-button')?.addEventListener('click', (event) => {
    event.stopPropagation();
    projectPanelOpen = !projectPanelOpen;
    renderProjectUi();
  });
  control.querySelector('.project-manager-panel')?.addEventListener('click', async (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const modeButton = target.closest<HTMLElement>('[data-project-mode]');
    if (modeButton) {
      const nextMode = modeButton.dataset.projectMode as StorageMode;
      if (nextMode === 'local') {
        const meta = selectedLocalMeta();
        if (meta) await switchLocalProject(meta.id);
      } else if (!firestore) {
        mode = 'online';
        renderProjectUi();
      } else if (cloudProjects.length) {
        await switchOnlineProject(settings.selectedOnlineProjectId && cloudProjects.some((item) => item.id === settings.selectedOnlineProjectId)
          ? settings.selectedOnlineProjectId
          : cloudProjects[0].id);
      } else {
        mode = 'online';
        renderProjectUi();
      }
      return;
    }

    const row = target.closest<HTMLElement>('[data-project-id]');
    const action = target.closest<HTMLElement>('[data-project-action]')?.dataset.projectAction;
    const id = row?.dataset.projectId;
    try {
      if (!action && row && target.closest('.project-manager-select')) {
        if (mode === 'local') await switchLocalProject(id!); else await switchOnlineProject(id!);
      } else if (action === 'close') {
        projectPanelOpen = false;
        renderProjectUi();
      } else if (action === 'rename' && id) {
        if (mode === 'local') renameLocalProject(id); else await renameCloudProject(id);
      } else if (action === 'delete' && id) {
        if (mode === 'local') await deleteLocalProject(id); else await deleteCloudProject(id);
      } else if (action === 'new') {
        if (mode === 'local') await createLocalProject(); else await createCloudProject();
      } else if (action === 'duplicate') {
        const name = mode === 'local'
          ? localProjects.find((item) => item.id === activeProjectId)?.name
          : cloudProjects.find((item) => item.id === activeProjectId)?.name;
        if (mode === 'local') await createLocalProject(readWorkingProject(), `${name ?? 'Skill Tree'} Copy`);
        else await createCloudProject(readWorkingProject(), `${name ?? 'Skill Tree'} Copy`);
      } else if (action === 'copy') {
        await copyCurrentToOtherMode();
      } else if (action === 'connect') {
        const textarea = control.querySelector<HTMLTextAreaElement>('.project-manager-config textarea');
        if (!textarea) return;
        const config = JSON.parse(textarea.value) as FirebaseOptions;
        if (!config.projectId || !config.apiKey) throw new Error('The Firebase config needs at least apiKey and projectId.');
        await configureFirebase(config);
        mode = 'online';
        if (cloudProjects.length) await switchOnlineProject(cloudProjects[0].id);
      } else if (action === 'configure') {
        stopCloudSubscription();
        if (firebaseApp) await deleteApp(firebaseApp);
        firebaseApp = null;
        firestore = null;
        mode = 'online';
        connectionStatus = 'Not connected';
        renderProjectUi();
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Project operation failed.');
    }
  });
  document.addEventListener('click', () => {
    if (!projectPanelOpen) return;
    projectPanelOpen = false;
    renderProjectUi();
  });
  renderProjectUi();
  return true;
}

async function initializeRuntime() {
  ensureLocalMigration();
  const localMeta = selectedLocalMeta()!;
  settings = { ...settings, selectedLocalProjectId: localMeta.id };
  activeProjectId = localMeta.id;
  const localProject = readLocalProject(localMeta.id) ?? readWorkingProject();
  saveLocalProject(localMeta.id, localProject);
  await applyWorkingProject(localProject, `local:${localMeta.id}`, null);

  if (settings.firebaseConfig) {
    try {
      await configureFirebase(settings.firebaseConfig);
      if (settings.mode === 'online' && cloudProjects.length) {
        const selectedId = settings.selectedOnlineProjectId && cloudProjects.some((item) => item.id === settings.selectedOnlineProjectId)
          ? settings.selectedOnlineProjectId
          : cloudProjects[0].id;
        await switchOnlineProject(selectedId);
      }
    } catch {
      connectionStatus = 'Firebase unavailable';
      mode = 'local';
    }
  }
  renderProjectUi();
}

if (!installProjectUi()) {
  const observer = new MutationObserver(() => {
    if (installProjectUi()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

void initializeRuntime();
