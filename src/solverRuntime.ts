import { getHistoryProject, HISTORY_APPLY_EVENT, type HistoryApplyDetail } from './history';
import { cloneValue, diffProjects, isRecord, type CanonicalProject, type JsonRecord } from './projectData';
import { readWorkingProject } from './localProjectStore';
import './solver.css';

const WORKING_PROJECT_KEY = 'incremental-td-skill-tree:v2';
const NODE_SIZE = 62;
const NODE_RADIUS = 29;

type Point = { x: number; y: number };

type SolverNode = {
  id: string;
  name: string;
  x: number;
  y: number;
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  fx: number;
  fy: number;
  degree: number;
  radius: number;
  color: string;
  planarX?: number;
  planarY?: number;
  dragDX?: number;
  dragDY?: number;
};

type SolverEdge = {
  id: string;
  a: SolverNode;
  b: SolverNode;
  crossing: boolean;
  branchA: SolverNode[] | null;
  branchB: SolverNode[] | null;
};

type CrossingPair = {
  e1: SolverEdge;
  e2: SolverEdge;
  hit: { t: number; u: number; x: number; y: number };
};

type AdjacencyItem = { node: SolverNode; edgeIndex: number };
type BranchCandidate = { branch: SolverNode[]; dx: number; dy: number; move: number; cost: number };

type SolverParams = {
  ideal: number;
  spring: number;
  repulsion: number;
  crossing: number;
  edgeNode: number;
  damping: number;
};

type SolverUi = {
  host: HTMLElement;
  tab: HTMLButtonElement;
  canvas: HTMLCanvasElement;
  viewport: HTMLElement;
  reloadBtn: HTMLButtonElement;
  applyBtn: HTMLButtonElement;
  fitBtn: HTMLButtonElement;
  runBtn: HTMLButtonElement;
  stepBtn: HTMLButtonElement;
  resetBtn: HTMLButtonElement;
  statusDot: HTMLElement;
  nodeCount: HTMLElement;
  edgeCount: HTMLElement;
  crossingCount: HTMLElement;
  untangleValue: HTMLElement;
  speedValue: HTMLElement;
  stateValue: HTMLElement;
  sourceValue: HTMLElement;
  idealLength: HTMLInputElement;
  springStrength: HTMLInputElement;
  nodeRepulsion: HTMLInputElement;
  crossRepulsion: HTMLInputElement;
  edgeNodeRepulsion: HTMLInputElement;
  damping: HTMLInputElement;
  stepsPerFrame: HTMLInputElement;
  springValue: HTMLElement;
  repulsionValue: HTMLElement;
  crossValue: HTMLElement;
  edgeNodeValue: HTMLElement;
  dampingValue: HTMLElement;
  stepsValue: HTMLElement;
  showLabels: HTMLInputElement;
  showCrossings: HTMLInputElement;
  showVelocity: HTMLInputElement;
  toast: HTMLElement;
};

const sim = {
  sourceProject: null as CanonicalProject | null,
  nodes: [] as SolverNode[],
  nodeById: new Map<string, SolverNode>(),
  edges: [] as SolverEdge[],
  running: false,
  crossingPairs: [] as CrossingPair[],
  crossingsDirty: true,
  frame: 0,
  draggingNode: null as SolverNode | null,
  pan: { active: false, x: 0, y: 0, ox: 0, oy: 0 },
  camera: { scale: 0.1, x: 0, y: 0 },
  dpr: 1,
  adjacency: new Map<SolverNode, AdjacencyItem[]>(),
  isTree: false,
  treeRoot: null as SolverNode | null,
  baseIdeal: 500,
  bestCrossings: Number.POSITIVE_INFINITY,
  stagnantSteps: 0,
  escapeActive: false,
  stableSteps: 0,
  settled: false,
  lastMeanSpeed: 0,
  lastMaxSpeed: 0,
  toastTimer: 0,
  active: false,
  applying: false,
  ui: null as SolverUi | null,
  context: null as CanvasRenderingContext2D | null,
};

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function currentProject() {
  return getHistoryProject() ?? readWorkingProject();
}

function nodePosition(raw: JsonRecord): Point | null {
  if (!isRecord(raw.position)) return null;
  const x = finiteNumber(raw.position.x);
  const y = finiteNumber(raw.position.y);
  return x === null || y === null ? null : { x, y };
}

function nodeName(raw: JsonRecord) {
  if (!isRecord(raw.data) || typeof raw.data.name !== 'string') return String(raw.id ?? 'Skill');
  return raw.data.name;
}

function nodeColor(raw: JsonRecord) {
  if (isRecord(raw.data) && typeof raw.data.secondaryColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.data.secondaryColor)) {
    return raw.data.secondaryColor;
  }
  return '#2b323d';
}

function median(values: number[]) {
  if (!values.length) return 500;
  const ordered = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) * 0.5;
}

function loadProject(project = currentProject()) {
  const ui = sim.ui;
  if (!ui) return;

  sim.sourceProject = cloneValue(project);
  sim.nodes = [];
  sim.nodeById = new Map();

  for (const raw of project.nodes) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue;
    const position = nodePosition(raw);
    if (!position) continue;
    const node: SolverNode = {
      id: raw.id,
      name: nodeName(raw),
      x: position.x + NODE_SIZE / 2,
      y: position.y + NODE_SIZE / 2,
      x0: position.x + NODE_SIZE / 2,
      y0: position.y + NODE_SIZE / 2,
      vx: 0,
      vy: 0,
      fx: 0,
      fy: 0,
      degree: 0,
      radius: NODE_RADIUS,
      color: nodeColor(raw),
    };
    sim.nodes.push(node);
    sim.nodeById.set(node.id, node);
  }

  const lengths: number[] = [];
  sim.edges = [];
  for (let index = 0; index < project.edges.length; index += 1) {
    const raw = project.edges[index];
    if (!isRecord(raw)) continue;
    const source = typeof raw.source === 'string' ? raw.source : '';
    const target = typeof raw.target === 'string' ? raw.target : '';
    const a = sim.nodeById.get(source);
    const b = sim.nodeById.get(target);
    if (!a || !b || a === b) continue;
    const edge: SolverEdge = {
      id: typeof raw.id === 'string' ? raw.id : `${source}->${target}-${index}`,
      a,
      b,
      crossing: false,
      branchA: null,
      branchB: null,
    };
    sim.edges.push(edge);
    a.degree += 1;
    b.degree += 1;
    lengths.push(Math.hypot(b.x - a.x, b.y - a.y));
  }

  const ideal = median(lengths.filter(Number.isFinite));
  ui.idealLength.value = String(Math.max(20, Math.round(ideal / 10) * 10));
  buildTopologyHelpers(ideal);
  sim.running = false;
  sim.crossingsDirty = true;
  sim.bestCrossings = Number.POSITIVE_INFINITY;
  sim.stagnantSteps = 0;
  sim.escapeActive = false;
  sim.stableSteps = 0;
  sim.settled = false;
  sim.lastMeanSpeed = 0;
  sim.lastMaxSpeed = 0;
  detectCrossings();
  fitView();
  updateButtons();
  updateStats();
  ui.sourceValue.textContent = `${sim.nodes.length} skills loaded from the current project`;
  toast(`Loaded ${sim.nodes.length} skills and ${sim.edges.length} links${sim.isTree ? ' · tree-aware untangler enabled' : ''}.`);
}

