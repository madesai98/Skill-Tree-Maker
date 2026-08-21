import {
  deleteApp,
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
  appendHistoryState,
  normalizeHistoryState,
  SHARED_HISTORY_SYNC_EVENT,
  type CollaborationHistoryMeta,
  type EntityTouchVector,
  type HistoryEntry,
  type HistoryState,
} from './history';
import {
  applyAtKey,
  cloneValue,
  diffProjects,
  normalizeProject,
  sideForDirection,
  touchedEntityKeys,
  validateProjectGraph,
  type AtomicHistoryChange,
  type CanonicalProject,
  type HistoryDirection,
} from './projectData';

export type { FirebaseOptions } from 'firebase/app';

const CLOUD_COLLECTION = 'skillTreeMakerProjects';
const FIREBASE_APP_NAME = 'skill-tree-maker-online';

type CloudCommitOptions = {
  // Kept for API compatibility with older runtime code. Shared linear history no longer
  // has an overwrite mode; normal edits are applied on top of the latest cloud state.
  overwriteConflicts?: boolean;
};

export type HistoryOverwriteScope = {
  paths: string[];
  entities: string[];
};

// Kept as a compatibility export. The shared-linear collaboration path does not throw
// this error or present overwrite/cancel conflict dialogs anymore.
export class CloudConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudConflictError';
  }
}

export type ProjectMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

export type CloudProjectDocument = {
  name: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  project: CanonicalProject;
  history: HistoryState;
  // These maps are retained so existing cloud documents and queued-edit code remain
  // compatible, but they are no longer used to gate undo/redo or show history conflicts.
  fieldWriters: Record<string, string>;
  entityWriters: Record<string, string>;
  entityTouches: Record<string, EntityTouchVector>;
};

export type CloudCommitResult = {
  before: CanonicalProject;
  after: CanonicalProject;
  cloud: CloudProjectDocument;
  mutationId: string;
  changes: AtomicHistoryChange[];
  history: CollaborationHistoryMeta;
  overwriteScope?: HistoryOverwriteScope;
};

function randomId(prefix: string) {
  const id = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => typeof item === 'string' ? [[key, item]] : []));
}

function touchVector(value: unknown): EntityTouchVector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) =>
    typeof item === 'number' && Number.isFinite(item) && item >= 0 ? [[key, item]] : []));
}

function entityTouchRecord(value: unknown): Record<string, EntityTouchVector> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, touchVector(item)]));
}

function projectPath(change: AtomicHistoryChange) {
  return change.key.join('\u001f');
}

function incrementTouches(
  current: Record<string, EntityTouchVector>,
  keys: string[],
  userId: string,
) {
  const next = cloneValue(current);
  for (const key of keys) {
    const vector = { ...(next[key] ?? {}) };
    vector[userId] = (vector[userId] ?? 0) + 1;
    next[key] = vector;
  }
  return next;
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

function applyChanges(project: CanonicalProject, changes: AtomicHistoryChange[]) {
  let next: unknown = project;
  for (const change of changes) {
    next = applyAtKey(next, change.key, change.newExists, change.newValue, change.newIndex);
  }
  return removeDanglingEdges(next as CanonicalProject);
}

function writerMetadata(
  cloud: CloudProjectDocument,
  before: CanonicalProject,
  after: CanonicalProject,
  changes: AtomicHistoryChange[],
  mutationId: string,
  userId: string,
) {
  const fieldWriters = { ...cloud.fieldWriters };
  for (const change of changes) fieldWriters[projectPath(change)] = mutationId;
  const touched = touchedEntityKeys(before, after, changes);
  const entityWriters = { ...cloud.entityWriters };
  for (const key of touched) entityWriters[key] = mutationId;
  const entityTouches = incrementTouches(cloud.entityTouches, touched, userId);
  return { fieldWriters, entityWriters, entityTouches };
}

export function parseCloudDocument(raw: unknown): CloudProjectDocument | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const project = normalizeProject(value.project);
  if (!project || typeof value.name !== 'string') return null;
  const entityWriters = stringRecord(value.entityWriters);
  const entityTouches = entityTouchRecord(value.entityTouches);
  for (const [key, writer] of Object.entries(entityWriters)) {
    if (!Object.prototype.hasOwnProperty.call(entityTouches, key)) entityTouches[key] = { [`legacy:${writer}`]: 1 };
  }
  return {
    name: value.name,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
    revision: typeof value.revision === 'number' ? value.revision : 0,
    project,
    history: normalizeHistoryState(value.history),
    fieldWriters: stringRecord(value.fieldWriters),
    entityWriters,
    entityTouches,
  };
}

