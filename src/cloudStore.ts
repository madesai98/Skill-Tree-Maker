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
  runTransaction,
  setDoc,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  CLOUD_CHUNK_COLLECTION,
  CLOUD_SEGMENT_KEYS,
  CLOUD_STORAGE_VERSION,
  cloudChunkDocumentId,
  cloudSegmentForProjectKey,
  cloneManifest,
  manifestsEqual,
  parseStoredCloudRoot,
  referencedChunkIds,
  splitCloudText,
  type CloudSegmentKey,
  type CloudSegmentManifest,
  type StoredCloudRootV2,
} from './cloudStorageFormat';
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
  validateProjectGraph,
  type AtomicHistoryChange,
  type CanonicalProject,
  type HistoryDirection,
} from './projectData';

export type { FirebaseOptions } from 'firebase/app';

const CLOUD_COLLECTION = 'skillTreeMakerProjects';
const FIREBASE_APP_NAME = 'skill-tree-maker-online';
const IO_CONCURRENCY = 12;
const CLEANUP_DELAY_MS = 2_000;
const ORPHAN_GRACE_MS = 5 * 60_000;
const CAS_ATTEMPTS = 12;

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

class StaleCloudRevisionError extends Error {
  constructor() {
    super('The cloud project changed while this edit was being prepared.');
    this.name = 'StaleCloudRevisionError';
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
  // These maps remain in the runtime shape for compatibility with the collaboration
  // layer, but storage v2 intentionally stops persisting them. Shared linear history no
  // longer consumes the guards and the maps otherwise grow forever with project size.
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

type LegacyRootStamp = {
  kind: 'legacy';
  name: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
};

type V2RootStamp = {
  kind: 'v2';
  root: StoredCloudRootV2;
};

type RootStamp = LegacyRootStamp | V2RootStamp;

type LoadedCloudProject = {
  cloud: CloudProjectDocument;
  stamp: RootStamp;
};

type PreparedSegments = {
  manifest: CloudSegmentManifest;
  writtenIds: string[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function cloudSegmentValues(cloud: CloudProjectDocument): Record<CloudSegmentKey, unknown> {
  return {
    nodes: cloud.project.nodes,
    edges: cloud.project.edges,
    stats: cloud.project.stats,
    currencies: cloud.project.currencies,
    icons: cloud.project.icons,
    perks: cloud.project.perks,
    settings: {
      version: cloud.project.version,
      perkGridSize: cloud.project.perkGridSize,
    },
    history: cloud.history,
  };
}

function changedSegments(changes: AtomicHistoryChange[]) {
  const segments = new Set<CloudSegmentKey>(['history']);
  changes.forEach((change) => {
    const segment = cloudSegmentForProjectKey(change.key[0] ?? '');
    if (segment) segments.add(segment);
  });
  return segments;
}

function rootFromCloud(
  cloud: CloudProjectDocument,
  segments: CloudSegmentManifest,
  previousSegments?: CloudSegmentManifest,
): StoredCloudRootV2 {
  return {
    storageVersion: CLOUD_STORAGE_VERSION,
    name: cloud.name,
    createdAt: cloud.createdAt,
    updatedAt: cloud.updatedAt,
    revision: cloud.revision,
    segments: cloneManifest(segments),
    ...(previousSegments ? { previousSegments: cloneManifest(previousSegments) } : {}),
  };
}

function legacyStamp(cloud: CloudProjectDocument): LegacyRootStamp {
  return {
    kind: 'legacy',
    name: cloud.name,
    createdAt: cloud.createdAt,
    updatedAt: cloud.updatedAt,
    revision: cloud.revision,
  };
}

function rootMatchesStamp(raw: unknown, stamp: RootStamp) {
  if (stamp.kind === 'v2') {
    const root = parseStoredCloudRoot(raw);
    return Boolean(root)
      && root!.name === stamp.root.name
      && root!.createdAt === stamp.root.createdAt
      && root!.updatedAt === stamp.root.updatedAt
      && root!.revision === stamp.root.revision
      && manifestsEqual(root!.segments, stamp.root.segments);
  }
  const cloud = parseCloudDocument(raw);
  return Boolean(cloud)
    && cloud!.name === stamp.name
    && cloud!.createdAt === stamp.createdAt
    && cloud!.updatedAt === stamp.updatedAt
    && cloud!.revision === stamp.revision;
}

async function runConcurrent<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }));
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
  private cleanupTimers = new Map<string, number>();

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
      await this.migrateLegacyProjects();
      await this.listProjects();
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async disconnect() {
    this.cleanupTimers.forEach((timer) => window.clearTimeout(timer));
    this.cleanupTimers.clear();
    if (this.app) await deleteApp(this.app);
    this.app = null;
    this.db = null;
  }

