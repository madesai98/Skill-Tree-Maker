import {
  FirestoreProjectStore,
  newerCloudDocument,
  type CloudCommitResult,
  type CloudProjectDocument,
  type FirebaseOptions,
  type ProjectMeta,
} from './cloudStore';
import { rebaseQueuedProject } from './collaboration';
import { parseFirebaseConfigInput } from './firebaseConfig';
import {
  HISTORY_APPLY_EVENT,
  flushHistoryWrites,
  getHistoryProject,
  PROJECT_SAVED_EVENT,
  recordCommittedHistory,
  setHistoryExternalRecording,
  setHistoryScope,
  type HistoryEntry,
  type OnlineHistoryController,
} from './history';
import { LocalProjectStore, readWorkingProject } from './localProjectStore';
import {
  cloneValue,
  createBlankProject,
  diffProjects,
  normalizeProject,
  sameValue,
  type CanonicalProject,
  type HistoryDirection,
} from './projectData';
import './projectRuntime.css';

const WORKING_PROJECT_KEY = 'incremental-td-skill-tree:v2';
const USER_ID_KEY = 'skill-tree:user-id';
const SETTINGS_KEY = 'skill-tree:project-settings:v1';

type StorageMode = 'local' | 'online';

type RuntimeSettings = {
  mode: StorageMode;
  selectedLocalProjectId: string | null;
  selectedOnlineProjectId: string | null;
  firebaseConfig: FirebaseOptions | null;
};

const localStore = new LocalProjectStore();
const cloudStore = new FirestoreProjectStore();
const userId = getOrCreateUserId();
let settings = readSettings();
let mode: StorageMode = settings.mode;
let localProjects: ProjectMeta[] = localStore.listProjects();
let cloudProjects: ProjectMeta[] = [];
let activeProjectId = '';
let activeProject = readWorkingProject();
let cloudBaseDocument: CloudProjectDocument | null = null;
let cloudUnsubscribe: (() => void) | null = null;
let applyingExternalProject = false;
let cloudWriteInFlight = false;
let pendingCloudTarget: CanonicalProject | null = null;
let pendingRemoteCloud: CloudProjectDocument | null = null;
let cloudWriteIdleResolvers: Array<() => void> = [];
let projectPanelOpen = false;
let connectionStatus = settings.mode === 'online'
  ? (settings.firebaseConfig ? 'Connecting…' : 'Not connected')
  : 'Local';
let uiInstalled = false;

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
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '') as Partial<RuntimeSettings>;
    return {
      mode: value.mode === 'online' ? 'online' : 'local',
      selectedLocalProjectId: typeof value.selectedLocalProjectId === 'string' ? value.selectedLocalProjectId : null,
      selectedOnlineProjectId: typeof value.selectedOnlineProjectId === 'string' ? value.selectedOnlineProjectId : null,
      firebaseConfig: value.firebaseConfig && typeof value.firebaseConfig === 'object' ? value.firebaseConfig : null,
    };
  } catch {
    return { mode: 'local', selectedLocalProjectId: null, selectedOnlineProjectId: null, firebaseConfig: null };
  }
}

function writeSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function refreshLocalProjects() {
  localProjects = localStore.listProjects();
}

async function refreshCloudProjects() {
  cloudProjects = cloudStore.connected ? await cloudStore.listProjects() : [];
  renderProjectUi();
}

function selectedLocalMeta() {
  return localProjects.find((item) => item.id === settings.selectedLocalProjectId) ?? localProjects[0] ?? null;
}

function selectedCloudMeta() {
  return cloudProjects.find((item) => item.id === settings.selectedOnlineProjectId) ?? cloudProjects[0] ?? null;
}

