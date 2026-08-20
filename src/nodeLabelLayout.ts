export type NodeLabelEffectInput = {
  operator: 'add' | 'subtract' | 'multiply' | 'divide' | 'set';
  value: number | boolean;
  groupName: string;
  statName: string;
};

export type NodeLabelInput = {
  id: string;
  position: { x: number; y: number };
  name: string;
  effects: NodeLabelEffectInput[];
};

export type NodeLabelEffectView = {
  modifier: string;
  target: string;
  text: string;
  tone: 'positive' | 'negative' | 'neutral';
};

export type NodeLabelView = {
  left: number;
  top: number;
  width: number;
  align: 'left' | 'center' | 'right';
  name: string | null;
  effects: NodeLabelEffectView[];
};

type LayoutEdge = { source: string; target: string };
type Rect = { left: number; top: number; right: number; bottom: number };
type Point = { x: number; y: number };
type Direction = {
  x: number;
  y: number;
  bias: number;
  align: NodeLabelView['align'];
};

const NODE_SIZE = 62;
const NODE_RADIUS = 29;
const LABEL_GAP = 12;
const NODE_CLEARANCE = 5;
const EDGE_CLEARANCE = 4;
const LABEL_CLEARANCE = 5;

const DIRECTIONS: Direction[] = [
  { x: 1, y: 0, bias: 0, align: 'left' },
  { x: -1, y: 0, bias: 0.05, align: 'right' },
  { x: 0, y: -1, bias: 0.1, align: 'center' },
  { x: 0, y: 1, bias: 0.15, align: 'center' },
  { x: Math.SQRT1_2, y: -Math.SQRT1_2, bias: 0.2, align: 'left' },
  { x: Math.SQRT1_2, y: Math.SQRT1_2, bias: 0.25, align: 'left' },
  { x: -Math.SQRT1_2, y: -Math.SQRT1_2, bias: 0.3, align: 'right' },
  { x: -Math.SQRT1_2, y: Math.SQRT1_2, bias: 0.35, align: 'right' },
];

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 1e6 || (Math.abs(value) > 0 && Math.abs(value) < 1e-4)) {
    return value.toPrecision(4);
  }
  return Number(value.toFixed(6)).toString();
}

function statTarget(groupName: string, statName: string) {
  const group = groupName.trim();
  const stat = statName.trim();
  if (!group) return stat;
  if (!stat) return group;

  const lowerGroup = group.toLocaleLowerCase();
  const lowerStat = stat.toLocaleLowerCase();
  if (lowerStat === lowerGroup) return stat;
  if (lowerStat.startsWith(`${lowerGroup} `)) {
    return `${group} ${stat.slice(group.length).trim()}`;
  }
  return `${group} ${stat}`;
}

function formatEffect(effect: NodeLabelEffectInput): NodeLabelEffectView {
  const target = statTarget(effect.groupName, effect.statName);
  let modifier: string;
  let tone: NodeLabelEffectView['tone'] = 'neutral';

  if (effect.operator === 'set') {
    const enabled = Boolean(effect.value);
    modifier = enabled ? '✓' : '✕';
    tone = enabled ? 'positive' : 'negative';
  } else {
    const rawValue = typeof effect.value === 'number' ? effect.value : 0;
    if (effect.operator === 'multiply') {
      modifier = `×${formatNumber(rawValue)}`;
    } else if (effect.operator === 'divide') {
      modifier = `÷${formatNumber(rawValue)}`;
    } else {
      const signedValue = effect.operator === 'subtract' ? -rawValue : rawValue;
      modifier = `${signedValue >= 0 ? '+' : '−'}${formatNumber(Math.abs(signedValue))}`;
      tone = signedValue >= 0 ? 'positive' : 'negative';
    }
  }

  return { modifier, target, text: `${modifier} ${target}`.trim(), tone };
}