  private requireDb() {
    if (!this.db) throw new Error('Firebase is not connected.');
    return this.db;
  }

  private chunkRef(projectId: string, segment: CloudSegmentKey, generation: string, index: number) {
    const db = this.requireDb();
    return doc(
      db,
      CLOUD_COLLECTION,
      projectId,
      CLOUD_CHUNK_COLLECTION,
      cloudChunkDocumentId(segment, generation, index),
    );
  }

  private async deleteChunkIds(projectId: string, ids: string[]) {
    if (!ids.length || !this.db) return;
    const db = this.db;
    await runConcurrent(ids, IO_CONCURRENCY, async (id) => {
      await deleteDoc(doc(db, CLOUD_COLLECTION, projectId, CLOUD_CHUNK_COLLECTION, id));
    });
  }

  private async readManifest(projectId: string, manifest: CloudSegmentManifest) {
    const db = this.requireDb();
    const pieces = {} as Record<CloudSegmentKey, string[]>;
    const tasks: Array<{ segment: CloudSegmentKey; generation: string; index: number }> = [];
    CLOUD_SEGMENT_KEYS.forEach((segment) => {
      const ref = manifest[segment];
      pieces[segment] = Array.from({ length: ref.chunkCount }, () => '');
      for (let index = 0; index < ref.chunkCount; index += 1) {
        tasks.push({ segment, generation: ref.generation, index });
      }
    });

    await runConcurrent(tasks, IO_CONCURRENCY, async ({ segment, generation, index }) => {
      const snapshot = await getDoc(doc(
        db,
        CLOUD_COLLECTION,
        projectId,
        CLOUD_CHUNK_COLLECTION,
        cloudChunkDocumentId(segment, generation, index),
      ));
      if (!snapshot.exists()) throw new Error(`Cloud project segment ${segment} is incomplete.`);
      const data = snapshot.data();
      if (typeof data.data !== 'string') throw new Error(`Cloud project segment ${segment} is invalid.`);
      pieces[segment][index] = data.data;
    });

    const values = {} as Record<CloudSegmentKey, unknown>;
    for (const segment of CLOUD_SEGMENT_KEYS) {
      try {
        values[segment] = JSON.parse(pieces[segment].join(''));
      } catch {
        throw new Error(`Cloud project segment ${segment} could not be decoded.`);
      }
    }
    return values;
  }

  private async readHistorySegment(projectId: string, root: StoredCloudRootV2) {
    const db = this.requireDb();
    const ref = root.segments.history;
    const pieces = Array.from({ length: ref.chunkCount }, () => '');
    const indexes = Array.from({ length: ref.chunkCount }, (_, index) => index);
    await runConcurrent(indexes, IO_CONCURRENCY, async (index) => {
      const snapshot = await getDoc(doc(
        db,
        CLOUD_COLLECTION,
        projectId,
        CLOUD_CHUNK_COLLECTION,
        cloudChunkDocumentId('history', ref.generation, index),
      ));
      if (!snapshot.exists() || typeof snapshot.data().data !== 'string') {
        throw new Error('Cloud project history is incomplete.');
      }
      pieces[index] = snapshot.data().data;
    });
    try {
      return normalizeHistoryState(JSON.parse(pieces.join('')));
    } catch {
      throw new Error('Cloud project history could not be decoded.');
    }
  }

  private cloudFromSegments(root: StoredCloudRootV2, values: Record<CloudSegmentKey, unknown>) {
    const settings = isRecord(values.settings) ? values.settings : {};
    const project = normalizeProject({
      version: settings.version,
      nodes: values.nodes,
      edges: values.edges,
      stats: values.stats,
      currencies: values.currencies,
      icons: values.icons,
      perks: values.perks,
      perkGridSize: settings.perkGridSize,
    });
    if (!project) throw new Error('The shared project data is invalid.');
    return {
      name: root.name,
      createdAt: root.createdAt,
      updatedAt: root.updatedAt,
      revision: root.revision,
      project,
      history: normalizeHistoryState(values.history),
      fieldWriters: {},
      entityWriters: {},
      entityTouches: {},
    } satisfies CloudProjectDocument;
  }