function resetSimulation() {
  for (const node of sim.nodes) {
    node.x = node.x0;
    node.y = node.y0;
    node.vx = 0;
    node.vy = 0;
    node.fx = 0;
    node.fy = 0;
  }
  sim.running = false;
  sim.crossingsDirty = true;
  sim.bestCrossings = Number.POSITIVE_INFINITY;
  sim.stagnantSteps = 0;
  sim.escapeActive = false;
  sim.stableSteps = 0;
  sim.settled = false;
  sim.lastMeanSpeed = 0;
  sim.lastMaxSpeed = 0;
  detectCrossings();
  fitView();
  updateButtons();
  updateStats();
}

function hasPositionChanges() {
  return sim.nodes.some((node) => Math.abs(node.x - node.x0) > 0.001 || Math.abs(node.y - node.y0) > 0.001);
}

function applySolvedPositions() {
  const ui = sim.ui;
  if (!ui || !sim.sourceProject || !hasPositionChanges()) return;
  const before = currentProject();
  const after = cloneValue(before);
  const positions = new Map(sim.nodes.map((node) => [node.id, {
    x: Math.round((node.x - NODE_SIZE / 2) * 1000) / 1000,
    y: Math.round((node.y - NODE_SIZE / 2) * 1000) / 1000,
  }]));

  let applied = 0;
  for (const raw of after.nodes) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue;
    const position = positions.get(raw.id);
    if (!position) continue;
    raw.position = position;
    applied += 1;
  }

  const changes = diffProjects(before, after);
  if (!changes.length) {
    toast('The current project already matches the solver preview.');
    return;
  }

  sim.applying = true;
  try {
    localStorage.setItem(WORKING_PROJECT_KEY, JSON.stringify(after));
    window.dispatchEvent(new CustomEvent<HistoryApplyDetail>(HISTORY_APPLY_EVENT, {
      detail: { transitions: [{ direction: 'redo', changes }] },
    }));
    sim.sourceProject = cloneValue(after);
    for (const node of sim.nodes) {
      node.x0 = node.x;
      node.y0 = node.y;
      node.vx = 0;
      node.vy = 0;
    }
    sim.running = false;
    sim.settled = true;
    updateButtons();
    updateStats();
    toast(`Applied solver positions to ${applied} skill${applied === 1 ? '' : 's'}.`);
  } finally {
    window.setTimeout(() => { sim.applying = false; }, 0);
  }
}

function toast(message: string) {
  const ui = sim.ui;
  if (!ui) return;
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  window.clearTimeout(sim.toastTimer);
  sim.toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), 2600);
}

function params(): SolverParams {
  const ui = sim.ui!;
  return {
    ideal: Math.max(1, finiteNumber(ui.idealLength.value) ?? 500),
    spring: finiteNumber(ui.springStrength.value) ?? 0.01,
    repulsion: finiteNumber(ui.nodeRepulsion.value) ?? 4,
    crossing: finiteNumber(ui.crossRepulsion.value) ?? 80,
    edgeNode: finiteNumber(ui.edgeNodeRepulsion.value) ?? 18,
    damping: finiteNumber(ui.damping.value) ?? 0.72,
  };
}