function estimatedTextWidth(text: string, nameLine: boolean) {
  let width = 0;
  for (const character of text) {
    if (character === ' ') width += 3.1;
    else if (/[MW@#%&]/.test(character)) width += 7.4;
    else if (/[A-Z0-9✓✕×÷+−]/.test(character)) width += 6.3;
    else if (/[ilI.,'`]/.test(character)) width += 3.2;
    else width += 5.5;
  }
  return width * (nameLine ? 1.06 : 1) + 2;
}

function estimateLabelSize(name: string | null, effects: NodeLabelEffectView[]) {
  const widths = [
    ...(name ? [estimatedTextWidth(name, true)] : []),
    ...effects.map((effect) => estimatedTextWidth(effect.text, false)),
  ];
  const width = Math.max(24, Math.ceil(Math.max(...widths, 0)));
  const nameHeight = name ? 14 : 0;
  const effectHeight = effects.length * 13;
  const sectionGap = name && effects.length ? 3 : 0;
  return { width, height: Math.max(1, nameHeight + sectionGap + effectHeight) };
}

function expandRect(rect: Rect, amount: number): Rect {
  return {
    left: rect.left - amount,
    top: rect.top - amount,
    right: rect.right + amount,
    bottom: rect.bottom + amount,
  };
}

function rectsOverlap(a: Rect, b: Rect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function rectCircleIntersects(rect: Rect, center: Point, radius: number) {
  const closestX = Math.max(rect.left, Math.min(center.x, rect.right));
  const closestY = Math.max(rect.top, Math.min(center.y, rect.bottom));
  return Math.hypot(center.x - closestX, center.y - closestY) < radius;
}

function pointInsideRect(point: Point, rect: Rect) {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

function orientation(a: Point, b: Point, c: Point) {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 1e-9) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(a: Point, b: Point, c: Point) {
  return b.x <= Math.max(a.x, c.x) + 1e-9
    && b.x + 1e-9 >= Math.min(a.x, c.x)
    && b.y <= Math.max(a.y, c.y) + 1e-9
    && b.y + 1e-9 >= Math.min(a.y, c.y);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  return o4 === 0 && onSegment(c, b, d);
}

function segmentIntersectsRect(a: Point, b: Point, rect: Rect) {
  if (pointInsideRect(a, rect) || pointInsideRect(b, rect)) return true;
  const topLeft = { x: rect.left, y: rect.top };
  const topRight = { x: rect.right, y: rect.top };
  const bottomRight = { x: rect.right, y: rect.bottom };
  const bottomLeft = { x: rect.left, y: rect.bottom };
  return segmentsIntersect(a, b, topLeft, topRight)
    || segmentsIntersect(a, b, topRight, bottomRight)
    || segmentsIntersect(a, b, bottomRight, bottomLeft)
    || segmentsIntersect(a, b, bottomLeft, topLeft);
}

function nodeCenter(node: NodeLabelInput): Point {
  return { x: node.position.x + NODE_SIZE / 2, y: node.position.y + NODE_SIZE / 2 };
}

function candidateRect(center: Point, width: number, height: number, direction: Direction): Rect {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const rectangleRadiusAlongDirection = Math.abs(direction.x) * halfWidth + Math.abs(direction.y) * halfHeight;
  const distance = NODE_RADIUS + LABEL_GAP + rectangleRadiusAlongDirection;
  const labelCenter = {
    x: center.x + direction.x * distance,
    y: center.y + direction.y * distance,
  };
  return {
    left: labelCenter.x - halfWidth,
    top: labelCenter.y - halfHeight,
    right: labelCenter.x + halfWidth,
    bottom: labelCenter.y + halfHeight,
  };
}

export function buildNodeLabelLayout(
  nodes: NodeLabelInput[],
  edges: LayoutEdge[],
  options: { showNames: boolean; showStats: boolean },
): ReadonlyMap<string, NodeLabelView> {
  if (!options.showNames && !options.showStats) return new Map();

  const centerMap = new Map(nodes.map((node) => [node.id, nodeCenter(node)]));
  const edgeSegments = edges.flatMap((edge) => {
    const source = centerMap.get(edge.source);
    const target = centerMap.get(edge.target);
    return source && target ? [{ source, target }] : [];
  });
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const prepared = nodes.flatMap((node) => {
    const name = options.showNames && node.name.trim() ? node.name.trim() : null;
    const effects = options.showStats ? node.effects.map(formatEffect) : [];
    if (!name && effects.length === 0) return [];
    const size = estimateLabelSize(name, effects);
    return [{ node, name, effects, ...size }];
  }).sort((a, b) => {
    const constraintA = (degree.get(a.node.id) ?? 0) * 1000 + a.width + a.height;
    const constraintB = (degree.get(b.node.id) ?? 0) * 1000 + b.width + b.height;
    return constraintB - constraintA || a.node.id.localeCompare(b.node.id);
  });

  const result = new Map<string, NodeLabelView>();
  const placedRects: Rect[] = [];

  for (const { node, name, effects, width, height } of prepared) {
    const center = centerMap.get(node.id)!;
    let best: { rect: Rect; direction: Direction; score: number } | null = null;

    for (const direction of DIRECTIONS) {
      const rect = candidateRect(center, width, height, direction);
      let score = direction.bias;
      const nodeCollisionRect = expandRect(rect, NODE_CLEARANCE);
      const edgeCollisionRect = expandRect(rect, EDGE_CLEARANCE);
      const labelCollisionRect = expandRect(rect, LABEL_CLEARANCE);

      for (const otherNode of nodes) {
        if (otherNode.id === node.id) continue;
        const otherCenter = centerMap.get(otherNode.id)!;
        if (rectCircleIntersects(nodeCollisionRect, otherCenter, NODE_RADIUS)) score += 1_000_000;
        else if (rectCircleIntersects(expandRect(rect, 12), otherCenter, NODE_RADIUS)) score += 300;
      }

      for (const segment of edgeSegments) {
        if (segmentIntersectsRect(segment.source, segment.target, edgeCollisionRect)) score += 100_000;
        else if (segmentIntersectsRect(segment.source, segment.target, expandRect(rect, 10))) score += 120;
      }

      for (const placed of placedRects) {
        if (rectsOverlap(labelCollisionRect, expandRect(placed, LABEL_CLEARANCE))) score += 500_000;
      }

      if (!best || score < best.score) best = { rect, direction, score };
    }

    if (!best) continue;
    placedRects.push(best.rect);
    result.set(node.id, {
      left: best.rect.left - node.position.x,
      top: best.rect.top - node.position.y,
      width,
      align: best.direction.align,
      name,
      effects,
    });
  }

  return result;
}