  private async readProjectWithoutMigration(projectId: string): Promise<LoadedCloudProject | null> {
    const db = this.requireDb();
    const snapshot = await getDoc(doc(db, CLOUD_COLLECTION, projectId));
    if (!snapshot.exists()) return null;
    const root = parseStoredCloudRoot(snapshot.data());
    if (root) {
      const values = await this.readManifest(projectId, root.segments);
      return { cloud: this.cloudFromSegments(root, values), stamp: { kind: 'v2', root } };
    }
    const cloud = parseCloudDocument(snapshot.data());
    return cloud ? { cloud, stamp: legacyStamp(cloud) } : null;
  }

  private async prepareSegments(
    projectId: string,
    cloud: CloudProjectDocument,
    segments: Set<CloudSegmentKey>,
    baseManifest?: CloudSegmentManifest,
  ): Promise<PreparedSegments> {
    const db = this.requireDb();
    const values = cloudSegmentValues(cloud);
    const generation = randomId('segment');
    const manifest = baseManifest ? cloneManifest(baseManifest) : {} as CloudSegmentManifest;
    const keys = baseManifest ? [...segments] : [...CLOUD_SEGMENT_KEYS];
    const writtenIds: string[] = [];
    const createdAt = Date.now();

    try {
      for (const segment of keys) {
        const text = JSON.stringify(values[segment]);
        if (text === undefined) throw new Error(`Cloud project segment ${segment} is not serializable.`);
        const chunks = splitCloudText(text);
        await runConcurrent(chunks, IO_CONCURRENCY, async (data, index) => {
          const id = cloudChunkDocumentId(segment, generation, index);
          await setDoc(doc(db, CLOUD_COLLECTION, projectId, CLOUD_CHUNK_COLLECTION, id), { data, createdAt });
          writtenIds.push(id);
        });
        manifest[segment] = { generation, chunkCount: chunks.length };
      }
      return { manifest, writtenIds };
    } catch (error) {
      await this.deleteChunkIds(projectId, writtenIds).catch(() => undefined);
      throw error;
    }
  }

