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
import type {
  CollaborationHistoryMeta,
  EntityTouchVector,
  HistoryEntry,
  HistoryState,
} from './history';
import { foreignTouchesMatch, projectPath } from './collaboration';
import {
  applyAtKey,
  cloneValue,
  diffProjects,
  guardEntityKeys,
  normalizeProject,
  readAtKey,
  sameValue,
  sideForDirection,
  touchedEntityKeys,
  validateProjectGraph,
  valueMatchesSide,
  type AtomicHistoryChange,
  type CanonicalProject,
  type HistoryDirection,
} from './projectData';

export type { FirebaseOptions } from 'firebase/app';

const CLOUD_COLLECTION = 'skillTreeMakerProjects';
const FIREBASE_APP_NAME = 'skill-tree-maker-online';

type CloudCommitOptions = {
  overwriteConflicts?: boolean;
};

export type HistoryOverwriteScope = {
  paths: string[];
  entities: string[];
};

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

function sameValueAtPath(left: CanonicalProject, right: CanonicalProject, change: AtomicHistoryChange) {
  const a = readAtKey(left, change.key);
  const b = readAtKey(right, change.key);
  return a.exists === b.exists && (!a.exists || sameValue(a.value, b.value));
}

function sameWriter(left: Record<string, string>, right: Record<string, string>, key: string) {
  return (left[key] ?? null) === (right[key] ?? null);
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

function fieldGuardSnapshot(fieldWriters: Record<string, string>, changes: AtomicHistoryChange[]) {
  return Object.fromEntries(changes.map((change) => {
    const path = projectPath(change);
    return [path, fieldWriters[path]];
  }));
}

function touchGuardSnapshot(entityTouches: Record<string, EntityTouchVector>, changes: AtomicHistoryChange[]) {
  return Object.fromEntries(guardEntityKeys(changes).map((key) => [key, cloneValue(entityTouches[key] ?? {})]));
}

function entityKeyForChange(change: AtomicHistoryChange) {
  const [collection, id] = change.key;
  if (!collection || !id) return null;
  const singular = collection === 'nodes'
    ? 'node'
    : collection === 'edges'
      ? 'edge'
      : collection === 'stats'
        ? 'stat'
        : collection === 'currencies'
          ? 'currency'
          : collection === 'icons'
            ? 'icon'
            : null;
  return singular ? `${singular}:${id}` : null;
}

function collectionWasCleared(
  base: CanonicalProject,
  requested: CanonicalProject,
  collectionName: 'nodes' | 'edges' | 'stats' | 'currencies' | 'icons',
) {
  return base[collectionName].length > 0 && requested[collectionName].length === 0;
}

function applyOverwriteIntents(
  current: CanonicalProject,
  base: CanonicalProject,
  requested: CanonicalProject,
  changes: AtomicHistoryChange[],
) {
  let next: unknown = current;
  for (const change of changes) next = applyAtKey(next, change.key, change.newExists, change.newValue, change.newIndex);
  const project = cloneValue(next as CanonicalProject);

  const collections = ['nodes', 'edges', 'stats', 'currencies', 'icons'] as const;
  for (const collectionName of collections) {
    if (collectionWasCleared(base, requested, collectionName)) project[collectionName] = [];
  }

  const nodeIds = new Set(project.nodes.flatMap((node) => typeof node.id === 'string' ? [node.id] : []));
  project.edges = project.edges.filter((edge) =>
    typeof edge.source === 'string'
    && typeof edge.target === 'string'
    && nodeIds.has(edge.source)
    && nodeIds.has(edge.target));

  return project;
}

function overwriteScopeForChanges(changes: AtomicHistoryChange[]): HistoryOverwriteScope {
  const paths = new Set<string>();
  const entities = new Set<string>();
  for (const change of changes) {
    paths.add(projectPath(change));
    if (change.key.length === 2) {
      const key = entityKeyForChange(change);
      if (key) entities.add(key);
    }
  }
  return { paths: [...paths], entities: [...entities] };
}

function historyEntryAffectedByOverwrite(entry: HistoryEntry, scope: HistoryOverwriteScope) {
  const paths = new Set(scope.paths);
  const entities = new Set(scope.entities);
  if (entry.changes.some((change) => paths.has(projectPath(change)))) return true;
  if (!entities.size) return false;
  if (entry.changes.some((change) => {
    const key = entityKeyForChange(change);
    return Boolean(key && entities.has(key));
  })) return true;
  return guardEntityKeys(entry.changes).some((key) => entities.has(key));
}

function pruneHistoryStateForOverwrite(state: HistoryState, scope: HistoryOverwriteScope): HistoryState {
  const cursor = Math.max(-1, Math.min(state.cursor, state.entries.length - 1));
  const kept: HistoryEntry[] = [];
  let keptThroughCursor = 0;
  state.entries.forEach((entry, index) => {
    if (historyEntryAffectedByOverwrite(entry, scope)) return;
    kept.push(entry);
    if (index <= cursor) keptThroughCursor += 1;
  });
  return { entries: kept.slice(-50), cursor: Math.min(keptThroughCursor - 1, kept.length - 1) };
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
    const histories = await getDocs(collection(db, CLOUD_COLLECTION, id, 'histories'));
    await Promise.all(histories.docs.map((history) => deleteDoc(history.ref)));
    await deleteDoc(doc(db, CLOUD_COLLECTION, id));
  }

  subscribe(id: string, onChange: (cloud: CloudProjectDocument) => void, onError: () => void): Unsubscribe {
    const db = this.requireDb();
    return onSnapshot(doc(db, CLOUD_COLLECTION, id), (snapshot) => {
      if (!snapshot.exists()) return;
      const cloud = parseCloudDocument(snapshot.data());
      if (cloud) onChange(cloud);
    }, onError);
  }

  async loadHistory(projectId: string, userId: string): Promise<HistoryState> {
    const db = this.requireDb();
    const snapshot = await getDoc(doc(db, CLOUD_COLLECTION, projectId, 'histories', userId));
    if (!snapshot.exists()) return { entries: [], cursor: -1 };
    const data = snapshot.data() as Partial<HistoryState>;
    return {
      entries: Array.isArray(data.entries) ? data.entries as HistoryEntry[] : [],
      cursor: typeof data.cursor === 'number' ? data.cursor : -1,
    };
  }

  async saveHistory(projectId: string, userId: string, state: HistoryState) {
    const db = this.requireDb();
    await setDoc(doc(db, CLOUD_COLLECTION, projectId, 'histories', userId), {
      entries: state.entries.slice(-50),
      cursor: state.cursor,
      updatedAt: Date.now(),
    });
  }

  async pruneHistoriesForOverwrite(projectId: string, scope: HistoryOverwriteScope) {
    if (!scope.paths.length && !scope.entities.length) return;
    const db = this.requireDb();
    const histories = await getDocs(collection(db, CLOUD_COLLECTION, projectId, 'histories'));
    await Promise.all(histories.docs.map((history) => runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(history.ref);
      if (!snapshot.exists()) return;
      const data = snapshot.data() as Partial<HistoryState>;
      const state: HistoryState = {
        entries: Array.isArray(data.entries) ? data.entries as HistoryEntry[] : [],
        cursor: typeof data.cursor === 'number' ? data.cursor : -1,
      };
      const next = pruneHistoryStateForOverwrite(state, scope);
      if (next.entries.length === state.entries.length && next.cursor === state.cursor) return;
      transaction.set(history.ref, {
        entries: next.entries,
        cursor: next.cursor,
        updatedAt: Date.now(),
      }, { merge: true });
    })));
  }

  async commitProject(
    projectId: string,
    base: CloudProjectDocument,
    requested: CanonicalProject,
    userId: string,
    options: CloudCommitOptions = {},
  ): Promise<CloudCommitResult | null> {
    const db = this.requireDb();
    const intendedChanges = diffProjects(base.project, requested);
    if (!intendedChanges.length) return null;
    const overwriteConflicts = options.overwriteConflicts === true;
    const mutationId = randomId(`mutation-${userId.slice(0, 8)}`);
    let result: CloudCommitResult | null = null;

    await runTransaction(db, async (transaction) => {
      const ref = doc(db, CLOUD_COLLECTION, projectId);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) throw new Error('The shared project was deleted.');
      const cloud = parseCloudDocument(snapshot.data());
      if (!cloud) throw new Error('The shared project is invalid.');

      if (!overwriteConflicts) {
        for (const change of intendedChanges) {
          if (!sameValueAtPath(cloud.project, base.project, change)
            || !sameWriter(cloud.fieldWriters, base.fieldWriters, projectPath(change))) {
            throw new CloudConflictError('A collaborator changed the same part of the project while you were editing.');
          }
        }
        for (const key of guardEntityKeys(intendedChanges)) {
          const baseHasVector = Object.prototype.hasOwnProperty.call(base.entityTouches, key);
          if (baseHasVector) {
            if (!foreignTouchesMatch(cloud.entityTouches[key], base.entityTouches[key], userId)) {
              throw new CloudConflictError('A collaborator modified an entity this structural edit depends on.');
            }
          } else if (!sameWriter(cloud.entityWriters, base.entityWriters, key)) {
            throw new CloudConflictError('A collaborator modified an entity this structural edit depends on.');
          }
        }
      }

      let nextProject: CanonicalProject;
      if (overwriteConflicts) {
        nextProject = applyOverwriteIntents(cloud.project, base.project, requested, intendedChanges);
      } else {
        let next: unknown = cloud.project;
        for (const change of intendedChanges) next = applyAtKey(next, change.key, change.newExists, change.newValue, change.newIndex);
        nextProject = next as CanonicalProject;
      }

      const graphIssue = validateProjectGraph(nextProject);
      if (graphIssue) throw new Error(graphIssue);
      const changes = diffProjects(cloud.project, nextProject);
      if (!changes.length) return;

      const fieldWriters = { ...cloud.fieldWriters };
      for (const change of changes) fieldWriters[projectPath(change)] = mutationId;
      const touched = touchedEntityKeys(cloud.project, nextProject, changes);
      const entityWriters = { ...cloud.entityWriters };
      for (const key of touched) entityWriters[key] = mutationId;
      const entityTouches = incrementTouches(cloud.entityTouches, touched, userId);
      const nextCloud: CloudProjectDocument = {
        ...cloud,
        project: nextProject,
        revision: cloud.revision + 1,
        updatedAt: Date.now(),
        fieldWriters,
        entityWriters,
        entityTouches,
      };
      transaction.set(ref, nextCloud);
      result = {
        before: cloneValue(cloud.project),
        after: cloneValue(nextProject),
        cloud: cloneValue(nextCloud),
        mutationId,
        changes: cloneValue(changes),
        history: {
          mutationId,
          ownerId: userId,
          fieldGuards: fieldGuardSnapshot(fieldWriters, changes),
          entityTouchGuards: touchGuardSnapshot(entityTouches, changes),
        },
        ...(overwriteConflicts ? { overwriteScope: overwriteScopeForChanges(changes) } : {}),
      };
    });

    return result;
  }

  async applyHistory(projectId: string, userId: string, direction: HistoryDirection, entry: HistoryEntry) {
    const db = this.requireDb();
    if (!entry.mutationId) return { ok: false, reason: 'This entry predates collaborative mutation tracking.' };
    if (entry.ownerId && entry.ownerId !== userId) return { ok: false, reason: 'This history entry belongs to another collaborator.' };
    const ownerId = entry.ownerId ?? userId;
    const mutationId = randomId(`${direction}-${userId.slice(0, 8)}`);

    try {
      let result: { project: CanonicalProject; cloud: CloudProjectDocument } | null = null;
      await runTransaction(db, async (transaction) => {
        const ref = doc(db, CLOUD_COLLECTION, projectId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists()) throw new Error('The shared project was deleted.');
        const cloud = parseCloudDocument(snapshot.data());
        if (!cloud) throw new Error('The shared project is invalid.');

        const fieldsOwned = entry.changes.every((change) => {
          const path = projectPath(change);
          const expected = entry.fieldGuards?.[path] ?? entry.mutationId;
          return cloud.fieldWriters[path] === expected;
        });
        const entityGuards = guardEntityKeys(entry.changes);
        const entitiesSafe = entityGuards.every((key) => {
          const expectedVector = entry.entityTouchGuards?.[key];
          if (expectedVector) return foreignTouchesMatch(cloud.entityTouches[key], expectedVector, ownerId);
          return cloud.entityWriters[key] === entry.mutationId;
        });
        if (!fieldsOwned || !entitiesSafe || !entry.changes.every((change) => valueMatchesSide(cloud.project, change, direction))) {
          throw new Error('Another collaborator changed state affected by this history entry.');
        }

        let next: unknown = cloud.project;
        const ordered = direction === 'undo' ? [...entry.changes].reverse() : entry.changes;
        for (const change of ordered) {
          const side = sideForDirection(change, direction);
          next = applyAtKey(next, change.key, side.exists, side.value, side.index);
        }
        const nextProject = next as CanonicalProject;
        const graphIssue = validateProjectGraph(nextProject);
        if (graphIssue) throw new Error(graphIssue);

        const fieldWriters = { ...cloud.fieldWriters };
        for (const change of entry.changes) fieldWriters[projectPath(change)] = mutationId;
        const touched = touchedEntityKeys(cloud.project, nextProject, entry.changes);
        const entityWriters = { ...cloud.entityWriters };
        for (const key of touched) entityWriters[key] = mutationId;
        const entityTouches = incrementTouches(cloud.entityTouches, touched, userId);
        const nextCloud: CloudProjectDocument = {
          ...cloud,
          project: nextProject,
          revision: cloud.revision + 1,
          updatedAt: Date.now(),
          fieldWriters,
          entityWriters,
          entityTouches,
        };
        transaction.set(ref, nextCloud);
        result = { project: cloneValue(nextProject), cloud: cloneValue(nextCloud) };
      });

      if (!result) return { ok: false, reason: 'The history transaction did not produce a project.' };
      const completed = result as { project: CanonicalProject; cloud: CloudProjectDocument };
      return { ok: true, project: completed.project, cloud: completed.cloud, mutationId };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'The shared project changed.' };
    }
  }
}