function hashPair(a: string, b: string) {
  let hash = 2166136261 >>> 0;
  const value = a < b ? `${a}|${b}` : `${b}|${a}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function applyNodeRepulsion(p: SolverParams, compactMode: boolean) {
  const soft = p.ideal * 0.12;
  const soft2 = soft * soft;
  const scale2 = p.ideal * p.ideal;
  const cap = p.repulsion * 5 + 1;
  const range = p.ideal * 0.82;
  const range2 = range * range;
  const baseline = compactMode ? scale2 / (range2 + soft2) : 0;

  for (let i = 0; i < sim.nodes.length - 1; i += 1) {
    const a = sim.nodes[i];
    for (let j = i + 1; j < sim.nodes.length; j += 1) {
      const b = sim.nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distance2 = dx * dx + dy * dy;
      if (compactMode && distance2 >= range2) continue;
      if (distance2 < 1e-8) {
        const angle = (hashPair(a.id, b.id) % 6283) / 1000;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        distance2 = 1;
      }
      const distance = Math.sqrt(distance2);
      const raw = p.repulsion * (scale2 / (distance2 + soft2) - baseline);
      const force = Math.min(cap, Math.max(0, raw));
      if (force <= 0) continue;
      const fx = force * dx / distance;
      const fy = force * dy / distance;
      a.fx -= fx;
      a.fy -= fy;
      b.fx += fx;
      b.fy += fy;
    }
  }
}

function applyNodeEdgeRepulsion(p: SolverParams) {
  if (!p.edgeNode || !sim.edges.length) return;
  for (const edge of sim.edges) {
    const ax = edge.a.x;
    const ay = edge.a.y;
    const ex = edge.b.x - ax;
    const ey = edge.b.y - ay;
    const length2 = ex * ex + ey * ey;
    if (length2 < 1e-8) continue;

    for (const node of sim.nodes) {
      if (node === edge.a || node === edge.b) continue;
      const rawT = ((node.x - ax) * ex + (node.y - ay) * ey) / length2;
      if (rawT <= 0.04 || rawT >= 0.96) continue;
      const t = Math.max(0, Math.min(1, rawT));
      const px = ax + ex * t;
      const py = ay + ey * t;
      let dx = node.x - px;
      let dy = node.y - py;
      const distance2 = dx * dx + dy * dy;
      const clearance = Math.max(node.radius * 2.25, p.ideal * 0.18);
      if (distance2 >= clearance * clearance) continue;

      let distance = Math.sqrt(distance2);
      if (distance < 1e-6) {
        const length = Math.sqrt(length2);
        const sign = (hashPair(node.id, edge.id) & 1) ? 1 : -1;
        dx = -ey / length * sign;
        dy = ex / length * sign;
        distance = 1;
      }

      const q = 1 - Math.min(1, distance / clearance);
      const magnitude = p.edgeNode * q * q;
      const fx = magnitude * dx / distance;
      const fy = magnitude * dy / distance;
      node.fx += fx;
      node.fy += fy;
      edge.a.fx -= fx * (1 - t);
      edge.a.fy -= fy * (1 - t);
      edge.b.fx -= fx * t;
      edge.b.fy -= fy * t;
    }
  }
}

function applyEdgeSprings(p: SolverParams, compactMode: boolean) {
  for (const edge of sim.edges) {
    const dx = edge.b.x - edge.a.x;
    const dy = edge.b.y - edge.a.y;
    const distance = Math.hypot(dx, dy) || 1e-6;
    const error = distance - p.ideal;
    const stretch = compactMode && error > 0 ? Math.min(1.5, error / Math.max(1, p.ideal)) : 0;
    const force = p.spring * error * (1 + 1.6 * stretch);
    const fx = force * dx / distance;
    const fy = force * dy / distance;
    edge.a.fx += fx;
    edge.a.fy += fy;
    edge.b.fx -= fx;
    edge.b.fy -= fy;
  }
}

function buildTopologyHelpers(baseIdeal: number) {
  sim.baseIdeal = Math.max(1, Number.isFinite(baseIdeal) ? baseIdeal : 500);
  sim.isTree = false;
  sim.treeRoot = null;
  sim.adjacency = new Map(sim.nodes.map((node) => [node, [] as AdjacencyItem[]]));

  sim.edges.forEach((edge, edgeIndex) => {
    sim.adjacency.get(edge.a)?.push({ node: edge.b, edgeIndex });
    sim.adjacency.get(edge.b)?.push({ node: edge.a, edgeIndex });
    edge.branchA = null;
    edge.branchB = null;
  });

  if (!sim.nodes.length) return;
  const seen = new Set<SolverNode>();
  const stack = [sim.nodes[0]];
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const item of sim.adjacency.get(node) ?? []) {
      if (!seen.has(item.node)) stack.push(item.node);
    }
  }

  sim.isTree = seen.size === sim.nodes.length && sim.edges.length === sim.nodes.length - 1;
  if (!sim.isTree) return;

  function collectBranch(start: SolverNode, blockedEdgeIndex: number) {
    const output: SolverNode[] = [];
    const visited = new Set<SolverNode>([start]);
    const work = [start];
    while (work.length) {
      const node = work.pop()!;
      output.push(node);
      for (const item of sim.adjacency.get(node) ?? []) {
        if (item.edgeIndex === blockedEdgeIndex || visited.has(item.node)) continue;
        visited.add(item.node);
        work.push(item.node);
      }
    }
    return output;
  }

  sim.edges.forEach((edge, index) => {
    edge.branchA = collectBranch(edge.a, index);
    edge.branchB = collectBranch(edge.b, index);
  });

  let root = sim.nodes[0];
  let rootDistance2 = root.x0 * root.x0 + root.y0 * root.y0;
  for (const node of sim.nodes) {
    const distance2 = node.x0 * node.x0 + node.y0 * node.y0;
    if (distance2 < rootDistance2) {
      root = node;
      rootDistance2 = distance2;
    }
  }
  sim.treeRoot = root;

  const parent = new Map<SolverNode, SolverNode | null>([[root, null]]);
  const depth = new Map<SolverNode, number>([[root, 0]]);
  const children = new Map<SolverNode, SolverNode[]>(sim.nodes.map((node) => [node, []]));
  const order = [root];

  for (let index = 0; index < order.length; index += 1) {
    const node = order[index];
    const candidates = (sim.adjacency.get(node) ?? [])
      .map((item) => item.node)
      .filter((candidate) => candidate !== parent.get(node) && !parent.has(candidate));
    candidates.sort((left, right) =>
      Math.atan2(left.y0 - node.y0, left.x0 - node.x0) - Math.atan2(right.y0 - node.y0, right.x0 - node.x0));
    for (const child of candidates) {
      parent.set(child, node);
      depth.set(child, (depth.get(node) ?? 0) + 1);
      children.get(node)?.push(child);
      order.push(child);
    }
  }

  const leafWeight = new Map<SolverNode, number>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const node = order[index];
    const nodeChildren = children.get(node) ?? [];
    leafWeight.set(node, nodeChildren.length
      ? nodeChildren.reduce((sum, child) => sum + (leafWeight.get(child) ?? 1), 0)
      : 1);
  }

  const angle = new Map<SolverNode, number>();
  const assignSector = (node: SolverNode, a0: number, a1: number): void => {
    const nodeChildren = children.get(node) ?? [];
    if (!nodeChildren.length) {
      angle.set(node, (a0 + a1) * 0.5);
      return;
    }
    const total = nodeChildren.reduce((sum, child) => sum + (leafWeight.get(child) ?? 1), 0);
    let cursor = a0;
    let weightedAngle = 0;
    let weightedTotal = 0;
    for (const child of nodeChildren) {
      const weight = leafWeight.get(child) ?? 1;
      const span = (a1 - a0) * weight / total;
      assignSector(child, cursor, cursor + span);
      weightedAngle += (angle.get(child) ?? 0) * weight;
      weightedTotal += weight;
      cursor += span;
    }
    angle.set(node, weightedAngle / Math.max(1, weightedTotal));
  };
  assignSector(root, -Math.PI, Math.PI);

  const planarQ = new Map<SolverNode, Point>();
  let meanQx = 0;
  let meanQy = 0;
  let meanPx = 0;
  let meanPy = 0;
  for (const node of sim.nodes) {
    const radius = depth.get(node) ?? 0;
    const nodeAngle = angle.get(node) ?? 0;
    const q = { x: radius * Math.cos(nodeAngle), y: radius * Math.sin(nodeAngle) };
    planarQ.set(node, q);
    meanQx += q.x;
    meanQy += q.y;
    meanPx += node.x0;
    meanPy += node.y0;
  }
  const inverseCount = 1 / sim.nodes.length;
  meanQx *= inverseCount;
  meanQy *= inverseCount;
  meanPx *= inverseCount;
  meanPy *= inverseCount;

  let dot = 0;
  let cross = 0;
  let denominator = 0;
  for (const node of sim.nodes) {
    const q = planarQ.get(node)!;
    const qx = q.x - meanQx;
    const qy = q.y - meanQy;
    const px = node.x0 - meanPx;
    const py = node.y0 - meanPy;
    dot += qx * px + qy * py;
    cross += qx * py - qy * px;
    denominator += qx * qx + qy * qy;
  }
  const norm = Math.hypot(dot, cross) || 1;
  const cosine = dot / norm;
  const sine = cross / norm;
  const scale = norm / Math.max(1e-9, denominator);

  for (const node of sim.nodes) {
    const q = planarQ.get(node)!;
    const qx = q.x - meanQx;
    const qy = q.y - meanQy;
    node.planarX = meanPx + scale * (cosine * qx - sine * qy);
    node.planarY = meanPy + scale * (sine * qx + cosine * qy);
  }

  const shiftX = root.x0 - (root.planarX ?? root.x0);
  const shiftY = root.y0 - (root.planarY ?? root.y0);
  for (const node of sim.nodes) {
    node.planarX = (node.planarX ?? node.x0) + shiftX;
    node.planarY = (node.planarY ?? node.y0) + shiftY;
  }
}

function signedDistanceToLine(point: Point, c: Point, d: Point) {
  const dx = d.x - c.x;
  const dy = d.y - c.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  return { distance: (point.x - c.x) * nx + (point.y - c.y) * ny, nx, ny };
}

function makeBranchCandidate(edge: SolverEdge, movingA: boolean, obstacle: SolverEdge, p: SolverParams): BranchCandidate | null {
  const moving = movingA ? edge.a : edge.b;
  const pivot = movingA ? edge.b : edge.a;
  const branch = movingA ? edge.branchA : edge.branchB;
  if (!branch?.length || (sim.draggingNode && branch.includes(sim.draggingNode))) return null;

  const movingSide = signedDistanceToLine(moving, obstacle.a, obstacle.b);
  const pivotSide = signedDistanceToLine(pivot, obstacle.a, obstacle.b);
  const side = pivotSide.distance >= 0 ? 1 : -1;
  const clearance = Math.max(p.ideal * 0.06, Math.min(Math.abs(pivotSide.distance) * 0.3, p.ideal * 0.14));
  const delta = side * clearance - movingSide.distance;
  const move = Math.abs(delta);
  return {
    branch,
    dx: movingSide.nx * delta,
    dy: movingSide.ny * delta,
    move,
    cost: branch.length * (0.25 + move / Math.max(1, p.ideal)),
  };
}

function applyPlanarEscape(p: SolverParams) {
  if (!sim.isTree || !sim.treeRoot || !sim.escapeActive) return;
  const root = sim.treeRoot;
  const ratio = p.ideal / Math.max(1, sim.baseIdeal);
  const alpha = Math.min(0.06, 0.01 + p.crossing * 0.0001875);
  for (const node of sim.nodes) {
    if (node === sim.draggingNode) continue;
    const targetX = root.x0 + ((node.planarX ?? node.x0) - root.x0) * ratio;
    const targetY = root.y0 + ((node.planarY ?? node.y0) - root.y0) * ratio;
    node.x += (targetX - node.x) * alpha;
    node.y += (targetY - node.y) * alpha;
    node.vx *= 0.8;
    node.vy *= 0.8;
  }
}

function cross2(ax: number, ay: number, bx: number, by: number) {
  return ax * by - ay * bx;
}

function segmentIntersection(e1: SolverEdge, e2: SolverEdge) {
  const { a, b } = e1;
  const { a: c, b: d } = e2;
  if (a === c || a === d || b === c || b === d) return null;
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = cross2(rx, ry, sx, sy);
  if (Math.abs(denominator) < 1e-10) return null;
  const qpx = c.x - a.x;
  const qpy = c.y - a.y;
  const t = cross2(qpx, qpy, sx, sy) / denominator;
  const u = cross2(qpx, qpy, rx, ry) / denominator;
  const epsilon = 1e-6;
  if (t <= epsilon || t >= 1 - epsilon || u <= epsilon || u >= 1 - epsilon) return null;
  return { t, u, x: a.x + t * rx, y: a.y + t * ry };
}

function detectCrossings() {
  sim.crossingPairs = [];
  for (const edge of sim.edges) edge.crossing = false;
  for (let i = 0; i < sim.edges.length - 1; i += 1) {
    const e1 = sim.edges[i];
    for (let j = i + 1; j < sim.edges.length; j += 1) {
      const e2 = sim.edges[j];
      if (e1.a === e2.a || e1.a === e2.b || e1.b === e2.a || e1.b === e2.b) continue;
      const hit = segmentIntersection(e1, e2);
      if (!hit) continue;
      e1.crossing = true;
      e2.crossing = true;
      sim.crossingPairs.push({ e1, e2, hit });
    }
  }
  sim.crossingsDirty = false;
  return sim.crossingPairs;
}

function applyCrossingForces(p: SolverParams, pairs = detectCrossings()) {
  const crossingCount = pairs.length;
  if (!crossingCount) {
    sim.bestCrossings = Number.POSITIVE_INFINITY;
    sim.stagnantSteps = 0;
    sim.escapeActive = false;
    return;
  }
  if (crossingCount < sim.bestCrossings) {
    sim.bestCrossings = crossingCount;
    sim.stagnantSteps = 0;
  } else {
    sim.stagnantSteps += 1;
  }
  if (sim.isTree && sim.stagnantSteps > 55) sim.escapeActive = true;
  if (!p.crossing) return;

  if (sim.isTree) {
    let best: BranchCandidate | null = null;
    for (const pair of pairs) {
      const candidates = [
        makeBranchCandidate(pair.e1, true, pair.e2, p),
        makeBranchCandidate(pair.e1, false, pair.e2, p),
        makeBranchCandidate(pair.e2, true, pair.e1, p),
        makeBranchCandidate(pair.e2, false, pair.e1, p),
      ];
      for (const candidate of candidates) {
        if (candidate && (!best || candidate.cost < best.cost)) best = candidate;
      }
    }
    if (best) {
      const strength = Math.min(1.05, 0.15 + (p.crossing / 80) * 0.9);
      const dx = best.dx * strength;
      const dy = best.dy * strength;
      const kick = Math.min(0.035, 0.01 + p.crossing * 0.000125);
      for (const node of best.branch) {
        if (node === sim.draggingNode) continue;
        node.x += dx;
        node.y += dy;
        node.vx += dx * kick;
        node.vy += dy * kick;
      }
    }
    applyPlanarEscape(p);
    return;
  }

  for (const pair of pairs) {
    const a = pair.e1.a;
    const b = pair.e1.b;
    const c = pair.e2.a;
    const d = pair.e2.b;
    const r1x = b.x - a.x;
    const r1y = b.y - a.y;
    const r2x = d.x - c.x;
    const r2y = d.y - c.y;
    const l1 = Math.hypot(r1x, r1y) || 1;
    const l2 = Math.hypot(r2x, r2y) || 1;
    const n1x = -r1y / l1;
    const n1y = r1x / l1;
    const n2x = -r2y / l2;
    const n2y = r2x / l2;
    const da = (a.x - c.x) * n2x + (a.y - c.y) * n2y;
    const db = (b.x - c.x) * n2x + (b.y - c.y) * n2y;
    const dc = (c.x - a.x) * n1x + (c.y - a.y) * n1y;
    const dd = (d.x - a.x) * n1x + (d.y - a.y) * n1y;
    const candidates = [
      { node: a, distance: Math.abs(da), fx: -Math.sign(da || 1) * n2x, fy: -Math.sign(da || 1) * n2y },
      { node: b, distance: Math.abs(db), fx: -Math.sign(db || 1) * n2x, fy: -Math.sign(db || 1) * n2y },
      { node: c, distance: Math.abs(dc), fx: -Math.sign(dc || 1) * n1x, fy: -Math.sign(dc || 1) * n1y },
      { node: d, distance: Math.abs(dd), fx: -Math.sign(dd || 1) * n1x, fy: -Math.sign(dd || 1) * n1y },
    ];
    let best = candidates[0];
    for (let index = 1; index < candidates.length; index += 1) {
      if (candidates[index].distance < best.distance) best = candidates[index];
    }
    const magnitude = p.crossing + Math.min(p.crossing, best.distance * 0.35);
    best.node.fx += best.fx * magnitude;
    best.node.fy += best.fy * magnitude;
  }
}

function physicsStep() {
  if (!sim.nodes.length || sim.settled) return;
  const p = params();
  const pairsAtStart = detectCrossings();
  const compactMode = pairsAtStart.length === 0 && !sim.escapeActive;

  for (const node of sim.nodes) {
    node.fx = 0;
    node.fy = 0;
  }
  applyNodeRepulsion(p, compactMode);
  if (compactMode) applyNodeEdgeRepulsion(p);
  applyEdgeSprings(p, compactMode);
  applyCrossingForces(p, pairsAtStart);
  const hadCrossings = sim.crossingPairs.length > 0;

  if (sim.escapeActive) {
    for (const node of sim.nodes) {
      node.fx *= 0.18;
      node.fy *= 0.18;
    }
  }

  const maximumSpeed = Math.max(12, p.ideal * 0.09);
  const effectiveDamping = compactMode ? Math.min(p.damping, 0.62) : p.damping;
  let totalSpeed = 0;
  let peakSpeed = 0;
  for (const node of sim.nodes) {
    if (node === sim.draggingNode) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx = (node.vx + node.fx) * effectiveDamping;
    node.vy = (node.vy + node.fy) * effectiveDamping;
    let speed = Math.hypot(node.vx, node.vy);
    if (speed > maximumSpeed) {
      const ratio = maximumSpeed / speed;
      node.vx *= ratio;
      node.vy *= ratio;
      speed = maximumSpeed;
    }
    node.x += node.vx;
    node.y += node.vy;
    totalSpeed += speed;
    peakSpeed = Math.max(peakSpeed, speed);
  }
  sim.lastMeanSpeed = totalSpeed / Math.max(1, sim.nodes.length);
  sim.lastMaxSpeed = peakSpeed;
  sim.crossingsDirty = true;

  if (compactMode && !hadCrossings && !sim.escapeActive && !sim.draggingNode) {
    const meanThreshold = Math.max(0.05, p.ideal * 0.00055);
    const peakThreshold = Math.max(0.18, p.ideal * 0.0019);
    if (sim.lastMeanSpeed <= meanThreshold && sim.lastMaxSpeed <= peakThreshold) sim.stableSteps += 1;
    else sim.stableSteps = Math.max(0, sim.stableSteps - 2);

    if (sim.stableSteps >= 75) {
      for (const node of sim.nodes) {
        node.vx = 0;
        node.vy = 0;
      }
      sim.lastMeanSpeed = 0;
      sim.lastMaxSpeed = 0;
      sim.settled = true;
      sim.running = false;
      updateButtons();
      toast('Simulation stabilized and entered homeostasis.');
    }
  } else {
    sim.stableSteps = 0;
  }
}

function resize() {
  const ui = sim.ui;
  if (!ui) return;
  const rect = ui.viewport.getBoundingClientRect();
  sim.dpr = Math.min(2, window.devicePixelRatio || 1);
  ui.canvas.width = Math.max(1, Math.round(rect.width * sim.dpr));
  ui.canvas.height = Math.max(1, Math.round(rect.height * sim.dpr));
  ui.canvas.style.width = `${rect.width}px`;
  ui.canvas.style.height = `${rect.height}px`;
}

function worldToScreen(x: number, y: number) {
  return { x: x * sim.camera.scale + sim.camera.x, y: y * sim.camera.scale + sim.camera.y };
}

function screenToWorld(x: number, y: number) {
  return { x: (x - sim.camera.x) / sim.camera.scale, y: (y - sim.camera.y) / sim.camera.scale };
}

function fitView() {
  const ui = sim.ui;
  if (!ui || !sim.nodes.length) return;
  const rect = ui.viewport.getBoundingClientRect();
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of sim.nodes) {
    minX = Math.min(minX, node.x - NODE_SIZE / 2);
    maxX = Math.max(maxX, node.x + NODE_SIZE / 2);
    minY = Math.min(minY, node.y - NODE_SIZE / 2);
    maxY = Math.max(maxY, node.y + NODE_SIZE / 2);
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const margin = 60;
  sim.camera.scale = Math.max(0.002, Math.min(4, Math.min(
    Math.max(1, rect.width - margin * 2) / width,
    Math.max(1, rect.height - margin * 2) / height,
  )));
  sim.camera.x = rect.width * 0.5 - (minX + maxX) * 0.5 * sim.camera.scale;
  sim.camera.y = rect.height * 0.5 - (minY + maxY) * 0.5 * sim.camera.scale;
}

function render() {
  const ui = sim.ui;
  const context = sim.context;
  if (!ui || !context || !sim.active) return;
  const rect = ui.viewport.getBoundingClientRect();
  context.setTransform(sim.dpr, 0, 0, sim.dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  if (!sim.nodes.length) {
    context.fillStyle = '#8a93a3';
    context.font = '14px system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText('The current project has no positioned skill nodes.', rect.width / 2, rect.height / 2);
    return;
  }

  if (sim.crossingsDirty && (!sim.running || sim.frame % 2 === 0)) detectCrossings();

  context.save();
  context.translate(sim.camera.x, sim.camera.y);
  context.scale(sim.camera.scale, sim.camera.scale);
  context.lineCap = 'round';

  const normalWidth = Math.max(1 / sim.camera.scale, 2);
  const crossingWidth = Math.max(1.6 / sim.camera.scale, 3.5);
  for (const edge of sim.edges) {
    context.beginPath();
    context.moveTo(edge.a.x, edge.a.y);
    context.lineTo(edge.b.x, edge.b.y);
    const hot = ui.showCrossings.checked && edge.crossing;
    context.strokeStyle = hot ? '#ff6b72' : '#49515d';
    context.globalAlpha = hot ? 0.95 : 0.72;
    context.lineWidth = hot ? crossingWidth : normalWidth;
    context.stroke();
  }
  context.globalAlpha = 1;

  if (ui.showVelocity.checked) {
    context.strokeStyle = '#8ab4ff';
    context.lineWidth = Math.max(1 / sim.camera.scale, 2);
    for (const node of sim.nodes) {
      context.beginPath();
      context.moveTo(node.x, node.y);
      context.lineTo(node.x + node.vx * 4, node.y + node.vy * 4);
      context.stroke();
    }
  }

  for (const node of sim.nodes) {
    const gradient = context.createRadialGradient(
      node.x - 7,
      node.y - 9,
      3,
      node.x,
      node.y,
      NODE_RADIUS,
    );
    gradient.addColorStop(0, node === sim.draggingNode ? '#e6ebf0' : '#313946');
    gradient.addColorStop(0.58, node === sim.draggingNode ? '#bec7d0' : '#1b222c');
    gradient.addColorStop(1, node === sim.draggingNode ? '#929da9' : '#11161d');
    context.beginPath();
    context.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2);
    context.fillStyle = gradient;
    context.fill();
    context.lineWidth = Math.max(1 / sim.camera.scale, 1.25);
    context.strokeStyle = node === sim.draggingNode ? '#b6ff56' : '#535d6a';
    context.stroke();

    if (node.color !== '#2b323d') {
      context.beginPath();
      context.arc(node.x, node.y, 4.5, 0, Math.PI * 2);
      context.fillStyle = node.color;
      context.fill();
    }
  }

  if (ui.showLabels.checked && sim.camera.scale > 0.06) {
    const fontSize = Math.max(11 / sim.camera.scale, 13);
    context.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillStyle = '#e6edf5';
    context.strokeStyle = 'rgba(7,9,12,.92)';
    context.lineWidth = Math.max(3 / sim.camera.scale, 4);
    for (const node of sim.nodes) {
      const y = node.y + NODE_SIZE / 2 + 7 / sim.camera.scale;
      context.strokeText(node.name, node.x, y);
      context.fillText(node.name, node.x, y);
    }
  }
  context.restore();

  if (ui.showCrossings.checked) {
    context.fillStyle = '#ff6b72';
    for (const pair of sim.crossingPairs) {
      const point = worldToScreen(pair.hit.x, pair.hit.y);
      context.beginPath();
      context.arc(point.x, point.y, 3.2, 0, Math.PI * 2);
      context.fill();
    }
  }
}

function updateButtons() {
  const ui = sim.ui;
  if (!ui) return;
  const loaded = Boolean(sim.sourceProject && sim.nodes.length);
  ui.fitBtn.disabled = !loaded;
  ui.runBtn.disabled = !loaded;
  ui.stepBtn.disabled = !loaded;
  ui.resetBtn.disabled = !loaded;
  ui.applyBtn.disabled = !loaded || !hasPositionChanges();
  ui.runBtn.textContent = sim.running ? 'Pause' : 'Run';
  ui.statusDot.classList.toggle('running', sim.running);
}

function updateStats() {
  const ui = sim.ui;
  if (!ui) return;
  ui.nodeCount.textContent = String(sim.nodes.length);
  ui.edgeCount.textContent = String(sim.edges.length);
  ui.crossingCount.textContent = String(sim.crossingPairs.length);
  ui.untangleValue.textContent = !sim.isTree ? 'Generic' : sim.escapeActive ? 'Global escape' : sim.crossingPairs.length ? 'Local branches' : 'Idle';
  ui.speedValue.textContent = sim.nodes.length ? sim.lastMeanSpeed.toFixed(2) : '0.00';
  ui.stateValue.textContent = sim.settled ? 'Homeostasis' : sim.running ? (sim.crossingPairs.length ? 'Untangling' : 'Settling') : 'Paused';
  ui.statusDot.classList.toggle('crossing', !sim.running && sim.crossingPairs.length > 0);
  ui.statusDot.classList.toggle('running', sim.running);
  updateButtons();
}

function loop() {
  sim.frame += 1;
  if (sim.active && sim.running) {
    const steps = Math.max(1, Math.round(finiteNumber(sim.ui?.stepsPerFrame.value) ?? 2));
    for (let index = 0; index < steps && sim.running; index += 1) physicsStep();
  }
  if (sim.active && sim.crossingsDirty && (sim.running ? sim.frame % 2 === 0 : true)) detectCrossings();
  if (sim.active && sim.frame % 4 === 0) updateStats();
  render();
  window.requestAnimationFrame(loop);
}

function nodeAtScreen(screenX: number, screenY: number) {
  const world = screenToWorld(screenX, screenY);
  const pickRadius = 12 / sim.camera.scale;
  let best: SolverNode | null = null;
  let bestDistance2 = Number.POSITIVE_INFINITY;
  for (const node of sim.nodes) {
    const dx = world.x - node.x;
    const dy = world.y - node.y;
    const radius = Math.max(node.radius, pickRadius);
    const distance2 = dx * dx + dy * dy;
    if (distance2 <= radius * radius && distance2 < bestDistance2) {
      best = node;
      bestDistance2 = distance2;
    }
  }
  return best;
}

function canvasPoint(event: PointerEvent | WheelEvent) {
  const canvas = sim.ui!.canvas;
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function syncControlLabels() {
  const ui = sim.ui;
  if (!ui) return;
  ui.springValue.textContent = (finiteNumber(ui.springStrength.value) ?? 0).toFixed(3);
  ui.repulsionValue.textContent = ui.nodeRepulsion.value;
  ui.crossValue.textContent = ui.crossRepulsion.value;
  ui.edgeNodeValue.textContent = ui.edgeNodeRepulsion.value;
  ui.dampingValue.textContent = (finiteNumber(ui.damping.value) ?? 0).toFixed(2);
  ui.stepsValue.textContent = ui.stepsPerFrame.value;
}

function activateSolver() {
  if (!sim.ui) return;
  sim.active = true;
  document.body.classList.add('solver-active');
  sim.ui.host.hidden = false;
  sim.ui.tab.classList.add('active');
  sim.ui.tab.setAttribute('aria-selected', 'true');
  loadProject();
  resize();
  window.requestAnimationFrame(() => {
    resize();
    fitView();
    render();
  });
}

function deactivateSolver() {
  if (!sim.ui || !sim.active) return;
  sim.active = false;
  sim.running = false;
  sim.draggingNode = null;
  sim.pan.active = false;
  document.body.classList.remove('solver-active');
  sim.ui.host.hidden = true;
  sim.ui.tab.classList.remove('active');
  sim.ui.tab.setAttribute('aria-selected', 'false');
  updateButtons();
}

function solverMarkup() {
  return `
    <aside class="solver-sidebar">
      <div class="solver-heading">
        <span class="section-kicker">LAYOUT TOOL</span>
        <h2>Physics Solver</h2>
        <p>Untangle the current skill tree in memory, then explicitly apply the preview when you are satisfied.</p>
      </div>

      <section class="solver-section solver-stack">
        <div class="solver-buttons">
          <button type="button" data-solver="reload">Reload tree</button>
          <button type="button" data-solver="fit">Fit view</button>
        </div>
        <button type="button" class="solver-apply" data-solver="apply" disabled>Apply positions to skill tree</button>
        <div class="solver-help" data-solver="source">Current skill tree not loaded yet.</div>
        <div class="solver-help solver-warning">Until you click Apply positions, solver motion and manual dragging are preview-only and are never persisted.</div>
      </section>

      <section class="solver-section">
        <div class="solver-section-title"><span class="solver-status-dot" data-solver="status-dot"></span>Simulation</div>
        <div class="solver-buttons three">
          <button type="button" class="solver-run" data-solver="run">Run</button>
          <button type="button" data-solver="step">Step</button>
          <button type="button" data-solver="reset">Reset</button>
        </div>
        <div class="solver-stats">
          <span>Nodes</span><b data-solver="node-count">0</b>
          <span>Edges</span><b data-solver="edge-count">0</b>
          <span>Crossings</span><b data-solver="crossing-count">0</b>
          <span>Untangler</span><b data-solver="untangle">Idle</b>
          <span>Mean speed</span><b data-solver="speed">0.00</b>
          <span>State</span><b data-solver="state">Paused</b>
        </div>
      </section>

      <section class="solver-section">
        <div class="solver-section-title">Forces</div>
        <label class="solver-number-row"><span>Ideal edge length</span><input data-solver="ideal-length" type="number" min="1" step="10" value="500"></label>
        <label class="solver-control"><span>Edge spring strength</span><span class="solver-value" data-solver="spring-value"></span><input data-solver="spring" type="range" min="0" max="0.12" step="0.001" value="0.010"></label>
        <label class="solver-control"><span>Node repulsion</span><span class="solver-value" data-solver="repulsion-value"></span><input data-solver="repulsion" type="range" min="0" max="80" step="1" value="4"></label>
        <label class="solver-control"><span>Crossing repulsion</span><span class="solver-value" data-solver="cross-value"></span><input data-solver="cross" type="range" min="0" max="250" step="1" value="80"></label>
        <label class="solver-control"><span>Node ↔ edge repulsion</span><span class="solver-value" data-solver="edge-node-value"></span><input data-solver="edge-node" type="range" min="0" max="80" step="1" value="18"></label>
        <label class="solver-control"><span>Velocity damping</span><span class="solver-value" data-solver="damping-value"></span><input data-solver="damping" type="range" min="0.5" max="0.98" step="0.01" value="0.72"></label>
        <label class="solver-control"><span>Steps per frame</span><span class="solver-value" data-solver="steps-value"></span><input data-solver="steps" type="range" min="1" max="8" step="1" value="2"></label>
      </section>

      <section class="solver-section">
        <div class="solver-section-title">View</div>
        <label class="solver-check"><input data-solver="show-labels" type="checkbox" checked> Show node names</label>
        <label class="solver-check"><input data-solver="show-crossings" type="checkbox" checked> Highlight intersecting edges</label>
        <label class="solver-check"><input data-solver="show-velocity" type="checkbox"> Show velocity vectors</label>
        <p class="solver-help">Drag a node with left mouse. Drag empty space to pan. Wheel to zoom. The solver uses 62×62 skill-node footprints with the same 29 px visual radius as the Skill tree tab. Unrelated edge interiors repel nearby nodes, distant node forces are bounded after planarity, and the simulation sleeps after sustained homeostasis.</p>
      </section>
    </aside>
    <div class="solver-viewport" data-solver="viewport">
      <canvas data-solver="canvas"></canvas>
      <div class="solver-canvas-badge">Preview only · current skill tree remains unchanged until Apply positions</div>
      <div class="solver-toast" data-solver="toast"></div>
    </div>`;
}

function requiredElement<T extends Element>(root: ParentNode, selector: string) {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing solver element: ${selector}`);
  return element;
}