  private scheduleCleanup(projectId: string) {
    if (!this.db) return;
    const existing = this.cleanupTimers.get(projectId);
    if (existing !== undefined) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.cleanupTimers.delete(projectId);
      void this.cleanupObsoleteChunks(projectId).catch(() => undefined);
    }, CLEANUP_DELAY_MS);
    this.cleanupTimers.set(projectId, timer);
  }

  private async cleanupObsoleteChunks(projectId: string) {
    const db = this.requireDb();
    const rootSnapshot = await getDoc(doc(db, CLOUD_COLLECTION, projectId));
    if (!rootSnapshot.exists()) return;
    const root = parseStoredCloudRoot(rootSnapshot.data());
    if (!root) return;
    const protectedIds = referencedChunkIds(root);
    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    const chunks = await getDocs(collection(db, CLOUD_COLLECTION, projectId, CLOUD_CHUNK_COLLECTION));
    const obsolete = chunks.docs.flatMap((item) => {
      if (protectedIds.has(item.id)) return [];
      const createdAt = item.data().createdAt;
      if (typeof createdAt === 'number' && createdAt > cutoff) return [];
      return [item.id];
    });
    await this.deleteChunkIds(projectId, obsolete);
  }

  private async migrateLegacyProject(projectId: string) {
    const db = this.requireDb();
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const loaded = await this.readProjectWithoutMigration(projectId);
      if (!loaded || loaded.stamp.kind === 'v2') return;
      const prepared = await this.prepareSegments(projectId, loaded.cloud, new Set(CLOUD_SEGMENT_KEYS));
      const nextRoot = rootFromCloud(loaded.cloud, prepared.manifest);
      try {
        await runTransaction(db, async (transaction) => {
          const ref = doc(db, CLOUD_COLLECTION, projectId);
          const snapshot = await transaction.get(ref);
          if (!snapshot.exists()) throw new Error('The shared project was deleted.');
          if (!rootMatchesStamp(snapshot.data(), loaded.stamp)) throw new StaleCloudRevisionError();
          transaction.set(ref, nextRoot);
        });
        this.scheduleCleanup(projectId);
        return;
      } catch (error) {
        await this.deleteChunkIds(projectId, prepared.writtenIds).catch(() => undefined);
        if (error instanceof StaleCloudRevisionError) continue;
        throw error;
      }
    }
    throw new Error('The shared project changed too frequently to migrate its storage format.');
  }

  private async migrateLegacyProjects() {
    const db = this.requireDb();
    const snapshot = await getDocs(collection(db, CLOUD_COLLECTION));
    for (const item of snapshot.docs) {
      if (parseStoredCloudRoot(item.data())) {
        this.scheduleCleanup(item.id);
        continue;
      }
      if (parseCloudDocument(item.data())) await this.migrateLegacyProject(item.id);
    }
  }

  async listProjects(): Promise<ProjectMeta[]> {
    const db = this.requireDb();
    const snapshot = await getDocs(collection(db, CLOUD_COLLECTION));
    return snapshot.docs.flatMap((item) => {
      const root = parseStoredCloudRoot(item.data());
      if (root) {
        return [{ id: item.id, name: root.name, createdAt: root.createdAt, updatedAt: root.updatedAt }];
      }
      const parsed = parseCloudDocument(item.data());
      return parsed ? [{ id: item.id, name: parsed.name, createdAt: parsed.createdAt, updatedAt: parsed.updatedAt }] : [];
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getProject(id: string) {
    let loaded = await this.readProjectWithoutMigration(id);
    if (!loaded) return null;
    if (loaded.stamp.kind === 'legacy') {
      await this.migrateLegacyProject(id);
      loaded = await this.readProjectWithoutMigration(id);
    }
    return loaded ? cloneValue(loaded.cloud) : null;
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
    const prepared = await this.prepareSegments(id, cloud, new Set(CLOUD_SEGMENT_KEYS));
    try {
      await setDoc(doc(db, CLOUD_COLLECTION, id), rootFromCloud(cloud, prepared.manifest));
      return { id, cloud: cloneValue(cloud) };
    } catch (error) {
      await this.deleteChunkIds(id, prepared.writtenIds).catch(() => undefined);
      throw error;
    }
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
    const timer = this.cleanupTimers.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    this.cleanupTimers.delete(id);
    const chunks = await getDocs(collection(db, CLOUD_COLLECTION, id, CLOUD_CHUNK_COLLECTION));
    const histories = await getDocs(collection(db, CLOUD_COLLECTION, id, 'histories'));
    await runConcurrent(
      [...chunks.docs.map((item) => item.ref), ...histories.docs.map((item) => item.ref)],
      IO_CONCURRENCY,
      async (ref) => deleteDoc(ref),
    );
    await deleteDoc(doc(db, CLOUD_COLLECTION, id));
  }

  subscribe(id: string, onChange: (cloud: CloudProjectDocument) => void, onError: () => void): Unsubscribe {
    const db = this.requireDb();
    let closed = false;
    let sequence = 0;

    const emit = (cloud: CloudProjectDocument) => {
      if (closed) return;
      onChange(cloneValue(cloud));
      window.dispatchEvent(new CustomEvent(SHARED_HISTORY_SYNC_EVENT, {
        detail: { projectId: id, revision: cloud.revision, history: cloneValue(cloud.history) },
      }));
    };

    const unsubscribe = onSnapshot(doc(db, CLOUD_COLLECTION, id), (snapshot) => {
      const currentSequence = ++sequence;
      if (!snapshot.exists()) return;
      const root = parseStoredCloudRoot(snapshot.data());
      if (!root) {
        const legacy = parseCloudDocument(snapshot.data());
        if (legacy) {
          emit(legacy);
          void this.migrateLegacyProject(id).catch(() => undefined);
        }
        return;
      }

      void this.readManifest(id, root.segments).then((values) => {
        if (closed || currentSequence !== sequence) return;
        emit(this.cloudFromSegments(root, values));
      }).catch(() => {
        if (!closed && currentSequence === sequence) onError();
      });
    }, onError);

    return () => {
      closed = true;
      sequence += 1;
      unsubscribe();
    };
  }

  async loadHistory(projectId: string, _userId: string): Promise<HistoryState> {
    const db = this.requireDb();
    const snapshot = await getDoc(doc(db, CLOUD_COLLECTION, projectId));
    if (!snapshot.exists()) return { entries: [], cursor: -1 };
    const root = parseStoredCloudRoot(snapshot.data());
    if (root) return this.readHistorySegment(projectId, root);
    const cloud = parseCloudDocument(snapshot.data());
    return cloud ? cloneValue(cloud.history) : { entries: [], cursor: -1 };
  }

  async saveHistory(_projectId: string, _userId: string, _state: HistoryState) {
    // Online history is committed atomically with the root manifest switch. A separate
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

    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const loaded = await this.readProjectWithoutMigration(projectId);
      if (!loaded) throw new Error('The shared project was deleted.');
      const cloud = loaded.cloud;

      // Apply only this editor's atomic intent to the newest shared project. Unrelated
      // collaborator edits are preserved, while a same-field concurrent edit follows
      // normal linear last-writer-wins ordering.
      const nextProject = applyChanges(cloud.project, intendedChanges);
      const graphIssue = validateProjectGraph(nextProject);
      if (graphIssue) throw new Error(graphIssue);
      const changes = diffProjects(cloud.project, nextProject);
      if (!changes.length) return null;

      const now = Date.now();
      const history = appendHistoryState(cloud.history, changes, userId, now);
      const nextCloud: CloudProjectDocument = {
        ...cloud,
        project: cloneValue(nextProject),
        history,
        revision: cloud.revision + 1,
        updatedAt: now,
        fieldWriters: {},
        entityWriters: {},
        entityTouches: {},
      };
      const segments = changedSegments(changes);
      const baseManifest = loaded.stamp.kind === 'v2' ? loaded.stamp.root.segments : undefined;
      const prepared = await this.prepareSegments(projectId, nextCloud, segments, baseManifest);
      const previousSegments = loaded.stamp.kind === 'v2' ? loaded.stamp.root.segments : undefined;
      const nextRoot = rootFromCloud(nextCloud, prepared.manifest, previousSegments);

      try {
        await runTransaction(db, async (transaction) => {
          const ref = doc(db, CLOUD_COLLECTION, projectId);
          const snapshot = await transaction.get(ref);
          if (!snapshot.exists()) throw new Error('The shared project was deleted.');
          if (!rootMatchesStamp(snapshot.data(), loaded.stamp)) throw new StaleCloudRevisionError();
          transaction.set(ref, nextRoot);
        });
        this.scheduleCleanup(projectId);
        return {
          before: cloneValue(cloud.project),
          after: cloneValue(nextProject),
          cloud: cloneValue(nextCloud),
          mutationId,
          changes: cloneValue(changes),
          history: {
            sharedState: cloneValue(history),
            sharedRevision: nextCloud.revision,
            mutationId,
            ownerId: userId,
          },
        };
      } catch (error) {
        await this.deleteChunkIds(projectId, prepared.writtenIds).catch(() => undefined);
        if (error instanceof StaleCloudRevisionError) continue;
        throw error;
      }
    }

    throw new Error('The shared project changed too frequently to save this edit.');
  }

  async applyHistory(
    projectId: string,
    userId: string,
    direction: HistoryDirection,
    _entry: HistoryEntry,
  ) {
    const db = this.requireDb();
    const mutationId = randomId(`${direction}-${userId.slice(0, 8)}`);

    try {
      for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
        const loaded = await this.readProjectWithoutMigration(projectId);
        if (!loaded) throw new Error('The shared project was deleted.');
        const cloud = loaded.cloud;
        const history = normalizeHistoryState(cloud.history);
        const entryIndex = direction === 'undo' ? history.cursor : history.cursor + 1;
        const entry = history.entries[entryIndex];
        if (!entry) {
          return {
            ok: true,
            project: cloneValue(cloud.project),
            cloud: cloneValue(cloud),
            history: cloneValue(history),
            historyRevision: cloud.revision,
            mutationId,
          };
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
        const nextCloud: CloudProjectDocument = {
          ...cloud,
          project: cloneValue(nextProject),
          history: nextHistory,
          revision: cloud.revision + 1,
          updatedAt: Date.now(),
          fieldWriters: {},
          entityWriters: {},
          entityTouches: {},
        };
        const segments = changedSegments(actualChanges);
        const baseManifest = loaded.stamp.kind === 'v2' ? loaded.stamp.root.segments : undefined;
        const prepared = await this.prepareSegments(projectId, nextCloud, segments, baseManifest);
        const previousSegments = loaded.stamp.kind === 'v2' ? loaded.stamp.root.segments : undefined;
        const nextRoot = rootFromCloud(nextCloud, prepared.manifest, previousSegments);

        try {
          await runTransaction(db, async (transaction) => {
            const ref = doc(db, CLOUD_COLLECTION, projectId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists()) throw new Error('The shared project was deleted.');
            if (!rootMatchesStamp(snapshot.data(), loaded.stamp)) throw new StaleCloudRevisionError();
            transaction.set(ref, nextRoot);
          });
          this.scheduleCleanup(projectId);
          return {
            ok: true,
            project: cloneValue(nextProject),
            cloud: cloneValue(nextCloud),
            history: cloneValue(nextHistory),
            historyRevision: nextCloud.revision,
            mutationId,
          };
        } catch (error) {
          await this.deleteChunkIds(projectId, prepared.writtenIds).catch(() => undefined);
          if (error instanceof StaleCloudRevisionError) continue;
          throw error;
        }
      }
      return { ok: false, reason: 'The shared project changed too frequently to apply history.' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'The shared history could not be applied.' };
    }
  }
}
