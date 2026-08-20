import {
  BaseEdge,
  Controls,
  Edge,
  EdgeProps,
  Handle,
  MarkerType,
  Node,
  NodeProps,
  Position,
  ReactFlow,
  ReactFlowInstance,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  applyHistoryTransitionsToCollection,
  HISTORY_APPLY_EVENT,
  recordHistoryProject,
} from './history';
import type { HistoryApplyDetail } from './history';
import { buildNodeLabelLayout, type NodeLabelView } from './nodeLabelLayout';

type StatType = 'number' | 'boolean';
type NumberOperator = 'add' | 'subtract' | 'multiply' | 'divide';
type BooleanOperator = 'set';
type UpgradeOperator = NumberOperator | BooleanOperator;
type EditorView = 'tree' | 'stats' | 'currencies';

type Point = { x: number; y: number };

type StatDefinition = {
  id: string;
  key: string;
  name: string;
  type: StatType;
  groupId: string;
  groupName: string;
  groupKey: string;
};

type CurrencyDefinition = {
  id: string;
  key: string;
  name: string;
  symbol: string;
};

type UpgradeEffect = {
  id: string;
  statId: string;
  operator: UpgradeOperator;
  value: number | boolean;
};

type SkillCost = {
  currencyId: string;
  amount: number;
};

type SkillNodeData = {
  name: string;
  cost: SkillCost;
  upgrades: UpgradeEffect[];
};

type SkillFlowNode = Node<SkillNodeData, 'skill'>;

type SkillLinkData = {
  sourceCenter: Point;
  targetCenter: Point;
};

type SkillLinkEdge = Edge<SkillLinkData, 'skillLink'>;

type PersistedProject = {
  version: 2;
  nodes: SkillFlowNode[];
  edges: SkillLinkEdge[];
  stats: StatDefinition[];
  currencies: CurrencyDefinition[];
};

type GestureKind = 'link' | 'createBlank' | 'createUpgrade';
type GestureState = {
  kind: GestureKind;
  sourceId: string;
  start: Point;
  current: Point;
};

type ClipboardSnapshot = {
  nodes: SkillFlowNode[];
  internalEdges: SkillLinkEdge[];
  rootParentEdges: Array<{ source: string; target: string }>;
};

type SkillInteractionContextValue = {
  beginGesture: (nodeId: string, event: ReactPointerEvent<HTMLDivElement>) => void;
  duplicateNode: (nodeId: string) => void;
  beginRightPan: (event: ReactPointerEvent<HTMLDivElement>) => void;
  nodeLabels: ReadonlyMap<string, NodeLabelView>;
};

const SkillInteractionContext = createContext<SkillInteractionContextValue | null>(null);

const STORAGE_KEY = 'incremental-td-skill-tree:v2';
const LEGACY_STORAGE_KEY = 'incremental-td-skill-tree:v1';
const NODE_SIZE = 62;
const NODE_RADIUS = 29;

const starterStats: StatDefinition[] = [
  { id: 'stat-damage', key: 'tower.damage', name: 'Tower Damage', type: 'number', groupId: 'stat-group-tower', groupName: 'Tower', groupKey: 'tower' },
  { id: 'stat-range', key: 'tower.range', name: 'Tower Range', type: 'number', groupId: 'stat-group-tower', groupName: 'Tower', groupKey: 'tower' },
  { id: 'stat-crit', key: 'tower.canCrit', name: 'Can Critical Hit', type: 'boolean', groupId: 'stat-group-tower', groupName: 'Tower', groupKey: 'tower' },
];

const starterCurrencies: CurrencyDefinition[] = [
  { id: 'currency-knowledge', key: 'currency.knowledge', name: 'Knowledge', symbol: '◇' },
  { id: 'currency-cores', key: 'currency.cores', name: 'Tower Cores', symbol: '⬡' },
];

const starterNodes: SkillFlowNode[] = [
  {
    id: 'skill-core',
    type: 'skill',
    position: { x: 80, y: 220 },
    data: {
      name: 'Core Calibration',
      cost: { currencyId: 'currency-knowledge', amount: 10 },
      upgrades: [{ id: 'upgrade-core', statId: 'stat-damage', operator: 'add', value: 2 }],
    },
  },
  {
    id: 'skill-range',
    type: 'skill',
    position: { x: 300, y: 95 },
    data: {
      name: 'Long Optics',
      cost: { currencyId: 'currency-knowledge', amount: 35 },
      upgrades: [{ id: 'upgrade-range', statId: 'stat-range', operator: 'multiply', value: 1.15 }],
    },
  },
  {
    id: 'skill-crit',
    type: 'skill',
    position: { x: 300, y: 345 },
    data: {
      name: 'Critical Circuit',
      cost: { currencyId: 'currency-knowledge', amount: 50 },
      upgrades: [{ id: 'upgrade-crit', statId: 'stat-crit', operator: 'set', value: true }],
    },
  },
  {
    id: 'skill-overdrive',
    type: 'skill',
    position: { x: 540, y: 220 },
    data: {
      name: 'Overdrive',
      cost: { currencyId: 'currency-cores', amount: 3 },
      upgrades: [{ id: 'upgrade-overdrive', statId: 'stat-damage', operator: 'multiply', value: 1.35 }],
    },
  },
];

const starterEdges: SkillLinkEdge[] = [
  { id: 'edge-core-range', source: 'skill-core', target: 'skill-range', type: 'skillLink' },
  { id: 'edge-core-crit', source: 'skill-core', target: 'skill-crit', type: 'skillLink' },
  { id: 'edge-range-overdrive', source: 'skill-range', target: 'skill-overdrive', type: 'skillLink' },
  { id: 'edge-crit-overdrive', source: 'skill-crit', target: 'skill-overdrive', type: 'skillLink' },
];

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function statGameKeyFromDisplayName(name: string) {
  return name.toLowerCase().replaceAll(' ', '.');
}

function statGroupNameFromKey(key: string) {
  const words = key.split('.').filter(Boolean);
  if (words.length === 0) return 'Stats';
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
}

function splitLegacyStatKey(key: string) {
  const separator = key.lastIndexOf('.');
  if (separator <= 0 || separator === key.length - 1) {
    return { groupKey: 'stats', localKey: key || 'stat' };
  }
  return { groupKey: key.slice(0, separator), localKey: key.slice(separator + 1) };
}

function statLocalKey(stat: Pick<StatDefinition, 'key' | 'groupKey'>) {
  const prefix = stat.groupKey ? `${stat.groupKey}.` : '';
  if (prefix && stat.key.startsWith(prefix)) return stat.key.slice(prefix.length);
  return splitLegacyStatKey(stat.key).localKey;
}

function composeStatKey(groupKey: string, localKey: string) {
  const prefix = groupKey.trim().replace(/^\.+|\.+$/g, '');
  const suffix = localKey.trim().replace(/^\.+/g, '');
  if (!prefix) return suffix;
  if (!suffix) return prefix;
  return `${prefix}.${suffix}`;
}

function uniqueGroupKey(base: string, stats: StatDefinition[]) {
  const desired = base || 'group';
  const used = new Set(stats.map((stat) => stat.groupKey));
  if (!used.has(desired)) return desired;
  let index = 2;
  while (used.has(`${desired}.${index}`)) index += 1;
  return `${desired}.${index}`;
}

function uniqueStatLocalKey(groupKey: string, base: string, stats: StatDefinition[]) {
  const desired = base || 'stat';
  const used = new Set(stats.filter((stat) => stat.groupKey === groupKey).map(statLocalKey));
  if (!used.has(desired)) return desired;
  let index = 2;
  while (used.has(`${desired}.${index}`)) index += 1;
  return `${desired}.${index}`;
}