export function newerCloudDocument(left: CloudProjectDocument | null, right: CloudProjectDocument) {
  if (!left || right.revision > left.revision || (right.revision === left.revision && right.updatedAt >= left.updatedAt)) {
    return cloneValue(right);
  }
  return left;
}

export class FirestoreProjectStore {
  private app: FirebaseApp | null = null;
  private db: Firestore | null = null;

  get connected() {
    return Boolean(this.db);
  }

  async connect(config: FirebaseOptions) {
    await this.disconnect();
    const existing = getApps().find((app) => app.name === FIREBASE_APP_NAME);
    if (existing) await deleteApp(existing);
    this.app = initializeApp(config, FIREBASE_APP_NAME);
    this.db = getFirestore(this.app);
    try {
      await this.listProjects();
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async disconnect() {
    if (this.app) await deleteApp(this.app);
    this.app = null;
    this.db = null;
  }

  private requireDb() {
    if (!this.db) throw new Error('Firebase is not connected.');
    return this.db;
  }

  async listProjects(): Promise<ProjectMeta[]> {
    const db = this.requireDb();
    const snapshot = await getDocs(query(collection(db, CLOUD_COLLECTION)));
    return snapshot.docs.flatMap((item) => {
      const parsed = parseCloudDocument(item.data());
      return parsed ? [{ id: item.id, name: parsed.name, createdAt: parsed.createdAt, updatedAt: parsed.updatedAt }] : [];
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getProject(id: string) {
    const db = this.requireDb();
    const snapshot = await getDoc(doc(db, CLOUD_COLLECTION, id));
    if (!snapshot.exists()) return null;
    return parseCloudDocument(snapshot.data());
  }

  async createProject(project: CanonicalProject, name: string) {
    const db = this.requireDb();
    const id = randomId('project');
    const now = Date.now();
    const cloud: CloudProjectDocument = {
      name,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      project: cloneValue(project),
      history: { entries: [], cursor: -1 },
      fieldWriters: {},
      entityWriters: {},
      entityTouches: {},
    };
    await setDoc(doc(db, CLOUD_COLLECTION, id), cloud);
    return { id, cloud };
  }

  async renameProject(id: string, name: string) {
    const db = this.requireDb();
    await runTransaction(db, async (transaction) => {
      const ref = doc(db, CLOUD_COLLECTION, id);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) throw new Error('Project no longer exists.');
      transaction.update(ref, { name, updatedAt: Date.now() });
    });
  }

  async deleteProject(id: string) {
    const db = this.requireDb();
    // Clean up legacy per-user history documents left by older versions.
    const histories = await getDocs(collection(db, CLOUD_COLLECTION, id, 'histories'));
    await Promise.all(histories.docs.map((history) => deleteDoc(history.ref)));
    await deleteDoc(doc(db, CLOUD_COLLECTION, id));
  }

  subscribe(id: string, onChange: (cloud: CloudProjectDocument) => void, onError: () => void): Unsubscribe {
    const db = this.requireDb();
    return onSnapshot(doc(db, CLOUD_COLLECTION, id), (snapshot) => {
      if (!snapshot.exists()) return;
      const cloud = parseCloudDocument(snapshot.data());
      if (!cloud) return;
      onChange(cloud);
      window.dispatchEvent(new CustomEvent(SHARED_HISTORY_SYNC_EVENT, {
        detail: { projectId: id, history: cloneValue(cloud.history) },
      }));
    }, onError);
  }

  async loadHistory(projectId: string, _userId: string): Promise<HistoryState> {
    const cloud = await this.getProject(projectId);
    return cloud ? cloneValue(cloud.history) : { entries: [], cursor: -1 };
  }

  async saveHistory(_projectId: string, _userId: string, _state: HistoryState) {
    // Online history is committed atomically with the project document. A separate
    // history write would reintroduce the race that the shared timeline is meant to avoid.
  }

  async pruneHistoriesForOverwrite(_projectId: string, _scope: HistoryOverwriteScope) {
    // Overwrite history pruning was part of the old per-user guarded history model.
    // Shared linear history never deletes entries because of another user's edit.
  }

  async commitProject(
    projectId: string,
    base: CloudProjectDocument,
    requested: CanonicalProject,
    userId: string,
    _options: CloudCommitOptions = {},
  ): Promise<CloudCommitResult | null> {
    const db = this.requireDb();
    const intendedChanges = diffProjects(base.project, requested);
    if (!intendedChanges.length) return null;
    const mutationId = randomId(`mutation-${userId.slice(0, 8)}`);
    let result: CloudCommitResult | null = null;

    await runTransaction(db, async (transaction) => {
      const ref = doc(db, CLOUD_COLLECTION, projectId);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) throw new Error('The shared project was deleted.');
      const cloud = parseCloudDocument(snapshot.data());
      if (!cloud) throw new Error('The shared project is invalid.');

      // Apply only this editor's atomic intent to the newest shared project. Unrelated
      // collaborator edits are preserved, while a same-field concurrent edit follows
      // normal linear last-writer-wins ordering instead of opening an overwrite dialog.
      const nextProject = applyChanges(cloud.project, intendedChanges);
      const graphIssue = validateProjectGraph(nextProject);
      if (graphIssue) throw new Error(graphIssue);
      const changes = diffProjects(cloud.project, nextProject);
      if (!changes.length) return;

      const now = Date.now();
      const history = appendHistoryState(cloud.history, changes, userId, now);
      const metadata = writerMetadata(cloud, cloud.project, nextProject, changes, mutationId, userId);
      const nextCloud: CloudProjectDocument = {
        ...cloud,
        project: cloneValue(nextProject),
        history,
        revision: cloud.revision + 1,
        updatedAt: now,
        ...metadata,
      };
      transaction.set(ref, nextCloud);
      result = {
        before: cloneValue(cloud.project),
        after: cloneValue(nextProject),
        cloud: cloneValue(nextCloud),
        mutationId,
        changes: cloneValue(changes),
        history: { sharedState: cloneValue(history), mutationId, ownerId: userId },
      };
    });

    return result;
  }

  async applyHistory(
    projectId: string,
    userId: string,
    direction: HistoryDirection,
    _entry: HistoryEntry,
  ) {
    const db = this.requireDb();
    const mutationId = randomId(`${direction}-${userId.slice(0, 8)}`);
    let result: {
      project: CanonicalProject;
      cloud: CloudProjectDocument;
      history: HistoryState;
    } | null = null;

    try {
      await runTransaction(db, async (transaction) => {
        const ref = doc(db, CLOUD_COLLECTION, projectId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists()) throw new Error('The shared project was deleted.');
        const cloud = parseCloudDocument(snapshot.data());
        if (!cloud) throw new Error('The shared project is invalid.');

        const history = normalizeHistoryState(cloud.history);
        const entryIndex = direction === 'undo' ? history.cursor : history.cursor + 1;
        const entry = history.entries[entryIndex];
        if (!entry) {
          result = {
            project: cloneValue(cloud.project),
            cloud: cloneValue(cloud),
            history: cloneValue(history),
          };
          return;
        }

        let next: unknown = cloud.project;
        const ordered = direction === 'undo' ? [...entry.changes].reverse() : entry.changes;
        for (const change of ordered) {
          const side = sideForDirection(change, direction);
          next = applyAtKey(next, change.key, side.exists, side.value, side.index);
        }
        const nextProject = removeDanglingEdges(next as CanonicalProject);
        const graphIssue = validateProjectGraph(nextProject);
        if (graphIssue) throw new Error(graphIssue);

        const nextHistory: HistoryState = {
          entries: cloneValue(history.entries),
          cursor: direction === 'undo' ? entryIndex - 1 : entryIndex,
        };
        const actualChanges = diffProjects(cloud.project, nextProject);
        const metadata = writerMetadata(cloud, cloud.project, nextProject, actualChanges, mutationId, userId);
        const nextCloud: CloudProjectDocument = {
          ...cloud,
          project: cloneValue(nextProject),
          history: nextHistory,
          revision: cloud.revision + 1,
          updatedAt: Date.now(),
          ...metadata,
        };
        transaction.set(ref, nextCloud);
        result = {
          project: cloneValue(nextProject),
          cloud: cloneValue(nextCloud),
          history: cloneValue(nextHistory),
        };
      });

      if (!result) return { ok: false, reason: 'The history transaction did not produce a project.' };
      const completed = result as {
        project: CanonicalProject;
        cloud: CloudProjectDocument;
        history: HistoryState;
      };
      return {
        ok: true,
        project: completed.project,
        cloud: completed.cloud,
        history: completed.history,
        mutationId,
      };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'The shared history could not be applied.' };
    }
  }
}
