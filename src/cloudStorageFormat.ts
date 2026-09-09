export const CLOUD_STORAGE_VERSION = 2 as const;
export const CLOUD_CHUNK_COLLECTION = 'chunks';

// Firestore documents are capped at 1 MiB. A JavaScript UTF-16 code unit can expand
// to at most three UTF-8 bytes on its own, so 180k code units leaves ample room for
// Firestore's field/document overhead while keeping chunks reasonably large.
export const CLOUD_CHUNK_CODE_UNIT_LIMIT = 180_000;

export const CLOUD_SEGMENT_KEYS = [
  'nodes',
  'edges',
  'stats',
  'currencies',
  'icons',
  'perks',
  'settings',
  'history',
] as const;

export type CloudSegmentKey = typeof CLOUD_SEGMENT_KEYS[number];

export type CloudSegmentRef = {
  generation: string;
  chunkCount: number;
};

export type CloudSegmentManifest = Record<CloudSegmentKey, CloudSegmentRef>;

export type StoredCloudRootV2 = {
  storageVersion: typeof CLOUD_STORAGE_VERSION;
  name: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  segments: CloudSegmentManifest;
  previousSegments?: CloudSegmentManifest;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseSegmentRef(value: unknown): CloudSegmentRef | null {
  if (!isRecord(value)) return null;
  if (typeof value.generation !== 'string' || !value.generation) return null;
  if (typeof value.chunkCount !== 'number' || !Number.isInteger(value.chunkCount) || value.chunkCount < 1) return null;
  return { generation: value.generation, chunkCount: value.chunkCount };
}

function parseManifest(value: unknown): CloudSegmentManifest | null {
  if (!isRecord(value)) return null;
  const result = {} as CloudSegmentManifest;
  for (const key of CLOUD_SEGMENT_KEYS) {
    const ref = parseSegmentRef(value[key]);
    if (!ref) return null;
    result[key] = ref;
  }
  return result;
}

export function parseStoredCloudRoot(raw: unknown): StoredCloudRootV2 | null {
  if (!isRecord(raw) || raw.storageVersion !== CLOUD_STORAGE_VERSION) return null;
  if (typeof raw.name !== 'string') return null;
  const segments = parseManifest(raw.segments);
  if (!segments) return null;
  const previousSegments = raw.previousSegments === undefined ? undefined : parseManifest(raw.previousSegments);
  if (raw.previousSegments !== undefined && !previousSegments) return null;
  return {
    storageVersion: CLOUD_STORAGE_VERSION,
    name: raw.name,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    segments,
    ...(previousSegments ? { previousSegments } : {}),
  };
}

export function splitCloudText(text: string) {
  if (!text.length) return [''];
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + CLOUD_CHUNK_CODE_UNIT_LIMIT);
    // Avoid storing an unpaired surrogate at a chunk boundary. Firestore converts
    // strings to UTF-8, so preserving surrogate pairs prevents replacement chars.
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export function cloudChunkDocumentId(segment: CloudSegmentKey, generation: string, index: number) {
  return `${segment}--${generation}--${index.toString().padStart(6, '0')}`;
}

export function cloneManifest(manifest: CloudSegmentManifest): CloudSegmentManifest {
  return Object.fromEntries(CLOUD_SEGMENT_KEYS.map((key) => [key, { ...manifest[key] }])) as CloudSegmentManifest;
}

export function manifestsEqual(left: CloudSegmentManifest, right: CloudSegmentManifest) {
  return CLOUD_SEGMENT_KEYS.every((key) =>
    left[key].generation === right[key].generation && left[key].chunkCount === right[key].chunkCount);
}

export function cloudSegmentForProjectKey(key: string): CloudSegmentKey | null {
  if (key === 'nodes' || key === 'edges' || key === 'stats' || key === 'currencies' || key === 'icons' || key === 'perks') {
    return key;
  }
  if (key === 'perkGridSize' || key === 'version') return 'settings';
  return null;
}

export function referencedChunkIds(root: StoredCloudRootV2) {
  const ids = new Set<string>();
  const manifests = root.previousSegments ? [root.segments, root.previousSegments] : [root.segments];
  for (const manifest of manifests) {
    for (const segment of CLOUD_SEGMENT_KEYS) {
      const ref = manifest[segment];
      for (let index = 0; index < ref.chunkCount; index += 1) {
        ids.add(cloudChunkDocumentId(segment, ref.generation, index));
      }
    }
  }
  return ids;
}