function defaultProject(): PersistedProject {
  return {
    version: 2,
    nodes: starterNodes,
    edges: starterEdges,
    stats: starterStats,
    currencies: starterCurrencies,
  };
}

function wouldCreateCycle(source: string, target: string, edges: SkillLinkEdge[]) {
  if (source === target) return true;

  const outgoing = new Map<string, string[]>();
  edges.forEach((edge) => {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  });

  const stack = [target];
  const visited = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (current === source) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    (outgoing.get(current) ?? []).forEach((next) => stack.push(next));
  }
  return false;
}

function edgeIssue(source: string, target: string, edges: SkillLinkEdge[]) {
  if (source === target) return 'A skill cannot unlock itself.';
  if (edges.some((edge) => edge.source === source && edge.target === target)) return 'That prerequisite link already exists.';
  if (wouldCreateCycle(source, target, edges)) return 'That link would create a recursive loop.';
  return null;
}

function sanitizeEdges(rawEdges: unknown[], nodes: SkillFlowNode[]) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const safe: SkillLinkEdge[] = [];

  rawEdges.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const edge = raw as Record<string, unknown>;
    const source = typeof edge.source === 'string' ? edge.source : '';
    const target = typeof edge.target === 'string' ? edge.target : '';
    if (!nodeIds.has(source) || !nodeIds.has(target) || edgeIssue(source, target, safe)) return;
    safe.push({
      id: typeof edge.id === 'string' ? edge.id : `edge-import-${index}`,
      source,
      target,
      type: 'skillLink',
    });
  });

  return safe;
}

function normalizeStats(raw: unknown): StatDefinition[] {
  if (!Array.isArray(raw)) return [];
  const inferredGroupIds = new Map<string, string>();
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const type: StatType = value.type === 'boolean' ? 'boolean' : 'number';
    const rawKey = typeof value.key === 'string' && value.key ? value.key : `stat.${index + 1}`;
    const inferred = splitLegacyStatKey(rawKey);
    const groupKey = typeof value.groupKey === 'string' ? value.groupKey : inferred.groupKey;
    const groupName = typeof value.groupName === 'string' && value.groupName
      ? value.groupName
      : statGroupNameFromKey(groupKey);
    let groupId = typeof value.groupId === 'string' && value.groupId ? value.groupId : inferredGroupIds.get(groupKey);
    if (!groupId) {
      groupId = `stat-group-import-${index}`;
      inferredGroupIds.set(groupKey, groupId);
    }
    const localKey = groupKey && rawKey.startsWith(`${groupKey}.`)
      ? rawKey.slice(groupKey.length + 1)
      : inferred.localKey;
    return [{
      id: typeof value.id === 'string' ? value.id : `stat-import-${index}`,
      key: composeStatKey(groupKey, localKey),
      name: typeof value.name === 'string' ? value.name : `Stat ${index + 1}`,
      type,
      groupId,
      groupName,
      groupKey,
    }];
  });
}

function normalizeCurrencies(raw: unknown): CurrencyDefinition[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    return [{
      id: typeof value.id === 'string' ? value.id : `currency-import-${index}`,
      key: typeof value.key === 'string' ? value.key : `currency.${index + 1}`,
      name: typeof value.name === 'string' ? value.name : `Currency ${index + 1}`,
      symbol: typeof value.symbol === 'string' ? value.symbol : '◇',
    }];
  });
}

function migrateProject(raw: unknown): PersistedProject | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.stats)) return null;

  const stats = normalizeStats(value.stats);
  const currencies = value.version === 2 && Array.isArray(value.currencies)
    ? normalizeCurrencies(value.currencies)
    : starterCurrencies;
  const fallbackCurrencyId = currencies[0]?.id ?? '';
  const currencyIds = new Set(currencies.map((currency) => currency.id));
  const statMap = new Map(stats.map((stat) => [stat.id, stat]));

  const nodes: SkillFlowNode[] = value.nodes.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const rawNode = item as Record<string, unknown>;
    const rawData = rawNode.data && typeof rawNode.data === 'object'
      ? rawNode.data as Record<string, unknown>
      : {};
    const rawPosition = rawNode.position && typeof rawNode.position === 'object'
      ? rawNode.position as Record<string, unknown>
      : {};

    const oldCost = rawData.cost;
    let cost: SkillCost;
    if (typeof oldCost === 'number') {
      cost = { currencyId: fallbackCurrencyId, amount: Number.isFinite(oldCost) ? oldCost : 0 };
    } else if (oldCost && typeof oldCost === 'object') {
      const rawCost = oldCost as Record<string, unknown>;
      cost = {
        currencyId: typeof rawCost.currencyId === 'string' && currencyIds.has(rawCost.currencyId) ? rawCost.currencyId : fallbackCurrencyId,
        amount: typeof rawCost.amount === 'number' && Number.isFinite(rawCost.amount) ? rawCost.amount : 0,
      };
    } else {
      cost = { currencyId: fallbackCurrencyId, amount: 0 };
    }

    const upgrades: UpgradeEffect[] = Array.isArray(rawData.upgrades)
      ? rawData.upgrades.flatMap<UpgradeEffect>((upgradeItem, upgradeIndex): UpgradeEffect[] => {
          if (!upgradeItem || typeof upgradeItem !== 'object') return [];
          const upgrade = upgradeItem as Record<string, unknown>;
          const statId = typeof upgrade.statId === 'string' ? upgrade.statId : '';
          const stat = statMap.get(statId);
          if (!stat) return [];
          if (stat.type === 'boolean') {
            return [{
              id: typeof upgrade.id === 'string' ? upgrade.id : `upgrade-import-${index}-${upgradeIndex}`,
              statId,
              operator: 'set' as const,
              value: Boolean(upgrade.value),
            }];
          }
          const operators: NumberOperator[] = ['add', 'subtract', 'multiply', 'divide'];
          const operator = operators.includes(upgrade.operator as NumberOperator)
            ? upgrade.operator as NumberOperator
            : 'add';
          return [{
            id: typeof upgrade.id === 'string' ? upgrade.id : `upgrade-import-${index}-${upgradeIndex}`,
            statId,
            operator,
            value: typeof upgrade.value === 'number' && Number.isFinite(upgrade.value) ? upgrade.value : 1,
          }];
        })
      : [];

    return [{
      id: typeof rawNode.id === 'string' ? rawNode.id : `skill-import-${index}`,
      type: 'skill' as const,
      position: {
        x: typeof rawPosition.x === 'number' && Number.isFinite(rawPosition.x) ? rawPosition.x : 0,
        y: typeof rawPosition.y === 'number' && Number.isFinite(rawPosition.y) ? rawPosition.y : 0,
      },
      data: {
        name: typeof rawData.name === 'string' ? rawData.name : `Skill ${index + 1}`,
        cost,
        upgrades,
      },
    }];
  });

  return {
    version: 2,
    nodes,
    edges: sanitizeEdges(value.edges, nodes),
    stats,
    currencies,
  };
}

function loadProject(): PersistedProject {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return defaultProject();
    return migrateProject(JSON.parse(raw)) ?? defaultProject();
  } catch {
    return defaultProject();
  }
}

function incrementUpgradeName(name: string) {
  const trimmed = name.trim();
  const match = trimmed.match(/^(.*?)(\d+)$/);
  if (!match) return `${trimmed || 'New Skill'} 2`;
  return `${match[1]}${Number(match[2]) + 1}`;
}

function circleEdgePoints(sourceCenter: Point, targetCenter: Point) {
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const distance = Math.hypot(dx, dy) || 1;
  const ux = dx / distance;
  const uy = dy / distance;
  return {
    source: { x: sourceCenter.x + ux * NODE_RADIUS, y: sourceCenter.y + uy * NODE_RADIUS },
    target: { x: targetCenter.x - ux * NODE_RADIUS, y: targetCenter.y - uy * NODE_RADIUS },
  };
}

function SkillLinkEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
  style,
}: EdgeProps<SkillLinkEdge>) {
  const sourceCenter = data?.sourceCenter ?? { x: sourceX, y: sourceY };
  const targetCenter = data?.targetCenter ?? { x: targetX, y: targetY };
  const points = circleEdgePoints(sourceCenter, targetCenter);
  const path = `M ${points.source.x},${points.source.y} L ${points.target.x},${points.target.y}`;

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={style}
      interactionWidth={18}
    />
  );
}

function SkillNode({ id, selected }: NodeProps<SkillFlowNode>) {
  const interaction = useContext(SkillInteractionContext);
  const label = interaction?.nodeLabels.get(id);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const distanceFromCenter = Math.hypot(
      event.clientX - (rect.left + rect.width / 2),
      event.clientY - (rect.top + rect.height / 2),
    );
    if (distanceFromCenter > Math.min(rect.width, rect.height) / 2) return;

    if (event.button === 1) {
      event.preventDefault();
      event.stopPropagation();
      interaction?.duplicateNode(id);
      return;
    }

    if (event.button === 2 && !event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      interaction?.beginRightPan(event);
      return;
    }

    const isLinkGesture = event.altKey && event.button === 0;
    const isCreateGesture = event.ctrlKey && (event.button === 0 || event.button === 2);
    if (!isLinkGesture && !isCreateGesture) return;
    event.preventDefault();
    event.stopPropagation();
    interaction?.beginGesture(id, event);
  };

  return (
    <div
      className={`skill-node${selected ? ' is-selected' : ''}`}
      aria-label="Skill node"
      data-skill-node-id={id}
      onPointerDown={onPointerDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      <Handle className="skill-handle skill-handle-target" type="target" position={Position.Left} isConnectable={false} />
      <div className="skill-node-core" />
      {label && (
        <div
          className="skill-node-label"
          style={{ left: `${label.left}px`, top: `${label.top}px`, width: `${label.width}px`, textAlign: label.align }}
          aria-hidden="true"
        >
          {label.currency && <div className="skill-node-label-currency">{label.currency}</div>}
          {label.name && <div className="skill-node-label-name">{label.name}</div>}
          {label.effects.length > 0 && (
            <div className="skill-node-label-effects">
              {label.effects.map((effect, index) => (
                <div className="skill-node-label-effect" key={`${effect.text}-${index}`}>
                  <span className={`skill-node-label-modifier ${effect.tone}`}>{effect.modifier}</span>
                  <span>{effect.target}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <Handle className="skill-handle skill-handle-source" type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { skill: SkillNode };
const edgeTypes = { skillLink: SkillLinkEdgeComponent };

function Icon({ name }: { name: 'plus' | 'trash' | 'download' | 'upload' | 'tree' | 'stats' | 'close' | 'link' | 'currency' | 'nodeName' | 'nodeStats' }) {
  const paths: Record<string, ReactElement> = {
    plus: <path d="M12 5v14M5 12h14" />,
    trash: <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" />,
    download: <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" />,
    upload: <path d="M12 17V5m0 0 4 4m-4-4-4 4M5 20h14" />,
    tree: <path d="M12 4v5m0 0-5 4m5-4 5 4M7 13v5m10-5v5M4 18h6m4 0h6" />,
    stats: <path d="M5 19V9m7 10V5m7 14v-7" />,
    currency: <><path d="M12 3 20 8l-8 13L4 8l8-5Z" /><path d="M4 8h16" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    link: <path d="M9 15l6-6m-8.5 8.5-1 1a3.54 3.54 0 0 1-5-5l3-3a3.54 3.54 0 0 1 5 0m7-1a3.54 3.54 0 0 1 5 5l-3 3a3.54 3.54 0 0 1-5 0" />,
    nodeName: <><path d="M5 6h14M12 6v12M8.5 18h7" /><path d="M7 9V6m10 3V6" /></>,
    nodeStats: <><path d="M4 6h7m4 0h5M4 12h3m4 0h9M4 18h9m4 0h3" /><path d="M13 4v4M9 10v4M15 16v4" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function App() {
  return (
    <ReactFlowProvider>
      <SkillTreeEditor />
    </ReactFlowProvider>
  );
}

function SkillTreeEditor() {
  const initial = useMemo(loadProject, []);
  const [nodes, setNodes, onNodesChange] = useNodesState<SkillFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<SkillLinkEdge>(initial.edges);
  const [stats, setStats] = useState<StatDefinition[]>(initial.stats);
  const [currencies, setCurrencies] = useState<CurrencyDefinition[]>(initial.currencies);
  const [activeView, setActiveView] = useState<EditorView>('tree');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initial.nodes[0]?.id ?? null);
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance<SkillFlowNode, SkillLinkEdge> | null>(null);
  const [savedAt, setSavedAt] = useState('Saved');
  const [connectionChoice, setConnectionChoice] = useState('');
  const [showNodeCurrency, setShowNodeCurrency] = useState(true);
  const [showNodeNames, setShowNodeNames] = useState(true);
  const [showNodeStats, setShowNodeStats] = useState(true);
  const [gesture, setGesture] = useState<GestureState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const flowWrapRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const suppressContextMenuUntilRef = useRef(0);
  const clipboardRef = useRef<ClipboardSnapshot | null>(null);
  const pasteCountRef = useRef(0);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const statGroups = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; key: string; stats: StatDefinition[] }>();
    stats.forEach((stat) => {
      const existing = groups.get(stat.groupId);
      if (existing) {
        existing.stats.push(stat);
        return;
      }
      groups.set(stat.groupId, { id: stat.groupId, name: stat.groupName, key: stat.groupKey, stats: [stat] });
    });
    return [...groups.values()];
  }, [stats]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2200);
  }, []);

  useEffect(() => {
    const preventSuppressedContextMenu = (event: MouseEvent) => {
      if (Date.now() < suppressContextMenuUntilRef.current) event.preventDefault();
    };
    window.addEventListener('contextmenu', preventSuppressedContextMenu);
    return () => {
      window.removeEventListener('contextmenu', preventSuppressedContextMenu);
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const onHistoryApply = (event: Event) => {
      const detail = (event as CustomEvent<HistoryApplyDetail>).detail;
      if (!detail?.transitions.length) return;

      const touched = new Set(detail.transitions.flatMap((transition) =>
        transition.changes.map((change) => change.key[0]),
      ));

      if (touched.has('nodes')) {
        setNodes((current) => applyHistoryTransitionsToCollection(current, 'nodes', detail.transitions));
      }
      if (touched.has('edges')) {
        setEdges((current) => applyHistoryTransitionsToCollection(current, 'edges', detail.transitions));
      }
      if (touched.has('stats')) {
        setStats((current) => normalizeStats(
          applyHistoryTransitionsToCollection(current, 'stats', detail.transitions),
        ));
      }
      if (touched.has('currencies')) {
        setCurrencies((current) => applyHistoryTransitionsToCollection(current, 'currencies', detail.transitions));
      }

      const removedNodeIds = new Set<string>();
      detail.transitions.forEach((transition) => {
        transition.changes.forEach((change) => {
          if (change.key[0] !== 'nodes' || change.key.length !== 2) return;
          const targetExists = transition.direction === 'undo' ? change.oldExists : change.newExists;
          if (!targetExists) removedNodeIds.add(change.key[1]);
        });
      });
      setSelectedNodeId((current) => current && removedNodeIds.has(current) ? null : current);
      setConnectionChoice('');
      setGesture(null);
    };

    window.addEventListener(HISTORY_APPLY_EVENT, onHistoryApply);
    return () => window.removeEventListener(HISTORY_APPLY_EVENT, onHistoryApply);
  }, [setEdges, setNodes]);

  useEffect(() => {
    const project: PersistedProject = { version: 2, nodes, edges, stats, currencies };
    recordHistoryProject(project);

    const timer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
      setSavedAt(`Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [nodes, edges, stats, currencies]);

  const addDirectedEdge = useCallback((source: string, target: string) => {
    const issue = edgeIssue(source, target, edges);
    if (issue) {
      showNotice(issue);
      return false;
    }
    setEdges((current) => {
      if (edgeIssue(source, target, current)) return current;
      return [...current, { id: uid('edge'), source, target, type: 'skillLink' }];
    });
    return true;
  }, [edges, setEdges, showNotice]);

  const createNodeAtFlowPosition = useCallback((position: Point, data?: SkillNodeData) => {
    const id = uid('skill');
    const node: SkillFlowNode = {
      id,
      type: 'skill',
      position: { x: position.x - NODE_SIZE / 2, y: position.y - NODE_SIZE / 2 },
      data: data ?? {
        name: 'New Skill',
        cost: { currencyId: currencies[0]?.id ?? '', amount: 0 },
        upgrades: [],
      },
    };
    setNodes((current) => [...current, node]);
    setSelectedNodeId(id);
    setActiveView('tree');
    return id;
  }, [currencies, setNodes]);

  const createNodeAt = useCallback((clientX?: number, clientY?: number) => {
    if (!rfInstance || !flowWrapRef.current) return;
    const rect = flowWrapRef.current.getBoundingClientRect();
    const flowPosition = rfInstance.screenToFlowPosition({
      x: clientX ?? rect.left + rect.width / 2,
      y: clientY ?? rect.top + rect.height / 2,
    });
    createNodeAtFlowPosition(flowPosition);
  }, [createNodeAtFlowPosition, rfInstance]);

  const cloneNodeData = useCallback((data: SkillNodeData): SkillNodeData => ({
    name: data.name,
    cost: { ...data.cost },
    upgrades: data.upgrades.map((upgrade) => ({ ...upgrade, id: uid('upgrade') })),
  }), []);

  const duplicateNode = useCallback((nodeId: string) => {
    const sourceNode = nodes.find((node) => node.id === nodeId);
    if (!sourceNode) return;

    const duplicateId = uid('skill');
    const duplicate: SkillFlowNode = {
      id: duplicateId,
      type: 'skill',
      position: { x: sourceNode.position.x + 84, y: sourceNode.position.y + 42 },
      data: cloneNodeData(sourceNode.data),
      selected: true,
    };
    const parentEdges = edges.filter((edge) => edge.target === nodeId);

    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      duplicate,
    ]);
    setEdges((current) => [
      ...current,
      ...parentEdges.map((edge) => ({
        id: uid('edge'),
        source: edge.source,
        target: duplicateId,
        type: 'skillLink' as const,
      })),
    ]);
    setSelectedNodeId(duplicateId);
    setActiveView('tree');
    showNotice(parentEdges.length ? 'Node duplicated with the same parent links.' : 'Root node duplicated.');
  }, [cloneNodeData, edges, nodes, setEdges, setNodes, showNotice]);

  const beginRightPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!rfInstance) return;
    const start = { x: event.clientX, y: event.clientY };
    const initialViewport = rfInstance.getViewport();
    suppressContextMenuUntilRef.current = Date.now() + 1500;

    const onPointerMove = (moveEvent: PointerEvent) => {
      void rfInstance.setViewport({
        x: initialViewport.x + (moveEvent.clientX - start.x),
        y: initialViewport.y + (moveEvent.clientY - start.y),
        zoom: initialViewport.zoom,
      });
    };
    const onPointerUp = () => {
      suppressContextMenuUntilRef.current = Date.now() + 250;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }, [rfInstance]);

  const copySelectedNodes = useCallback(() => {
    let selectedNodes = nodes.filter((node) => node.selected);
    if (selectedNodes.length === 0 && selectedNodeId) {
      const fallback = nodes.find((node) => node.id === selectedNodeId);
      if (fallback) selectedNodes = [fallback];
    }
    if (selectedNodes.length === 0) {
      showNotice('Select at least one node to copy.');
      return;
    }

    const selectedIds = new Set(selectedNodes.map((node) => node.id));
    const internalEdges = edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target));
    const internalTargets = new Set(internalEdges.map((edge) => edge.target));
    const rootIds = new Set(selectedNodes.filter((node) => !internalTargets.has(node.id)).map((node) => node.id));
    const rootParentEdges = edges
      .filter((edge) => rootIds.has(edge.target) && !selectedIds.has(edge.source))
      .map((edge) => ({ source: edge.source, target: edge.target }));

    clipboardRef.current = {
      nodes: selectedNodes.map((node) => ({
        ...node,
        position: { ...node.position },
        data: cloneNodeData(node.data),
        selected: false,
      })),
      internalEdges: internalEdges.map((edge) => ({ ...edge })),
      rootParentEdges,
    };
    pasteCountRef.current = 0;
    showNotice(`Copied ${selectedNodes.length} node${selectedNodes.length === 1 ? '' : 's'}.`);
  }, [cloneNodeData, edges, nodes, selectedNodeId, showNotice]);

  const pasteCopiedNodes = useCallback((keepExternalParents: boolean) => {
    const snapshot = clipboardRef.current;
    if (!snapshot || snapshot.nodes.length === 0) {
      showNotice('Copy one or more nodes first.');
      return;
    }

    pasteCountRef.current += 1;
    const offset = 52 * pasteCountRef.current;
    const idMap = new Map<string, string>();
    snapshot.nodes.forEach((node) => idMap.set(node.id, uid('skill')));

    const pastedNodes: SkillFlowNode[] = snapshot.nodes.map((node) => ({
      id: idMap.get(node.id)!,
      type: 'skill',
      position: { x: node.position.x + offset, y: node.position.y + offset },
      data: cloneNodeData(node.data),
      selected: true,
    }));
    const pastedInternalEdges: SkillLinkEdge[] = snapshot.internalEdges.map((edge) => ({
      id: uid('edge'),
      source: idMap.get(edge.source)!,
      target: idMap.get(edge.target)!,
      type: 'skillLink',
    }));

    const currentNodeIds = new Set(nodes.map((node) => node.id));
    const pastedParentEdges: SkillLinkEdge[] = keepExternalParents
      ? snapshot.rootParentEdges.flatMap((edge) => {
          const target = idMap.get(edge.target);
          if (!target || !currentNodeIds.has(edge.source)) return [];
          return [{ id: uid('edge'), source: edge.source, target, type: 'skillLink' as const }];
        })
      : [];

    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      ...pastedNodes,
    ]);
    setEdges((current) => [...current, ...pastedInternalEdges, ...pastedParentEdges]);
    setSelectedNodeId(pastedNodes[0]?.id ?? null);
    setActiveView('tree');
    showNotice(keepExternalParents
      ? `Pasted ${pastedNodes.length} node${pastedNodes.length === 1 ? '' : 's'} with root parent links.`
      : `Pasted ${pastedNodes.length} node${pastedNodes.length === 1 ? '' : 's'} as an island.`);
  }, [cloneNodeData, nodes, setEdges, setNodes, showNotice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (activeView !== 'tree' || !(event.ctrlKey || event.metaKey)) return;
      const target = event.target as HTMLElement | null;
      if (target && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
        || target.isContentEditable
      )) return;

      if (event.key.toLowerCase() === 'c' && !event.shiftKey) {
        event.preventDefault();
        copySelectedNodes();
      } else if (event.key.toLowerCase() === 'v') {
        event.preventDefault();
        pasteCopiedNodes(!event.shiftKey);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeView, copySelectedNodes, pasteCopiedNodes]);

  const beginGesture = useCallback((sourceId: string, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!flowWrapRef.current) return;
    const rect = flowWrapRef.current.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const kind: GestureKind = event.altKey
      ? 'link'
      : event.button === 2
        ? 'createUpgrade'
        : 'createBlank';
    if (kind === 'createUpgrade') suppressContextMenuUntilRef.current = Date.now() + 1200;
    setSelectedNodeId(sourceId);
    setGesture({ kind, sourceId, start: point, current: point });
  }, []);

  useEffect(() => {
    if (!gesture) return;

    const onPointerMove = (event: PointerEvent) => {
      const rect = flowWrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      setGesture((current) => current ? {
        ...current,
        current: { x: event.clientX - rect.left, y: event.clientY - rect.top },
      } : null);
    };

    const onPointerUp = (event: PointerEvent) => {
      const currentGesture = gesture;
      setGesture(null);

      if (currentGesture.kind === 'link') {
        const nodeElements: HTMLElement[] = flowWrapRef.current
          ? Array.from(flowWrapRef.current.querySelectorAll('[data-skill-node-id]')) as HTMLElement[]
          : [];
        const targetNode = nodeElements.find((element) => {
          const rect = element.getBoundingClientRect();
          const radius = Math.min(rect.width, rect.height) / 2;
          return Math.hypot(
            event.clientX - (rect.left + rect.width / 2),
            event.clientY - (rect.top + rect.height / 2),
          ) <= radius;
        });
        const targetId = targetNode?.dataset.skillNodeId;
        if (!targetId) {
          showNotice('Drop the link on another skill circle.');
          return;
        }
        addDirectedEdge(currentGesture.sourceId, targetId);
        return;
      }

      if (!rfInstance) return;
      const sourceNode = nodes.find((node) => node.id === currentGesture.sourceId);
      if (!sourceNode) return;
      const flowPosition = rfInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const rect = flowWrapRef.current?.getBoundingClientRect();
      const releasePoint = rect
        ? { x: event.clientX - rect.left, y: event.clientY - rect.top }
        : currentGesture.current;
      const dragDistance = Math.hypot(
        releasePoint.x - currentGesture.start.x,
        releasePoint.y - currentGesture.start.y,
      );
      if (dragDistance < 10) return;

      let data: SkillNodeData | undefined;
      if (currentGesture.kind === 'createUpgrade') {
        data = {
          name: incrementUpgradeName(sourceNode.data.name),
          cost: { ...sourceNode.data.cost },
          upgrades: sourceNode.data.upgrades.map((upgrade) => ({ ...upgrade, id: uid('upgrade') })),
        };
      }

      const childId = createNodeAtFlowPosition(flowPosition, data);
      setEdges((current) => [...current, {
        id: uid('edge'),
        source: currentGesture.sourceId,
        target: childId,
        type: 'skillLink',
      }]);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [gesture, addDirectedEdge, createNodeAtFlowPosition, nodes, rfInstance, setEdges, showNotice]);

  const updateSelectedNode = useCallback((patch: Partial<SkillNodeData>) => {
    if (!selectedNodeId) return;
    setNodes((current) => current.map((node) =>
      node.id === selectedNodeId ? { ...node, data: { ...node.data, ...patch } } : node,
    ));
  }, [selectedNodeId, setNodes]);

  const updateSelectedPosition = useCallback((axis: 'x' | 'y', value: number) => {
    if (!selectedNodeId || !Number.isFinite(value)) return;
    setNodes((current) => current.map((node) =>
      node.id === selectedNodeId
        ? { ...node, position: { ...node.position, [axis]: value } }
        : node,
    ));
  }, [selectedNodeId, setNodes]);

  const deleteSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
    setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(null);
  }, [selectedNodeId, setNodes, setEdges]);

  const addUpgrade = () => {
    if (!selectedNode || stats.length === 0) return;
    const stat = stats[0];
    const upgrade: UpgradeEffect = {
      id: uid('upgrade'),
      statId: stat.id,
      operator: stat.type === 'number' ? 'add' : 'set',
      value: stat.type === 'number' ? 1 : true,
    };
    updateSelectedNode({ upgrades: [...selectedNode.data.upgrades, upgrade] });
  };

  const updateUpgrade = (upgradeId: string, patch: Partial<UpgradeEffect>) => {
    if (!selectedNode) return;
    updateSelectedNode({
      upgrades: selectedNode.data.upgrades.map((upgrade) => {
        if (upgrade.id !== upgradeId) return upgrade;
        const next = { ...upgrade, ...patch } as UpgradeEffect;
        if (patch.statId) {
          const stat = stats.find((item) => item.id === patch.statId);
          if (stat?.type === 'boolean') {
            next.operator = 'set';
            next.value = true;
          } else if (stat?.type === 'number') {
            next.operator = 'add';
            next.value = 1;
          }
        }
        return next;
      }),
    });
  };

  const removeUpgrade = (upgradeId: string) => {
    if (!selectedNode) return;
    updateSelectedNode({ upgrades: selectedNode.data.upgrades.filter((upgrade) => upgrade.id !== upgradeId) });
  };

  const addPrerequisite = () => {
    if (!selectedNodeId || !connectionChoice) return;
    addDirectedEdge(connectionChoice, selectedNodeId);
    setConnectionChoice('');
  };

  const removePrerequisite = (edgeId: string) => {
    setEdges((current) => current.filter((edge) => edge.id !== edgeId));
  };

  const addStatGroup = () => {
    const groupId = uid('stat-group');
    setStats((current) => {
      const groupName = 'New Group';
      const groupKey = uniqueGroupKey(statGameKeyFromDisplayName(groupName), current);
      const localKey = uniqueStatLocalKey(groupKey, 'new.stat', current);
      return [
        ...current,
        {
          id: uid('stat'),
          key: composeStatKey(groupKey, localKey),
          name: 'New Stat',
          type: 'number',
          groupId,
          groupName,
          groupKey,
        },
      ];
    });
  };

  const addStat = (groupId: string) => {
    setStats((current) => {
      const group = current.find((stat) => stat.groupId === groupId);
      if (!group) return current;
      const localKey = uniqueStatLocalKey(group.groupKey, 'new.stat', current);
      return [
        ...current,
        {
          id: uid('stat'),
          key: composeStatKey(group.groupKey, localKey),
          name: 'New Stat',
          type: 'number',
          groupId,
          groupName: group.groupName,
          groupKey: group.groupKey,
        },
      ];
    });
  };

  const updateStatGroup = (groupId: string, patch: { name?: string; key?: string }) => {
    setStats((current) => {
      const group = current.find((stat) => stat.groupId === groupId);
      if (!group) return current;
      const nextName = patch.name ?? group.groupName;
      const nextGroupKey = patch.key ?? (patch.name !== undefined ? statGameKeyFromDisplayName(nextName) : group.groupKey);
      return current.map((stat) => {
        if (stat.groupId !== groupId) return stat;
        const localKey = statLocalKey(stat);
        return {
          ...stat,
          groupName: nextName,
          groupKey: nextGroupKey,
          key: composeStatKey(nextGroupKey, localKey),
        };
      });
    });
  };

  const duplicateStatGroup = (groupId: string) => {
    setStats((current) => {
      const source = current.filter((stat) => stat.groupId === groupId);
      if (source.length === 0) return current;
      const groupName = `${source[0].groupName} Copy`;
      const groupKey = uniqueGroupKey(statGameKeyFromDisplayName(groupName), current);
      const nextGroupId = uid('stat-group');
      return [
        ...current,
        ...source.map((stat) => ({
          ...stat,
          id: uid('stat'),
          groupId: nextGroupId,
          groupName,
          groupKey,
          key: composeStatKey(groupKey, statLocalKey(stat)),
        })),
      ];
    });
  };

  const updateStat = (statId: string, patch: Partial<StatDefinition>) => {
    setStats((current) => current.map((stat) => (stat.id === statId ? { ...stat, ...patch } : stat)));
    if (patch.type) {
      setNodes((current) => current.map((node) => ({
        ...node,
        data: {
          ...node.data,
          upgrades: node.data.upgrades.map((upgrade) => {
            if (upgrade.statId !== statId) return upgrade;
            return patch.type === 'boolean'
              ? { ...upgrade, operator: 'set' as const, value: true }
              : { ...upgrade, operator: 'add' as const, value: 1 };
          }),
        },
      })));
    }
  };

  const updateStatLocalKey = (statId: string, localKey: string) => {
    setStats((current) => current.map((stat) => stat.id === statId
      ? { ...stat, key: composeStatKey(stat.groupKey, localKey) }
      : stat));
  };

  const deleteStat = (statId: string) => {
    setStats((current) => current.filter((stat) => stat.id !== statId));
    setNodes((current) => current.map((node) => ({
      ...node,
      data: { ...node.data, upgrades: node.data.upgrades.filter((upgrade) => upgrade.statId !== statId) },
    })));
  };

  const addCurrency = () => {
    const id = uid('currency');
    setCurrencies((current) => [
      ...current,
      { id, key: `currency.${current.length + 1}`, name: 'New Currency', symbol: '◇' },
    ]);
    setNodes((current) => current.map((node) =>
      node.data.cost.currencyId
        ? node
        : { ...node, data: { ...node.data, cost: { ...node.data.cost, currencyId: id } } },
    ));
  };

  const updateCurrency = (currencyId: string, patch: Partial<CurrencyDefinition>) => {
    setCurrencies((current) => current.map((currency) =>
      currency.id === currencyId ? { ...currency, ...patch } : currency,
    ));
  };

  const deleteCurrency = (currencyId: string) => {
    setCurrencies((current) => {
      const next = current.filter((currency) => currency.id !== currencyId);
      const replacement = next[0]?.id ?? '';
      setNodes((nodeList) => nodeList.map((node) =>
        node.data.cost.currencyId === currencyId
          ? { ...node, data: { ...node.data, cost: { ...node.data.cost, currencyId: replacement } } }
          : node,
      ));
      return next;
    });
  };

  const exportProject = () => {
    const project: PersistedProject = { version: 2, nodes, edges, stats, currencies };
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'skill-tree.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importProject = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    file.text().then((text) => {
      try {
        const project = migrateProject(JSON.parse(text));
        if (!project) throw new Error('Invalid project');
        setNodes(project.nodes);
        setEdges(project.edges);
        setStats(project.stats);
        setCurrencies(project.currencies);
        setSelectedNodeId(project.nodes[0]?.id ?? null);
        showNotice('Project imported. DAG validation applied.');
      } catch {
        window.alert('That file is not a valid skill tree project.');
      }
    });
  };

  const incomingEdges = selectedNodeId ? edges.filter((edge) => edge.target === selectedNodeId) : [];
  const selectedCurrency = currencies.find((currency) => currency.id === selectedNode?.data.cost.currencyId);

  const nodeLabels = useMemo(() => {
    const statMap = new Map(stats.map((stat) => [stat.id, stat]));
    const currencyMap = new Map(currencies.map((currency) => [currency.id, currency]));
    return buildNodeLabelLayout(
      nodes.map((node) => {
        const currency = currencyMap.get(node.data.cost.currencyId);
        return {
          id: node.id,
          position: node.position,
          name: node.data.name,
          currency: currency ? { symbol: currency.symbol, amount: node.data.cost.amount } : null,
          effects: node.data.upgrades.flatMap((upgrade) => {
            const stat = statMap.get(upgrade.statId);
            if (!stat) return [];
            return [{
              operator: upgrade.operator,
              value: upgrade.value,
              groupName: stat.groupName,
              statName: stat.name,
            }];
          }),
        };
      }),
      edges,
      { showCurrency: showNodeCurrency, showNames: showNodeNames, showStats: showNodeStats },
    );
  }, [currencies, edges, nodes, showNodeCurrency, showNodeNames, showNodeStats, stats]);

  const renderedEdges = useMemo<SkillLinkEdge[]>(() => {
    const nodeMap = new Map<string, SkillFlowNode>(nodes.map((node): [string, SkillFlowNode] => [node.id, node]));
    return edges.flatMap((edge) => {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) return [];
      return [{
        ...edge,
        type: 'skillLink' as const,
        data: {
          sourceCenter: { x: source.position.x + NODE_SIZE / 2, y: source.position.y + NODE_SIZE / 2 },
          targetCenter: { x: target.position.x + NODE_SIZE / 2, y: target.position.y + NODE_SIZE / 2 },
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 17,
          height: 17,
          color: '#5d6673',
        },
        style: { strokeWidth: 2 },
      }];
    });
  }, [edges, nodes]);

  const gestureLabel = gesture?.kind === 'link'
    ? 'Link prerequisite'
    : gesture?.kind === 'createUpgrade'
      ? 'Create upgrade copy'
      : 'Create blank child';

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark"><span /></div>
          <div>
            <div className="eyebrow">INCREMENTAL TD</div>
            <h1>Skill Tree Builder</h1>
          </div>
        </div>

        <nav className="view-switcher" aria-label="Editor view">
          <button className={activeView === 'tree' ? 'active' : ''} onClick={() => setActiveView('tree')}>
            <Icon name="tree" /> Skill tree
          </button>
          <button className={activeView === 'stats' ? 'active' : ''} onClick={() => setActiveView('stats')}>
            <Icon name="stats" /> Stat pool
          </button>
          <button className={activeView === 'currencies' ? 'active' : ''} onClick={() => setActiveView('currencies')}>
            <Icon name="currency" /> Currencies
          </button>
        </nav>

        <div className="top-actions">
          <span className="save-status"><i />{savedAt}</span>
          <button className="icon-button labeled" onClick={() => importRef.current?.click()}><Icon name="upload" /> Import</button>
          <button className="icon-button labeled" onClick={exportProject}><Icon name="download" /> Export</button>
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={importProject} />
        </div>
      </header>

      {activeView === 'tree' ? (
        <section className="tree-layout">
          <div className={`flow-panel${gesture ? ' is-gesturing' : ''}`} ref={flowWrapRef}>
            <div className="canvas-toolbar">
              <button className="primary-button" onClick={() => createNodeAt()}><Icon name="plus" /> Add skill</button>
            </div>

            <div className="canvas-display-toolbar" aria-label="Node display options">
              <button
                className={`canvas-icon-toggle${showNodeCurrency ? ' is-active' : ''}`}
                type="button"
                aria-label="Toggle node currency costs"
                aria-pressed={showNodeCurrency}
                title="Toggle node currency costs"
                onClick={() => setShowNodeCurrency((current) => !current)}
              >
                <Icon name="currency" />
              </button>
              <button
                className={`canvas-icon-toggle${showNodeNames ? ' is-active' : ''}`}
                type="button"
                aria-label="Toggle node names"
                aria-pressed={showNodeNames}
                title="Toggle node names"
                onClick={() => setShowNodeNames((current) => !current)}
              >
                <Icon name="nodeName" />
              </button>
              <button
                className={`canvas-icon-toggle${showNodeStats ? ' is-active' : ''}`}
                type="button"
                aria-label="Toggle node stat effects"
                aria-pressed={showNodeStats}
                title="Toggle node stat effects"
                onClick={() => setShowNodeStats((current) => !current)}
              >
                <Icon name="nodeStats" />
              </button>
            </div>

            <details className="shortcut-legend" open>
              <summary>Shortcuts</summary>
              <div className="shortcut-list">
                <div className="shortcut-row"><kbd>LMB drag node</kbd><span>Move node</span></div>
                <div className="shortcut-row"><kbd>Shift + LMB</kbd><span>Multi-select</span></div>
                <div className="shortcut-row"><kbd>Alt + LMB drag</kbd><span>Link prerequisite</span></div>
                <div className="shortcut-row"><kbd>Ctrl + LMB drag</kbd><span>Create blank child</span></div>
                <div className="shortcut-row"><kbd>Ctrl + RMB drag</kbd><span>Create upgrade child</span></div>
                <div className="shortcut-row"><kbd>MMB</kbd><span>Duplicate node</span></div>
                <div className="shortcut-row"><kbd>RMB drag</kbd><span>Pan canvas</span></div>
                <div className="shortcut-row"><kbd>Scroll wheel</kbd><span>Zoom canvas</span></div>
                <div className="shortcut-row"><kbd>Ctrl + C</kbd><span>Copy selected nodes</span></div>
                <div className="shortcut-row"><kbd>Ctrl + V</kbd><span>Paste with root parents</span></div>
                <div className="shortcut-row"><kbd>Ctrl + Shift + V</kbd><span>Paste as island</span></div>
                <div className="shortcut-row"><kbd>Delete / Backspace</kbd><span>Delete selection</span></div>
                <div className="shortcut-row"><kbd>Ctrl + Z</kbd><span>Undo</span></div>
                <div className="shortcut-row"><kbd>Ctrl + Shift + Z</kbd><span>Redo</span></div>
              </div>
            </details>

            {notice && <div className="canvas-notice">{notice}</div>}

            {gesture && (
              <svg className={`gesture-layer ${gesture.kind}`} aria-hidden="true">
                <defs>
                  <marker id="gesture-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" />
                  </marker>
                </defs>
                <line
                  x1={gesture.start.x}
                  y1={gesture.start.y}
                  x2={gesture.current.x}
                  y2={gesture.current.y}
                  markerEnd="url(#gesture-arrow)"
                />
                {gesture.kind !== 'link' && <circle cx={gesture.current.x} cy={gesture.current.y} r={NODE_RADIUS} />}
                <text x={gesture.current.x + 14} y={gesture.current.y - 14}>{gestureLabel}</text>
              </svg>
            )}

            <SkillInteractionContext.Provider value={{ beginGesture, duplicateNode, beginRightPan, nodeLabels }}>
              <ReactFlow<SkillFlowNode, SkillLinkEdge>
                nodes={nodes}
                edges={renderedEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onInit={setRfInstance}
                onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                onPaneClick={() => setSelectedNodeId(null)}
                onPaneContextMenu={(event) => event.preventDefault()}
                panOnDrag={[0, 2]}
                fitView
                fitViewOptions={{ padding: 0.25 }}
                minZoom={0.25}
                maxZoom={2.5}
                nodesConnectable={false}
                edgesReconnectable={false}
                defaultEdgeOptions={{ type: 'skillLink' }}
                deleteKeyCode={['Backspace', 'Delete']}
                multiSelectionKeyCode="Shift"
                proOptions={{ hideAttribution: true }}
                colorMode="dark"
              >
                <Controls showInteractive={false} position="bottom-left" />
              </ReactFlow>
            </SkillInteractionContext.Provider>
          </div>

          <aside className={`inspector${selectedNode ? ' has-selection' : ''}`}>
            <div className="inspector-heading">
              <div>
                <span className="section-kicker">INSPECTOR</span>
                <h2>{selectedNode ? selectedNode.data.name : 'No skill selected'}</h2>
              </div>
              {selectedNode && (
                <button className="ghost-icon" onClick={() => setSelectedNodeId(null)} aria-label="Close inspector selection">
                  <Icon name="close" />
                </button>
              )}
            </div>

            {!selectedNode ? (
              <div className="empty-inspector">
                <div className="empty-orbit"><span /></div>
                <h3>Select a skill</h3>
                <p>Choose a circle on the graph to edit its identity, position, cost, effects, and prerequisites.</p>
              </div>
            ) : (
              <div className="inspector-scroll">
                <section className="inspector-section">
                  <div className="section-title-row"><h3>Skill</h3><span className="id-chip">{selectedNode.id}</span></div>
                  <label className="field-label">Name
                    <input value={selectedNode.data.name} onChange={(e) => updateSelectedNode({ name: e.target.value })} />
                  </label>
                  <div className="field-grid cost-grid">
                    <label className="field-label">Currency
                      <select
                        value={selectedNode.data.cost.currencyId}
                        onChange={(e) => updateSelectedNode({ cost: { ...selectedNode.data.cost, currencyId: e.target.value } })}
                        disabled={currencies.length === 0}
                      >
                        {currencies.length === 0 && <option value="">No currencies</option>}
                        {currencies.map((currency) => <option key={currency.id} value={currency.id}>{currency.symbol} {currency.name}</option>)}
                      </select>
                    </label>
                    <label className="field-label">Cost
                      <div className="number-wrap"><span>{selectedCurrency?.symbol ?? '◇'}</span><input type="number" min="0" value={selectedNode.data.cost.amount} onChange={(e) => updateSelectedNode({ cost: { ...selectedNode.data.cost, amount: Number(e.target.value) } })} /></div>
                    </label>
                  </div>
                  <div className="field-grid">
                    <label className="field-label">X position
                      <input type="number" value={Math.round(selectedNode.position.x)} onChange={(e) => updateSelectedPosition('x', Number(e.target.value))} />
                    </label>
                    <label className="field-label">Y position
                      <input type="number" value={Math.round(selectedNode.position.y)} onChange={(e) => updateSelectedPosition('y', Number(e.target.value))} />
                    </label>
                  </div>
                </section>

                <section className="inspector-section">
                  <div className="section-title-row">
                    <div><h3>Upgrade stats</h3><p>Typed effects applied when purchased.</p></div>
                    <button className="small-button" onClick={addUpgrade} disabled={stats.length === 0}><Icon name="plus" /> Add</button>
                  </div>
                  {selectedNode.data.upgrades.length === 0 ? (
                    <div className="inline-empty">No effects yet. Add one from your stat pool.</div>
                  ) : (
                    <div className="upgrade-stack">
                      {selectedNode.data.upgrades.map((upgrade, index) => {
                        const stat = stats.find((item) => item.id === upgrade.statId);
                        const statType = stat?.type ?? 'number';
                        return (
                          <div className="upgrade-card" key={upgrade.id}>
                            <div className="upgrade-card-head"><span>Effect {index + 1}</span><button onClick={() => removeUpgrade(upgrade.id)} aria-label="Remove effect"><Icon name="trash" /></button></div>
                            <label className="field-label compact">Stat
                              <select value={upgrade.statId} onChange={(e) => updateUpgrade(upgrade.id, { statId: e.target.value })}>
                                {statGroups.map((group) => (
                                  <optgroup key={group.id} label={group.name}>
                                    {group.stats.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                                  </optgroup>
                                ))}
                              </select>
                            </label>
                            <div className="field-grid effect-grid">
                              <label className="field-label compact">Modifier
                                <select value={upgrade.operator} onChange={(e) => updateUpgrade(upgrade.id, { operator: e.target.value as UpgradeOperator })}>
                                  {statType === 'number' ? (
                                    <>
                                      <option value="add">Add (+)</option>
                                      <option value="subtract">Subtract (−)</option>
                                      <option value="multiply">Multiply (×)</option>
                                      <option value="divide">Divide (÷)</option>
                                    </>
                                  ) : <option value="set">Set</option>}
                                </select>
                              </label>
                              <label className="field-label compact">Value
                                {statType === 'number' ? (
                                  <input type="number" step="any" value={Number(upgrade.value)} onChange={(e) => updateUpgrade(upgrade.id, { value: Number(e.target.value) })} />
                                ) : (
                                  <select value={String(Boolean(upgrade.value))} onChange={(e) => updateUpgrade(upgrade.id, { value: e.target.value === 'true' })}>
                                    <option value="true">On</option>
                                    <option value="false">Off</option>
                                  </select>
                                )}
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="inspector-section">
                  <div className="section-title-row"><div><h3>Prerequisites</h3><p>Directed incoming links. DAG rules are enforced.</p></div></div>
                  <div className="connection-add">
                    <select value={connectionChoice} onChange={(e) => setConnectionChoice(e.target.value)}>
                      <option value="">Choose a skill…</option>
                      {nodes.filter((node) => node.id !== selectedNode.id).map((node) => {
                        const issue = edgeIssue(node.id, selectedNode.id, edges);
                        return <option key={node.id} value={node.id} disabled={Boolean(issue)}>{node.data.name}{issue ? ' — unavailable' : ''}</option>;
                      })}
                    </select>
                    <button className="small-button square" onClick={addPrerequisite} disabled={!connectionChoice}><Icon name="link" /></button>
                  </div>
                  <div className="prereq-list">
                    {incomingEdges.length === 0 && <div className="inline-empty">This is currently a root skill.</div>}
                    {incomingEdges.map((edge) => {
                      const source = nodes.find((node) => node.id === edge.source);
                      return (
                        <div className="prereq-row" key={edge.id}>
                          <span className="mini-node" />
                          <span>{source?.data.name ?? edge.source}</span>
                          <button onClick={() => removePrerequisite(edge.id)} aria-label="Remove prerequisite"><Icon name="close" /></button>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="inspector-section danger-section">
                  <button className="danger-button" onClick={deleteSelectedNode}><Icon name="trash" /> Delete skill</button>
                </section>
              </div>
            )}
          </aside>
        </section>
      ) : activeView === 'stats' ? (
        <section className="stat-pool-view">
          <div className="stat-pool-head">
            <div>
              <span className="section-kicker">CONFIGURATION</span>
              <h2>Stat pool</h2>
              <p>Organize typed stat lines into game-key groups used by skill effects.</p>
            </div>
            <button className="primary-button" onClick={addStatGroup}><Icon name="plus" /> Add group</button>
          </div>

          {stats.length === 0 ? (
            <div className="stat-table-card">
              <div className="stat-empty"><h3>No stat groups configured</h3><p>Add a group to create stat lines for skill effects.</p></div>
            </div>
          ) : (
            <div className="stat-group-list">
              {statGroups.map((group) => (
                <section className="stat-group-card" key={group.id}>
                  <div className="stat-group-head">
                    <div className="stat-group-fields">
                      <label>
                        <span>Group name</span>
                        <input value={group.name} onChange={(e) => updateStatGroup(group.id, { name: e.target.value })} />
                      </label>
                      <label>
                        <span>Group game key</span>
                        <input className="mono-input" value={group.key} onChange={(e) => updateStatGroup(group.id, { key: e.target.value })} />
                      </label>
                    </div>
                    <div className="stat-group-actions">
                      <button className="small-button" onClick={() => duplicateStatGroup(group.id)}>Duplicate group</button>
                      <button className="small-button" onClick={() => addStat(group.id)}><Icon name="plus" /> Add stat</button>
                    </div>
                  </div>
                  <div className="stat-table-card">
                    <div className="stat-table-header">
                      <span>Display name</span><span>Game key</span><span>Type</span><span>Used by</span><span />
                    </div>
                    {group.stats.map((stat) => {
                      const usage = nodes.reduce((total, node) => total + node.data.upgrades.filter((upgrade) => upgrade.statId === stat.id).length, 0);
                      return (
                        <div className="stat-row" key={stat.id}>
                          <label><span className="mobile-label">Display name</span><input value={stat.name} onChange={(e) => updateStat(stat.id, { name: e.target.value })} /></label>
                          <label className="stat-key-label">
                            <span className="mobile-label">Game key</span>
                            <span className="stat-key-composer">
                              {group.key && <span className="stat-key-prefix">{group.key}.</span>}
                              <input className="mono-input" value={statLocalKey(stat)} onChange={(e) => updateStatLocalKey(stat.id, e.target.value)} />
                            </span>
                          </label>
                          <label><span className="mobile-label">Type</span><select value={stat.type} onChange={(e) => updateStat(stat.id, { type: e.target.value as StatType })}><option value="number">Number</option><option value="boolean">Toggle</option></select></label>
                          <div className="usage-cell"><span className={`type-dot ${stat.type}`} />{usage} effect{usage === 1 ? '' : 's'}</div>
                          <button className="row-delete" onClick={() => deleteStat(stat.id)} aria-label={`Delete ${stat.name}`}><Icon name="trash" /></button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}

          <div className="type-reference">
            <div className="reference-card">
              <span className="type-icon number">#</span>
              <div><h3>Number</h3><p>Supports addition, subtraction, multiplication, and division with a numeric value.</p></div>
            </div>
            <div className="reference-card">
              <span className="type-icon boolean">●</span>
              <div><h3>Toggle</h3><p>Supports a single <code>set</code> modifier with an explicit on or off value.</p></div>
            </div>
          </div>
        </section>
      ) : (
        <section className="stat-pool-view currency-pool-view">
          <div className="stat-pool-head">
            <div>
              <span className="section-kicker">CONFIGURATION</span>
              <h2>Currencies</h2>
              <p>Define the currencies that can be assigned to skill purchase costs.</p>
            </div>
            <button className="primary-button" onClick={addCurrency}><Icon name="plus" /> Add currency</button>
          </div>

          <div className="stat-table-card">
            <div className="currency-table-header">
              <span>Display name</span><span>Game key</span><span>Symbol</span><span>Used by</span><span />
            </div>
            {currencies.length === 0 ? (
              <div className="stat-empty"><h3>No currencies configured</h3><p>Add a currency to make it available for skill costs.</p></div>
            ) : currencies.map((currency) => {
              const usage = nodes.filter((node) => node.data.cost.currencyId === currency.id).length;
              return (
                <div className="currency-row" key={currency.id}>
                  <label><span className="mobile-label">Display name</span><input value={currency.name} onChange={(e) => updateCurrency(currency.id, { name: e.target.value })} /></label>
                  <label><span className="mobile-label">Game key</span><input className="mono-input" value={currency.key} onChange={(e) => updateCurrency(currency.id, { key: e.target.value })} /></label>
                  <label><span className="mobile-label">Symbol</span><input className="symbol-input" value={currency.symbol} maxLength={4} onChange={(e) => updateCurrency(currency.id, { symbol: e.target.value })} /></label>
                  <div className="usage-cell"><span className="currency-preview">{currency.symbol || '◇'}</span>{usage} skill{usage === 1 ? '' : 's'}</div>
                  <button className="row-delete" onClick={() => deleteCurrency(currency.id)} aria-label={`Delete ${currency.name}`}><Icon name="trash" /></button>
                </div>
              );
            })}
          </div>

          <div className="type-reference single-reference">
            <div className="reference-card">
              <span className="type-icon currency">◇</span>
              <div><h3>Game-facing currency IDs</h3><p>Use stable game keys in exported data; display names and symbols can stay presentation-only.</p></div>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

export default App;