function dispatchProjectChange(before: CanonicalProject, after: CanonicalProject) {
  const changes = diffProjects(before, after);
  if (!changes.length) return;
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

async function applyRemoteSnapshot(project: CanonicalProject) {
  if (applyingExternalProject) return;
  const before = readWorkingProject();
  if (sameValue(before, project)) {
    activeProject = cloneValue(project);
    return;
  }
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

function stopCloudSubscription() {
  cloudUnsubscribe?.();
  cloudUnsubscribe = null;
  cloudBaseDocument = null;
  pendingRemoteCloud = null;
  pendingCloudTarget = null;
}

function waitForCloudWrites() {
  if (!cloudWriteInFlight) return Promise.resolve();
  return new Promise<void>((resolve) => cloudWriteIdleResolvers.push(resolve));
}

function notifyCloudWriteIdle() {
  const resolvers = cloudWriteIdleResolvers;
  cloudWriteIdleResolvers = [];
  resolvers.forEach((resolve) => resolve());
}

function isCloudBusy() {
  return cloudWriteInFlight || Boolean(pendingCloudTarget);
}

async function switchLocalProject(id: string) {
  if (isCloudBusy()) throw new Error('Wait for the current cloud save to finish before switching projects.');
  const project = localStore.getProject(id);
  if (!project) throw new Error('That local project no longer exists.');
  stopCloudSubscription();
  mode = 'local';
  activeProjectId = id;
  connectionStatus = 'Local';
  settings = { ...settings, mode: 'local', selectedLocalProjectId: id };
  writeSettings();
  await applyWorkingProject(project, `local:${id}`, null);
  renderProjectUi();
}

async function createLocalProject(source?: CanonicalProject, name?: string) {
  const created = localStore.createProject(source, name);
  refreshLocalProjects();
  await switchLocalProject(created.meta.id);
}

async function deleteLocalProject(id: string) {
  if (isCloudBusy()) throw new Error('Wait for the current cloud save to finish before managing projects.');
  const meta = localProjects.find((item) => item.id === id);
  if (!meta || !window.confirm(`Delete local project “${meta.name}”?`)) return;
  localStore.deleteProject(id);
  refreshLocalProjects();
  if (activeProjectId === id && mode === 'local') await switchLocalProject(localProjects[0].id);
  else renderProjectUi();
}

function renameLocalProject(id: string) {
  const meta = localProjects.find((item) => item.id === id);
  if (!meta) return;
  const name = window.prompt('Project name', meta.name)?.trim();
  if (!name) return;
  localStore.renameProject(id, name);
  refreshLocalProjects();
  renderProjectUi();
}

async function configureFirebase(config: FirebaseOptions) {
  if (isCloudBusy()) throw new Error('Wait for the current cloud save to finish before changing Firebase.');
  stopCloudSubscription();
  connectionStatus = 'Connecting…';
  renderProjectUi();
  await cloudStore.connect(config);
  settings = { ...settings, firebaseConfig: cloneValue(config) };
  writeSettings();
  connectionStatus = 'Cloud ready';
  await refreshCloudProjects();
}

function onlineHistoryController(projectId: string): OnlineHistoryController {
  return {
    load: () => cloudStore.loadHistory(projectId, userId),
    save: (state) => cloudStore.saveHistory(projectId, userId, state),
    async apply(direction, entry) {
      await waitForCloudWrites();
      if (mode !== 'online' || activeProjectId !== projectId) {
        return { ok: false, reason: 'The active cloud project changed.' };
      }
      cloudWriteInFlight = true;
      connectionStatus = 'Saving…';
      renderProjectUi();
      try {
        const result = await cloudStore.applyHistory(projectId, userId, direction, entry);
        if (!result.ok || !result.project || !result.cloud) return result;
        const newest = newerCloudDocument(result.cloud, pendingRemoteCloud ?? result.cloud);
        pendingRemoteCloud = null;
        cloudBaseDocument = newest;
        activeProject = cloneValue(newest.project);
        return { ...result, project: cloneValue(newest.project) };
      } finally {
        cloudWriteInFlight = false;
        connectionStatus = 'Online';
        notifyCloudWriteIdle();
        renderProjectUi();
      }
    },
  };
}

async function switchOnlineProject(id: string) {
  if (isCloudBusy()) throw new Error('Wait for the current cloud save to finish before switching projects.');
  const cloud = await cloudStore.getProject(id);
  if (!cloud) throw new Error('That cloud project no longer exists.');
  stopCloudSubscription();
  mode = 'online';
  activeProjectId = id;
  cloudBaseDocument = cloneValue(cloud);
  connectionStatus = 'Online';
  settings = { ...settings, mode: 'online', selectedOnlineProjectId: id };
  writeSettings();
  await applyWorkingProject(cloud.project, `online:${id}:${userId}`, onlineHistoryController(id));

  cloudUnsubscribe = cloudStore.subscribe(id, (nextCloud) => {
    if (mode !== 'online' || activeProjectId !== id) return;
    const working = readWorkingProject();
    const editorProject = getHistoryProject();
    const hasUnsavedEditorState = Boolean(editorProject && !sameValue(editorProject, working));
    if (cloudWriteInFlight || hasUnsavedEditorState) {
      pendingRemoteCloud = newerCloudDocument(pendingRemoteCloud, nextCloud);
    } else {
      cloudBaseDocument = newerCloudDocument(cloudBaseDocument, nextCloud);
      if (!sameValue(working, nextCloud.project)) void applyRemoteSnapshot(nextCloud.project);
      else activeProject = cloneValue(nextCloud.project);
      connectionStatus = 'Online';
    }
    renderProjectUi();
  }, () => {
    connectionStatus = 'Disconnected';
    renderProjectUi();
  });
  renderProjectUi();
}

async function createCloudProject(source?: CanonicalProject, name?: string) {
  if (!cloudStore.connected) throw new Error('Configure Firebase first.');
  const project = cloneValue(source ?? createBlankProject(activeProject));
  const created = await cloudStore.createProject(project, name ?? `Skill Tree ${cloudProjects.length + 1}`);
  await refreshCloudProjects();
  await switchOnlineProject(created.id);
}

async function ensureOnlineProject(source: CanonicalProject = readWorkingProject()) {
  if (!cloudStore.connected) throw new Error('Configure Firebase first.');
  const selected = selectedCloudMeta();
  if (selected) {
    await switchOnlineProject(selected.id);
    return;
  }
  await createCloudProject(source, selectedLocalMeta()?.name);
}

async function deleteCloudProject(id: string) {
  if (isCloudBusy()) throw new Error('Wait for the current cloud save to finish before managing projects.');
  const meta = cloudProjects.find((item) => item.id === id);
  if (!meta || !window.confirm(`Delete shared project “${meta.name}”? This affects every collaborator.`)) return;
  const deletingActive = mode === 'online' && activeProjectId === id;
  if (deletingActive) stopCloudSubscription();
  await cloudStore.deleteProject(id);
  await refreshCloudProjects();
  if (!deletingActive) return;
  const next = selectedCloudMeta();
  if (next) await switchOnlineProject(next.id);
  else {
    const local = selectedLocalMeta();
    if (local) await switchLocalProject(local.id);
  }
}

async function renameCloudProject(id: string) {
  if (isCloudBusy()) throw new Error('Wait for the current cloud save to finish before managing projects.');
  const meta = cloudProjects.find((item) => item.id === id);
  if (!meta) return;
  const name = window.prompt('Project name', meta.name)?.trim();
  if (!name) return;
  await cloudStore.renameProject(id, name);
  await refreshCloudProjects();
}

async function reconcileAfterCloudFailure(projectId: string) {
  try {
    const current = await cloudStore.getProject(projectId);
    if (current) cloudBaseDocument = newerCloudDocument(cloudBaseDocument, current);
  } catch {
    // Keep the newest subscribed state if a recovery read also fails.
  }
  if (pendingRemoteCloud) {
    cloudBaseDocument = newerCloudDocument(cloudBaseDocument, pendingRemoteCloud);
    pendingRemoteCloud = null;
  }
  if (cloudBaseDocument) await applyRemoteSnapshot(cloudBaseDocument.project);
}

async function drainCloudEdits() {
  if (cloudWriteInFlight || !pendingCloudTarget || !cloudStore.connected || !cloudBaseDocument || mode !== 'online' || !activeProjectId) return;
  const projectId = activeProjectId;
  cloudWriteInFlight = true;
  connectionStatus = 'Saving…';
  renderProjectUi();

  try {
    while (pendingCloudTarget && mode === 'online' && activeProjectId === projectId) {
      const submitted = pendingCloudTarget;
      pendingCloudTarget = null;
      const base = cloneValue(cloudBaseDocument);
      const committed = await cloudStore.commitProject(projectId, base, submitted, userId);

      if (!committed) continue;
      cloudBaseDocument = newerCloudDocument(committed.cloud, pendingRemoteCloud ?? committed.cloud);
      pendingRemoteCloud = null;
      activeProject = cloneValue(committed.after);
      recordCommittedHistory(committed.before, committed.after, committed.history);
      await flushHistoryWrites();

      if (pendingCloudTarget) {
        const latestLocal = pendingCloudTarget;
        pendingCloudTarget = null;
        const rebased = rebaseQueuedProject(cloudBaseDocument, base, submitted, latestLocal, committed, userId);
        if (!rebased.ok) throw new Error(rebased.reason);
        if (rebased.changes.length) {
          pendingCloudTarget = rebased.project;
          await applyRemoteSnapshot(rebased.project);
        }
      }
    }

    if (pendingRemoteCloud) {
      cloudBaseDocument = newerCloudDocument(cloudBaseDocument, pendingRemoteCloud);
      pendingRemoteCloud = null;
    }
    if (cloudBaseDocument) await applyRemoteSnapshot(cloudBaseDocument.project);
    connectionStatus = 'Online';
  } catch (error) {
    pendingCloudTarget = null;
    connectionStatus = 'Conflict';
    await reconcileAfterCloudFailure(projectId);
    window.alert(error instanceof Error ? error.message : 'The cloud edit could not be saved.');
  } finally {
    cloudWriteInFlight = false;
    notifyCloudWriteIdle();
    renderProjectUi();
    if (pendingCloudTarget && mode === 'online' && activeProjectId === projectId) void drainCloudEdits();
  }
}

function commitCloudEdit(project: CanonicalProject) {
  if (!cloudStore.connected || !cloudBaseDocument || mode !== 'online' || !activeProjectId) return;
  pendingCloudTarget = cloneValue(project);
  if (!cloudWriteInFlight) void drainCloudEdits();
}

async function handleProjectSave(rawProject: string) {
  if (applyingExternalProject) return;
  const normalized = normalizeProject(rawProject);
  if (!normalized) return;
  activeProject = cloneValue(normalized);
  if (mode === 'local') {
    if (activeProjectId) {
      localStore.saveProject(activeProjectId, normalized);
      refreshLocalProjects();
    }
    renderProjectUi();
    return;
  }
  commitCloudEdit(normalized);
}

window.addEventListener(PROJECT_SAVED_EVENT, (event) => {
  const rawProject = (event as CustomEvent<{ rawProject?: string }>).detail?.rawProject;
  if (typeof rawProject === 'string') void handleProjectSave(rawProject);
});

async function copyCurrentToOtherMode() {
  if (isCloudBusy()) throw new Error('Wait for the current cloud save to finish before copying projects.');
  if (mode === 'local') {
    if (!cloudStore.connected) throw new Error('Configure Firebase before copying a project online.');
    const meta = selectedLocalMeta();
    await createCloudProject(readWorkingProject(), meta ? `${meta.name} (Cloud)` : undefined);
  } else {
    const meta = cloudProjects.find((item) => item.id === activeProjectId);
    await createLocalProject(readWorkingProject(), meta ? `${meta.name} (Local)` : undefined);
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);
}

function projectButton(meta: ProjectMeta, selected: boolean) {
  return `<div class="project-manager-row${selected ? ' is-selected' : ''}" data-project-id="${escapeHtml(meta.id)}"><button type="button" class="project-manager-select"><strong>${escapeHtml(meta.name)}</strong><small>${new Date(meta.updatedAt).toLocaleDateString()}</small></button><button type="button" class="project-manager-icon" data-project-action="rename" title="Rename">✎</button><button type="button" class="project-manager-icon danger" data-project-action="delete" title="Delete">×</button></div>`;
}

function renderProjectUi() {
  document.body.classList.toggle('cloud-disconnected', mode === 'online' && (!cloudStore.connected || connectionStatus === 'Disconnected' || !activeProjectId));
  document.body.classList.toggle('cloud-saving', cloudWriteInFlight);
  const panel = document.querySelector<HTMLElement>('.project-manager-panel');
  const trigger = document.querySelector<HTMLElement>('.project-manager-button');
  if (trigger) {
    const activeMeta = mode === 'local'
      ? localProjects.find((item) => item.id === activeProjectId)
      : cloudProjects.find((item) => item.id === activeProjectId);
    trigger.querySelector<HTMLElement>('.project-manager-button-label')!.textContent = activeMeta?.name ?? 'Projects';
    trigger.querySelector<HTMLElement>('.project-manager-status')!.textContent = mode === 'local' ? 'Local' : connectionStatus;
  }
  if (!panel) return;
  panel.hidden = !projectPanelOpen;
  const list = mode === 'local' ? localProjects : cloudProjects;
  const configText = settings.firebaseConfig ? JSON.stringify(settings.firebaseConfig, null, 2) : '';
  panel.innerHTML = `
    <div class="project-manager-head"><div><strong>Projects</strong><small>User ${escapeHtml(userId.slice(0, 8))}</small></div><button type="button" data-project-action="close">×</button></div>
    <div class="project-manager-tabs"><button type="button" data-project-mode="local" class="${mode === 'local' ? 'active' : ''}">Local</button><button type="button" data-project-mode="online" class="${mode === 'online' ? 'active' : ''}">Online</button></div>
    ${cloudWriteInFlight ? '<div class="project-manager-busy">Saving the current cloud edits…</div>' : ''}
    ${mode === 'online' && !cloudStore.connected ? `<div class="project-manager-config"><strong>Firebase configuration</strong><small>Paste the Firebase web config object or the full <code>const firebaseConfig = { ... };</code> snippet exactly as Firebase gives it to you.</small><textarea spellcheck="false" placeholder='const firebaseConfig = {\n  apiKey: "...",\n  projectId: "..."\n};'>${escapeHtml(configText)}</textarea><button type="button" data-project-action="connect">Connect Firebase</button></div>` : ''}
    ${mode === 'online' && cloudStore.connected ? `<div class="project-manager-connection"><span>${escapeHtml(connectionStatus)}</span><button type="button" data-project-action="configure">Change Firebase</button></div>` : ''}
    <div class="project-manager-list">${list.length ? list.map((item) => projectButton(item, item.id === activeProjectId)).join('') : `<div class="project-manager-empty">${mode === 'online' && !cloudStore.connected ? 'Connect Firebase to view cloud projects.' : 'No projects yet.'}</div>`}</div>
    <div class="project-manager-actions"><button type="button" data-project-action="new" ${mode === 'online' && !cloudStore.connected ? 'disabled' : ''}>New</button><button type="button" data-project-action="duplicate" ${!activeProjectId || (mode === 'online' && !cloudStore.connected) ? 'disabled' : ''}>Duplicate</button><button type="button" data-project-action="copy" ${!activeProjectId || (mode === 'local' && !cloudStore.connected) ? 'disabled' : ''}>${mode === 'local' ? 'Copy Online' : 'Copy Local'}</button></div>`;
}

function installProjectUi() {
  if (uiInstalled) return true;
  const actions = document.querySelector<HTMLElement>('.top-actions');
  if (!actions) return false;
  uiInstalled = true;
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
    try {
      if (modeButton) {
        if (isCloudBusy()) throw new Error('Wait for the current cloud save to finish before switching storage modes.');
        const nextMode = modeButton.dataset.projectMode as StorageMode;
        if (nextMode === 'local') {
          const local = selectedLocalMeta();
          if (local) await switchLocalProject(local.id);
        } else if (!cloudStore.connected) {
          stopCloudSubscription();
          mode = 'online';
          activeProjectId = '';
          connectionStatus = 'Not connected';
          settings = { ...settings, mode: 'online' };
          writeSettings();
          renderProjectUi();
        } else {
          settings = { ...settings, mode: 'online' };
          writeSettings();
          await ensureOnlineProject(readWorkingProject());
        }
        return;
      }

      const row = target.closest<HTMLElement>('[data-project-id]');
      const action = target.closest<HTMLElement>('[data-project-action]')?.dataset.projectAction;
      const id = row?.dataset.projectId;
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
        const config = parseFirebaseConfigInput(textarea.value);
        mode = 'online';
        settings = { ...settings, mode: 'online' };
        writeSettings();
        await configureFirebase(config);
        await ensureOnlineProject(readWorkingProject());
      } else if (action === 'configure') {
        if (isCloudBusy()) throw new Error('Wait for the current cloud save to finish before changing Firebase.');
        stopCloudSubscription();
        await cloudStore.disconnect();
        cloudProjects = [];
        mode = 'online';
        activeProjectId = '';
        connectionStatus = 'Not connected';
        settings = { ...settings, mode: 'online', selectedOnlineProjectId: null, firebaseConfig: null };
        writeSettings();
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
  const preferredMode = settings.mode;
  const migrated = localStore.ensureMigration();
  refreshLocalProjects();
  const local = localProjects.find((item) => item.id === settings.selectedLocalProjectId) ?? migrated ?? localProjects[0];
  if (!local) return;
  settings = { ...settings, selectedLocalProjectId: local.id };
  writeSettings();
  const localProject = localStore.getProject(local.id) ?? readWorkingProject();
  activeProjectId = local.id;
  mode = 'local';
  connectionStatus = 'Local';
  localStore.saveProject(local.id, localProject);
  refreshLocalProjects();
  await applyWorkingProject(localProject, `local:${local.id}`, null);

  if (preferredMode === 'online') {
    mode = 'online';
    activeProjectId = '';
    connectionStatus = settings.firebaseConfig ? 'Connecting…' : 'Not connected';
    renderProjectUi();
  }

  if (settings.firebaseConfig) {
    try {
      await configureFirebase(settings.firebaseConfig);
      if (preferredMode === 'online') await ensureOnlineProject(localProject);
    } catch {
      await cloudStore.disconnect();
      cloudProjects = [];
      if (preferredMode === 'online') {
        mode = 'online';
        activeProjectId = '';
        connectionStatus = 'Firebase unavailable';
      } else {
        mode = 'local';
        activeProjectId = local.id;
        connectionStatus = 'Local';
      }
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
