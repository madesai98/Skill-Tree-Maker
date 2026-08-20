import {
  cloneValue,
  createBlankProject,
  createStarterProject,
  normalizeProject,
  type CanonicalProject,
} from './projectData';
import type { ProjectMeta } from './cloudStore';

const WORKING_PROJECT_KEY = 'incremental-td-skill-tree:v2';
const LOCAL_INDEX_KEY = 'skill-tree:local-projects:v1';
const LOCAL_PROJECT_PREFIX = 'skill-tree:local-project:v1:';
const LEGACY_HISTORY_V2_KEY = 'incremental-td-skill-tree:history:v2';
const HISTORY_V3_PREFIX = 'incremental-td-skill-tree:history:v3:';

function randomId(prefix: string) {
  const id = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

function projectKey(id: string) {
  return `${LOCAL_PROJECT_PREFIX}${id}`;
}

function readIndex(): ProjectMeta[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_INDEX_KEY) ?? '') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item): ProjectMeta[] => {
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

function writeIndex(items: ProjectMeta[]) {
  localStorage.setItem(LOCAL_INDEX_KEY, JSON.stringify(items));
}

export function readWorkingProject() {
  return normalizeProject(localStorage.getItem(WORKING_PROJECT_KEY) ?? '') ?? createStarterProject();
}

export class LocalProjectStore {
  private projects = readIndex();

  listProjects() {
    return cloneValue(this.projects);
  }

  ensureMigration() {
    if (this.projects.length) return this.projects[0];
    const now = Date.now();
    const id = randomId('project');
    const project = readWorkingProject();
    const meta: ProjectMeta = { id, name: 'My Skill Tree', createdAt: now, updatedAt: now };
    localStorage.setItem(projectKey(id), JSON.stringify(project));
    this.projects = [meta];
    writeIndex(this.projects);

    const legacyHistory = localStorage.getItem(LEGACY_HISTORY_V2_KEY);
    const migratedHistoryKey = `${HISTORY_V3_PREFIX}local:${id}`;
    if (legacyHistory && !localStorage.getItem(migratedHistoryKey)) {
      localStorage.setItem(migratedHistoryKey, legacyHistory);
    }
    return cloneValue(meta);
  }

  getProject(id: string) {
    return normalizeProject(localStorage.getItem(projectKey(id)) ?? '');
  }

  saveProject(id: string, project: CanonicalProject) {
    localStorage.setItem(projectKey(id), JSON.stringify(project));
    const now = Date.now();
    this.projects = this.projects.map((item) => item.id === id ? { ...item, updatedAt: now } : item);
    writeIndex(this.projects);
  }

  createProject(source?: CanonicalProject, name?: string) {
    const now = Date.now();
    const id = randomId('project');
    const project = cloneValue(source ?? createBlankProject(readWorkingProject()));
    const meta: ProjectMeta = {
      id,
      name: name ?? `Skill Tree ${this.projects.length + 1}`,
      createdAt: now,
      updatedAt: now,
    };
    localStorage.setItem(projectKey(id), JSON.stringify(project));
    this.projects = [...this.projects, meta];
    writeIndex(this.projects);
    return { meta: cloneValue(meta), project };
  }

  renameProject(id: string, name: string) {
    this.projects = this.projects.map((item) => item.id === id ? { ...item, name, updatedAt: Date.now() } : item);
    writeIndex(this.projects);
  }

  deleteProject(id: string) {
    if (this.projects.length <= 1) throw new Error('At least one local project must remain.');
    localStorage.removeItem(projectKey(id));
    localStorage.removeItem(`${HISTORY_V3_PREFIX}local:${id}`);
    this.projects = this.projects.filter((item) => item.id !== id);
    writeIndex(this.projects);
  }
}