function installSolverUi() {
  if (sim.ui) return true;
  const shell = document.querySelector<HTMLElement>('.app-shell');
  const nav = document.querySelector<HTMLElement>('.view-switcher');
  if (!shell || !nav) return false;

  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'solver-tab-button';
  tab.setAttribute('aria-selected', 'false');
  tab.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2.2"></circle><circle cx="12" cy="5" r="2.2"></circle><circle cx="19" cy="14" r="2.2"></circle><path d="M6.8 10.7 10.3 6.6M13.9 6.1l3.4 6M7 12.4l9.8 1.2"></path></svg><span>Solver</span>`;
  nav.appendChild(tab);

  const host = document.createElement('section');
  host.className = 'solver-view';
  host.hidden = true;
  host.innerHTML = solverMarkup();
  shell.appendChild(host);

  const canvas = requiredElement<HTMLCanvasElement>(host, '[data-solver="canvas"]');
  const context = canvas.getContext('2d');
  if (!context) return false;

  sim.context = context;
  sim.ui = {
    host,
    tab,
    canvas,
    viewport: requiredElement(host, '[data-solver="viewport"]'),
    reloadBtn: requiredElement(host, '[data-solver="reload"]'),
    applyBtn: requiredElement(host, '[data-solver="apply"]'),
    fitBtn: requiredElement(host, '[data-solver="fit"]'),
    runBtn: requiredElement(host, '[data-solver="run"]'),
    stepBtn: requiredElement(host, '[data-solver="step"]'),
    resetBtn: requiredElement(host, '[data-solver="reset"]'),
    statusDot: requiredElement(host, '[data-solver="status-dot"]'),
    nodeCount: requiredElement(host, '[data-solver="node-count"]'),
    edgeCount: requiredElement(host, '[data-solver="edge-count"]'),
    crossingCount: requiredElement(host, '[data-solver="crossing-count"]'),
    untangleValue: requiredElement(host, '[data-solver="untangle"]'),
    speedValue: requiredElement(host, '[data-solver="speed"]'),
    stateValue: requiredElement(host, '[data-solver="state"]'),
    sourceValue: requiredElement(host, '[data-solver="source"]'),
    idealLength: requiredElement(host, '[data-solver="ideal-length"]'),
    springStrength: requiredElement(host, '[data-solver="spring"]'),
    nodeRepulsion: requiredElement(host, '[data-solver="repulsion"]'),
    crossRepulsion: requiredElement(host, '[data-solver="cross"]'),
    edgeNodeRepulsion: requiredElement(host, '[data-solver="edge-node"]'),
    damping: requiredElement(host, '[data-solver="damping"]'),
    stepsPerFrame: requiredElement(host, '[data-solver="steps"]'),
    springValue: requiredElement(host, '[data-solver="spring-value"]'),
    repulsionValue: requiredElement(host, '[data-solver="repulsion-value"]'),
    crossValue: requiredElement(host, '[data-solver="cross-value"]'),
    edgeNodeValue: requiredElement(host, '[data-solver="edge-node-value"]'),
    dampingValue: requiredElement(host, '[data-solver="damping-value"]'),
    stepsValue: requiredElement(host, '[data-solver="steps-value"]'),
    showLabels: requiredElement(host, '[data-solver="show-labels"]'),
    showCrossings: requiredElement(host, '[data-solver="show-crossings"]'),
    showVelocity: requiredElement(host, '[data-solver="show-velocity"]'),
    toast: requiredElement(host, '[data-solver="toast"]'),
  };

  const ui = sim.ui;
  tab.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    activateSolver();
  });

  nav.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest('button');
    if (button && button !== tab) deactivateSolver();
  });

  ui.reloadBtn.addEventListener('click', () => loadProject());
  ui.applyBtn.addEventListener('click', applySolvedPositions);
  ui.fitBtn.addEventListener('click', fitView);
  ui.resetBtn.addEventListener('click', resetSimulation);
  ui.runBtn.addEventListener('click', () => {
    if (!sim.running && sim.settled) {
      sim.settled = false;
      sim.stableSteps = 0;
    }
    sim.running = !sim.running;
    updateButtons();
  });
  ui.stepBtn.addEventListener('click', () => {
    sim.settled = false;
    sim.stableSteps = 0;
    physicsStep();
    detectCrossings();
    updateStats();
  });

  for (const input of [ui.springStrength, ui.nodeRepulsion, ui.crossRepulsion, ui.edgeNodeRepulsion, ui.damping, ui.stepsPerFrame]) {
    input.addEventListener('input', syncControlLabels);
  }
  syncControlLabels();

  canvas.addEventListener('pointerdown', (event) => {
    if (!sim.nodes.length) return;
    canvas.setPointerCapture(event.pointerId);
    const point = canvasPoint(event);
    const node = nodeAtScreen(point.x, point.y);
    if (event.button === 0 && node) {
      sim.draggingNode = node;
      sim.settled = false;
      sim.stableSteps = 0;
      node.vx = 0;
      node.vy = 0;
      const world = screenToWorld(point.x, point.y);
      node.dragDX = node.x - world.x;
      node.dragDY = node.y - world.y;
    } else {
      sim.pan.active = true;
      sim.pan.x = point.x;
      sim.pan.y = point.y;
      sim.pan.ox = sim.camera.x;
      sim.pan.oy = sim.camera.y;
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    const point = canvasPoint(event);
    if (sim.draggingNode) {
      const world = screenToWorld(point.x, point.y);
      sim.draggingNode.x = world.x + (sim.draggingNode.dragDX ?? 0);
      sim.draggingNode.y = world.y + (sim.draggingNode.dragDY ?? 0);
      sim.draggingNode.vx = 0;
      sim.draggingNode.vy = 0;
      sim.crossingsDirty = true;
      updateButtons();
    } else if (sim.pan.active) {
      sim.camera.x = sim.pan.ox + point.x - sim.pan.x;
      sim.camera.y = sim.pan.oy + point.y - sim.pan.y;
    }
  });

  const endPointer = (event: PointerEvent) => {
    sim.draggingNode = null;
    sim.pan.active = false;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* Pointer capture may already be released. */ }
    updateButtons();
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const point = canvasPoint(event);
    const before = screenToWorld(point.x, point.y);
    const factor = Math.exp(-event.deltaY * 0.0012);
    sim.camera.scale = Math.max(0.002, Math.min(8, sim.camera.scale * factor));
    sim.camera.x = point.x - before.x * sim.camera.scale;
    sim.camera.y = point.y - before.y * sim.camera.scale;
  }, { passive: false });

  window.addEventListener('resize', () => {
    if (!sim.active) return;
    resize();
    render();
  });

  window.addEventListener(HISTORY_APPLY_EVENT, () => {
    if (!sim.active || sim.applying) return;
    window.setTimeout(() => {
      if (sim.active && !sim.applying) loadProject();
    }, 0);
  });

  updateButtons();
  updateStats();
  window.requestAnimationFrame(loop);
  return true;
}

if (!installSolverUi()) {
  const observer = new MutationObserver(() => {
    if (installSolverUi()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
