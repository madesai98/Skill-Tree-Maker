import {
  Background,
  Controls,
  Node,
  NodeChange,
  NodeProps,
  ReactFlow,
  ReactFlowInstance,
  applyNodeChanges,
} from '@xyflow/react';
import {
  Dispatch,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { buildNodeLabelLayout, type NodeLabelView } from './nodeLabelLayout';
import { IconPicker, svgDataUrl, type IconAsset } from './iconPool';

type StatType = 'number' | 'boolean';
type NumberOperator = 'add' | 'subtract' | 'multiply' | 'divide';
type UpgradeOperator = NumberOperator | 'set';

type StatDefinition = {
  id: string;
  key: string;
  name: string;
  type: StatType;
  baseValue: number | boolean;
  iconId: string | null;
  groupId: string;
  groupName: string;
  groupKey: string;
  groupIconId: string | null;
  groupColor: string;
};

type UpgradeEffect = {
  id: string;
  statId: string;
  operator: UpgradeOperator;
  value: number | boolean;
};

type PerkNodeData = {
  name: string;
  upgrades: UpgradeEffect[];
  primaryIconId: string | null;
  secondaryIconId: string | null;
  secondaryColor: string | null;
};

export type PerkFlowNode = Node<PerkNodeData, 'skill'>;
type SkillLikeNode = Node<PerkNodeData, 'skill'>;

type PerksViewProps = {
  perks: PerkFlowNode[];
  setPerks: Dispatch<SetStateAction<PerkFlowNode[]>>;
  skills: SkillLikeNode[];
  stats: StatDefinition[];
  icons: IconAsset[];
  gridSize: number;
  setGridSize: Dispatch<SetStateAction<number>>;
  onAddIcon: (file: File) => Promise<string | null>;
};

type PerkVisual = {
  primaryIcon: IconAsset | null;
  secondaryIcon: IconAsset | null;
  secondaryColor: string;
};

type InteractionContextValue = {
  duplicatePerk: (id: string) => void;
  beginRightPan: (event: ReactPointerEvent<HTMLDivElement>) => void;
  labels: ReadonlyMap<string, NodeLabelView>;
  visuals: ReadonlyMap<string, PerkVisual>;
};

const InteractionContext = createContext<InteractionContextValue | null>(null);
const MIN_GRID_SIZE = 72;
const MAX_GRID_SIZE = 320;

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeColor(value: unknown, fallback = '#b6ff56') {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function perkIdFromName(name: string) {
  return name.toLowerCase().replaceAll(' ', '.');
}

function uniquePerkName(baseName: string, perks: PerkFlowNode[], excludeId?: string) {
  const base = baseName.trim() || 'New Perk';
  const usedNames = new Set(perks.filter((perk) => perk.id !== excludeId).map((perk) => perk.data.name.trim().toLowerCase()));
  const usedIds = new Set(perks.filter((perk) => perk.id !== excludeId).map((perk) => perk.id));
  if (!usedNames.has(base.toLowerCase()) && !usedIds.has(perkIdFromName(base))) return base;
  let index = 2;
  while (usedNames.has(`${base} ${index}`.toLowerCase()) || usedIds.has(perkIdFromName(`${base} ${index}`))) index += 1;
  return `${base} ${index}`;
}

function MaskedSvgIcon({ icon, color, className }: { icon: IconAsset | null | undefined; color: string; className: string }) {
  if (!icon) return null;
  const url = `url("${svgDataUrl(icon.svg)}")`;
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        backgroundColor: color,
        WebkitMaskImage: url,
        maskImage: url,
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
      }}
    />
  );
}

function ToolbarIcon({ name }: { name: 'plus' | 'name' | 'stats' | 'trash' | 'close' }) {
  const path = name === 'plus'
    ? <path d="M12 5v14M5 12h14" />
    : name === 'name'
        ? <><path d="M5 6h14M12 6v12M8.5 18h7" /><path d="M7 9V6m10 3V6" /></>
        : name === 'stats'
          ? <><path d="M4 6h7m4 0h5M4 12h3m4 0h9M4 18h9m4 0h3" /><path d="M13 4v4M9 10v4M15 16v4" /></>
          : name === 'trash'
            ? <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" />
            : <path d="m6 6 12 12M18 6 6 18" />;
  return <svg viewBox="0 0 24 24" aria-hidden="true">{path}</svg>;
}

function PerkNode({ id, selected }: NodeProps<PerkFlowNode>) {
  const interaction = useContext(InteractionContext);
  const label = interaction?.labels.get(id);
  const visual = interaction?.visuals.get(id);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const distance = Math.hypot(
      event.clientX - (rect.left + rect.width / 2),
      event.clientY - (rect.top + rect.height / 2),
    );
    if (distance > Math.min(rect.width, rect.height) / 2) return;
    if (event.button === 1) {
      event.preventDefault();
      event.stopPropagation();
      interaction?.duplicatePerk(id);
      return;
    }
    if (event.button === 2 && !event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      interaction?.beginRightPan(event);
    }
  };

  return (
    <div
      className={`skill-node perk-node${selected ? ' is-selected' : ''}`}
      data-perk-node-id={id}
      aria-label="Perk node"
      onPointerDown={onPointerDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {visual?.secondaryIcon && <MaskedSvgIcon icon={visual.secondaryIcon} color={visual.secondaryColor} className="skill-node-secondary-icon" />}
      {visual?.primaryIcon
        ? <MaskedSvgIcon icon={visual.primaryIcon} color="#ffffff" className="skill-node-primary-icon" />
        : <span className="skill-node-primary-fallback" aria-hidden="true" />}
      {label && (
        <div className="skill-node-label" style={{ left: `${label.left}px`, top: `${label.top}px`, width: `${label.width}px`, textAlign: label.align }} aria-hidden="true">
          {label.name && <div className="skill-node-label-name" style={{ color: visual?.secondaryColor ?? '#ffffff' }}>{label.name}</div>}
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
    </div>
  );
}

const nodeTypes = { skill: PerkNode };

function snapPosition(position: { x: number; y: number }, gridSize: number) {
  return { x: Math.round(position.x / gridSize) * gridSize, y: Math.round(position.y / gridSize) * gridSize };
}

function PerksView({ perks, setPerks, skills, stats, icons, gridSize, setGridSize, onAddIcon }: PerksViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(perks[0]?.id ?? null);
  const [showNames, setShowNames] = useState(true);
  const [showStats, setShowStats] = useState(true);
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance<PerkFlowNode> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const noticeTimer = useRef<number | null>(null);
  const suppressContextMenuUntilRef = useRef(0);
  const clipboardRef = useRef<PerkFlowNode[] | null>(null);
  const pasteCountRef = useRef(0);
  const flowWrapRef = useRef<HTMLDivElement>(null);

  const selectedPerk = perks.find((perk) => perk.id === selectedId) ?? null;
  const statMap = useMemo(() => new Map(stats.map((stat) => [stat.id, stat])), [stats]);
  const iconMap = useMemo(() => new Map(icons.map((icon) => [icon.id, icon])), [icons]);
  const iconIds = useMemo(() => new Set(icons.map((icon) => icon.id)), [icons]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2200);
  }, []);

  useEffect(() => () => { if (noticeTimer.current) window.clearTimeout(noticeTimer.current); }, []);
  useEffect(() => { if (selectedId && !perks.some((perk) => perk.id === selectedId)) setSelectedId(null); }, [perks, selectedId]);
  useEffect(() => { setNameDraft(selectedPerk?.data.name ?? ''); }, [selectedPerk?.id, selectedPerk?.data.name]);
  useEffect(() => {
    const prevent = (event: MouseEvent) => { if (Date.now() < suppressContextMenuUntilRef.current) event.preventDefault(); };
    window.addEventListener('contextmenu', prevent);
    return () => window.removeEventListener('contextmenu', prevent);
  }, []);

  const statGroups = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; stats: StatDefinition[] }>();
    stats.forEach((stat) => {
      const group = groups.get(stat.groupId);
      if (group) group.stats.push(stat);
      else groups.set(stat.groupId, { id: stat.groupId, name: stat.groupName, stats: [stat] });
    });
    return [...groups.values()];
  }, [stats]);

  const booleanStatUsedElsewhere = useCallback((statId: string, upgradeId?: string) =>
    [...skills, ...perks].some((node) => node.data.upgrades.some((upgrade) => upgrade.statId === statId && upgrade.id !== upgradeId)),
  [perks, skills]);

  const cloneData = useCallback((data: PerkNodeData): PerkNodeData => ({
    name: data.name,
    upgrades: data.upgrades.filter((upgrade) => statMap.get(upgrade.statId)?.type !== 'boolean').map((upgrade) => ({ ...upgrade, id: uid('upgrade') })),
    primaryIconId: data.primaryIconId,
    secondaryIconId: data.secondaryIconId,
    secondaryColor: data.secondaryColor,
  }), [statMap]);

  const findOpenPosition = useCallback((preferred?: { x: number; y: number }, extraOccupied: PerkFlowNode[] = []) => {
    const origin = snapPosition(preferred ?? { x: 0, y: 0 }, gridSize);
    const originCol = Math.round(origin.x / gridSize);
    const originRow = Math.round(origin.y / gridSize);
    const occupied = new Set([...perks, ...extraOccupied].map((perk) => `${Math.round(perk.position.x / gridSize)}:${Math.round(perk.position.y / gridSize)}`));
    for (let radius = 0; radius < 100; radius += 1) {
      for (let y = -radius; y <= radius; y += 1) {
        for (let x = -radius; x <= radius; x += 1) {
          if (radius > 0 && Math.max(Math.abs(x), Math.abs(y)) !== radius) continue;
          const col = originCol + x;
          const row = originRow + y;
          if (!occupied.has(`${col}:${row}`)) return { x: col * gridSize, y: row * gridSize };
        }
      }
    }
    return { x: origin.x + gridSize, y: origin.y + gridSize };
  }, [gridSize, perks]);

  const updatePerk = useCallback((id: string, patch: Partial<PerkNodeData>) => {
    setPerks((current) => current.map((perk) => perk.id === id ? { ...perk, data: { ...perk.data, ...patch } } : perk));
  }, [setPerks]);

  const addPerk = useCallback(() => {
    let preferred = { x: 0, y: 0 };
    if (rfInstance && flowWrapRef.current) {
      const rect = flowWrapRef.current.getBoundingClientRect();
      preferred = rfInstance.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    }
    const name = uniquePerkName('New Perk', perks);
    const id = perkIdFromName(name);
    const node: PerkFlowNode = {
      id,
      type: 'skill',
      position: findOpenPosition(preferred),
      data: { name, upgrades: [], primaryIconId: null, secondaryIconId: null, secondaryColor: null },
      selected: true,
    };
    setPerks((current) => [...current.map((perk) => ({ ...perk, selected: false })), node]);
    setSelectedId(id);
  }, [findOpenPosition, perks, rfInstance, setPerks]);

  const duplicatePerk = useCallback((id: string) => {
    const source = perks.find((perk) => perk.id === id);
    if (!source) return;
    const name = uniquePerkName(`${source.data.name} Copy`, perks);
    const duplicate: PerkFlowNode = {
      id: perkIdFromName(name),
      type: 'skill',
      position: findOpenPosition({ x: source.position.x + gridSize, y: source.position.y }),
      data: { ...cloneData(source.data), name },
      selected: true,
    };
    setPerks((current) => [...current.map((perk) => ({ ...perk, selected: false })), duplicate]);
    setSelectedId(duplicate.id);
    showNotice('Perk duplicated.');
  }, [cloneData, findOpenPosition, gridSize, perks, setPerks, showNotice]);

  const beginRightPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!rfInstance) return;
    const start = { x: event.clientX, y: event.clientY };
    const initial = rfInstance.getViewport();
    suppressContextMenuUntilRef.current = Date.now() + 1200;
    const onMove = (moveEvent: PointerEvent) => void rfInstance.setViewport({ x: initial.x + moveEvent.clientX - start.x, y: initial.y + moveEvent.clientY - start.y, zoom: initial.zoom });
    const onUp = () => { suppressContextMenuUntilRef.current = Date.now() + 250; window.removeEventListener('pointermove', onMove); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }, [rfInstance]);

  const onNodesChange = useCallback((changes: NodeChange<PerkFlowNode>[]) => {
    setPerks((current) => applyNodeChanges(changes, current));
    if (selectedId && changes.some((change) => change.type === 'remove' && change.id === selectedId)) setSelectedId(null);
  }, [selectedId, setPerks]);

  const changeGridSize = useCallback((nextRaw: number) => {
    if (!Number.isFinite(nextRaw)) return;
    const next = Math.max(MIN_GRID_SIZE, Math.min(MAX_GRID_SIZE, Math.round(nextRaw)));
    if (next === gridSize) return;
    setPerks((current) => current.map((perk) => ({ ...perk, position: { x: Math.round(perk.position.x / gridSize) * next, y: Math.round(perk.position.y / gridSize) * next } })));
    setGridSize(next);
  }, [gridSize, setGridSize, setPerks]);

  const copySelected = useCallback(() => {
    let selected = perks.filter((perk) => perk.selected);
    if (selected.length === 0 && selectedPerk) selected = [selectedPerk];
    if (selected.length === 0) { showNotice('Select at least one perk to copy.'); return; }
    clipboardRef.current = selected.map((perk) => ({ ...perk, position: { ...perk.position }, data: cloneData(perk.data), selected: false }));
    pasteCountRef.current = 0;
    showNotice(`Copied ${selected.length} perk${selected.length === 1 ? '' : 's'}.`);
  }, [cloneData, perks, selectedPerk, showNotice]);

  const pasteCopied = useCallback(() => {
    const snapshot = clipboardRef.current;
    if (!snapshot?.length) { showNotice('Copy one or more perks first.'); return; }
    pasteCountRef.current += 1;
    const added: PerkFlowNode[] = [];
    snapshot.forEach((source) => {
      const name = uniquePerkName(source.data.name, [...perks, ...added]);
      const preferred = { x: source.position.x + gridSize * pasteCountRef.current, y: source.position.y + gridSize * pasteCountRef.current };
      added.push({ id: perkIdFromName(name), type: 'skill', position: findOpenPosition(preferred, added), data: { ...cloneData(source.data), name }, selected: true });
    });
    setPerks((current) => [...current.map((perk) => ({ ...perk, selected: false })), ...added]);
    setSelectedId(added[0]?.id ?? null);
    showNotice(`Pasted ${added.length} perk${added.length === 1 ? '' : 's'}.`);
  }, [cloneData, findOpenPosition, gridSize, perks, setPerks, showNotice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (event.key.toLowerCase() === 'c' && !event.shiftKey) { event.preventDefault(); copySelected(); }
      else if (event.key.toLowerCase() === 'v') { event.preventDefault(); pasteCopied(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [copySelected, pasteCopied]);

  const commitName = useCallback(() => {
    if (!selectedPerk) return;
    const nextName = nameDraft.trim();
    if (!nextName) { setNameDraft(selectedPerk.data.name); showNotice('Perk names cannot be empty.'); return; }
    const nextId = perkIdFromName(nextName);
    const duplicate = perks.some((perk) => perk.id !== selectedPerk.id && (perk.data.name.trim().toLowerCase() === nextName.toLowerCase() || perk.id === nextId));
    if (duplicate) { setNameDraft(selectedPerk.data.name); showNotice('Perk names must be unique.'); return; }
    if (nextName === selectedPerk.data.name && nextId === selectedPerk.id) return;
    setPerks((current) => current.map((perk) => perk.id === selectedPerk.id ? { ...perk, id: nextId, data: { ...perk.data, name: nextName } } : perk));
    setSelectedId(nextId);
  }, [nameDraft, perks, selectedPerk, setPerks, showNotice]);

  const addUpgrade = () => {
    if (!selectedPerk) return;
    const stat = stats.find((item) => item.type === 'number' || !booleanStatUsedElsewhere(item.id));
    if (!stat) { showNotice('Every toggle stat is already assigned.'); return; }
    updatePerk(selectedPerk.id, { upgrades: [...selectedPerk.data.upgrades, { id: uid('upgrade'), statId: stat.id, operator: stat.type === 'number' ? 'add' : 'set', value: stat.type === 'number' ? 1 : true }] });
  };

  const updateUpgrade = (upgradeId: string, patch: Partial<UpgradeEffect>) => {
    if (!selectedPerk) return;
    if (patch.statId) {
      const nextStat = statMap.get(patch.statId);
      if (nextStat?.type === 'boolean' && booleanStatUsedElsewhere(nextStat.id, upgradeId)) { showNotice('That toggle stat is already assigned to another node.'); return; }
    }
    updatePerk(selectedPerk.id, { upgrades: selectedPerk.data.upgrades.map((upgrade) => {
      if (upgrade.id !== upgradeId) return upgrade;
      const next = { ...upgrade, ...patch } as UpgradeEffect;
      if (patch.statId) {
        const nextStat = statMap.get(patch.statId);
        if (nextStat?.type === 'boolean') { next.operator = 'set'; next.value = true; }
        else if (nextStat?.type === 'number') { next.operator = 'add'; next.value = 1; }
      }
      return next;
    }) });
  };

  const removeUpgrade = (upgradeId: string) => {
    if (selectedPerk) updatePerk(selectedPerk.id, { upgrades: selectedPerk.data.upgrades.filter((upgrade) => upgrade.id !== upgradeId) });
  };

  const selectedFirstStat = selectedPerk?.data.upgrades[0] ? statMap.get(selectedPerk.data.upgrades[0].statId) : undefined;

  const visuals = useMemo<ReadonlyMap<string, PerkVisual>>(() => new Map(perks.map((perk) => {
    const firstStat = perk.data.upgrades[0] ? statMap.get(perk.data.upgrades[0].statId) : undefined;
    const primaryId = perk.data.primaryIconId ?? firstStat?.iconId ?? null;
    const secondaryId = perk.data.secondaryIconId ?? firstStat?.groupIconId ?? null;
    return [perk.id, {
      primaryIcon: primaryId && iconIds.has(primaryId) ? iconMap.get(primaryId) ?? null : null,
      secondaryIcon: secondaryId && iconIds.has(secondaryId) ? iconMap.get(secondaryId) ?? null : null,
      secondaryColor: perk.data.secondaryColor ?? (firstStat ? normalizeColor(firstStat.groupColor, '#ffffff') : '#ffffff'),
    }];
  })), [iconIds, iconMap, perks, statMap]);

  const labels = useMemo(() => buildNodeLabelLayout(perks.map((perk) => ({
      id: perk.id,
      position: perk.position,
      name: perk.data.name,
      currency: null,
      effects: perk.data.upgrades.flatMap((upgrade) => {
        const stat = statMap.get(upgrade.statId);
        return stat ? [{ operator: upgrade.operator, value: upgrade.value, groupName: stat.groupName, statName: stat.name }] : [];
      }),
  })), [], { showCurrency: false, showNames, showStats }), [perks, showNames, showStats, statMap]);

  const selectedVisual = selectedPerk ? visuals.get(selectedPerk.id) ?? null : null;
  const hasAvailableUpgradeStat = stats.some((stat) => stat.type === 'number' || !booleanStatUsedElsewhere(stat.id));

  return (
    <section className="tree-layout perks-layout">
      <div className="flow-panel perks-flow-panel" ref={flowWrapRef}>
        <div className="canvas-toolbar perks-canvas-toolbar">
          <button className="primary-button" onClick={addPerk}><ToolbarIcon name="plus" /> Add perk</button>
          <label className="perk-grid-size-control"><span>Grid size</span><input type="number" min={MIN_GRID_SIZE} max={MAX_GRID_SIZE} step="4" value={gridSize} onChange={(event) => changeGridSize(Number(event.target.value))} /><span>px</span></label>
        </div>
        <div className="canvas-display-toolbar" aria-label="Perk display options">
          <button className={`canvas-icon-toggle${showNames ? ' is-active' : ''}`} type="button" aria-label="Toggle perk names" aria-pressed={showNames} onClick={() => setShowNames((value) => !value)}><ToolbarIcon name="name" /></button>
          <button className={`canvas-icon-toggle${showStats ? ' is-active' : ''}`} type="button" aria-label="Toggle perk stat effects" aria-pressed={showStats} onClick={() => setShowStats((value) => !value)}><ToolbarIcon name="stats" /></button>
        </div>
        <details className="shortcut-legend" open>
          <summary>Shortcuts</summary>
          <div className="shortcut-list">
            <div className="shortcut-row"><kbd>LMB drag node</kbd><span>Move to grid cell</span></div>
            <div className="shortcut-row"><kbd>Shift + LMB</kbd><span>Multi-select</span></div>
            <div className="shortcut-row"><kbd>MMB</kbd><span>Duplicate perk</span></div>
            <div className="shortcut-row"><kbd>RMB drag</kbd><span>Pan canvas</span></div>
            <div className="shortcut-row"><kbd>Scroll wheel</kbd><span>Zoom canvas</span></div>
            <div className="shortcut-row"><kbd>Ctrl + C</kbd><span>Copy selected perks</span></div>
            <div className="shortcut-row"><kbd>Ctrl + V</kbd><span>Paste perks</span></div>
            <div className="shortcut-row"><kbd>Delete / Backspace</kbd><span>Delete selection</span></div>
            <div className="shortcut-row"><kbd>Ctrl + Z</kbd><span>Undo</span></div>
            <div className="shortcut-row"><kbd>Ctrl + Shift + Z</kbd><span>Redo</span></div>
          </div>
        </details>
        {notice && <div className="canvas-notice">{notice}</div>}
        <InteractionContext.Provider value={{ duplicatePerk, beginRightPan, labels, visuals }}>
          <ReactFlow<PerkFlowNode>
            nodes={perks}
            edges={[]}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onInit={setRfInstance}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            onPaneContextMenu={(event) => event.preventDefault()}
            panOnDrag={[0, 2]}
            snapToGrid
            snapGrid={[gridSize, gridSize]}
            fitView
            fitViewOptions={{ padding: 0.28 }}
            minZoom={0.25}
            maxZoom={2.5}
            nodesDraggable
            elementsSelectable
            nodesConnectable={false}
            edgesReconnectable={false}
            deleteKeyCode={['Backspace', 'Delete']}
            multiSelectionKeyCode="Shift"
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
          >
            <Background gap={gridSize} size={1.25} />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
        </InteractionContext.Provider>
      </div>

      <aside className={`inspector${selectedPerk ? ' has-selection' : ''}`}>
        <div className="inspector-heading">
          <div><span className="section-kicker">PERK INSPECTOR</span><h2>{selectedPerk ? selectedPerk.data.name : 'No perk selected'}</h2></div>
          {selectedPerk && <button className="ghost-icon" onClick={() => setSelectedId(null)} aria-label="Close perk selection"><ToolbarIcon name="close" /></button>}
        </div>
        {!selectedPerk ? (
          <div className="empty-inspector"><div className="empty-orbit"><span /></div><h3>Select a perk</h3><p>Choose a circle on the grid to edit its identity, appearance, stat effects, and grid cell.</p></div>
        ) : (
          <div className="inspector-scroll">
            <section className="inspector-section">
              <div className="section-title-row"><h3>Perk</h3><span className="id-chip">{selectedPerk.id}</span></div>
              <label className="field-label">Name<input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} onBlur={commitName} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
              <div className="perk-id-note">ID/key is generated from the name: lowercase with spaces replaced by periods.</div>
              <div className="field-grid">
                <label className="field-label">Grid column<input type="number" step="1" value={Math.round(selectedPerk.position.x / gridSize)} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setPerks((current) => current.map((perk) => perk.id === selectedPerk.id ? { ...perk, position: { ...perk.position, x: Math.round(value) * gridSize } } : perk)); }} /></label>
                <label className="field-label">Grid row<input type="number" step="1" value={Math.round(selectedPerk.position.y / gridSize)} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setPerks((current) => current.map((perk) => perk.id === selectedPerk.id ? { ...perk, position: { ...perk.position, y: Math.round(value) * gridSize } } : perk)); }} /></label>
              </div>
            </section>

            <section className="inspector-section node-appearance-section">
              <div className="section-title-row"><div><h3>Node appearance</h3><p>Empty icon slots inherit from the first upgrade stat.</p></div></div>
              <div className="node-appearance-icons">
                <label className="field-label compact">Primary icon<IconPicker icons={icons} value={selectedPerk.data.primaryIconId} ariaLabel={`${selectedPerk.data.name} primary icon override`} onChange={(primaryIconId) => updatePerk(selectedPerk.id, { primaryIconId })} onUpload={async (file) => { const primaryIconId = await onAddIcon(file); if (primaryIconId) { updatePerk(selectedPerk.id, { primaryIconId }); showNotice('SVG added to the icon pool.'); } }} /></label>
                <label className="field-label compact">Secondary icon<IconPicker icons={icons} value={selectedPerk.data.secondaryIconId} ariaLabel={`${selectedPerk.data.name} secondary icon override`} onChange={(secondaryIconId) => updatePerk(selectedPerk.id, { secondaryIconId })} onUpload={async (file) => { const secondaryIconId = await onAddIcon(file); if (secondaryIconId) { updatePerk(selectedPerk.id, { secondaryIconId }); showNotice('SVG added to the icon pool.'); } }} /></label>
              </div>
              <label className="field-label">Secondary color
                <div className="node-color-control"><input type="color" value={selectedVisual?.secondaryColor ?? '#ffffff'} aria-label="Secondary icon and perk name color" onChange={(event) => updatePerk(selectedPerk.id, { secondaryColor: event.target.value })} /><button type="button" className="small-button" disabled={selectedPerk.data.secondaryColor === null} onClick={() => updatePerk(selectedPerk.id, { secondaryColor: null })}>Auto</button><span>{selectedPerk.data.secondaryColor === null ? 'Inherited' : 'Custom'}</span></div>
              </label>
              <div className="appearance-inheritance-note">{selectedFirstStat ? `Auto uses ${selectedFirstStat.name}: stat icon, ${selectedFirstStat.groupName} group icon, and group color.` : 'No upgrade stat: primary uses the empty placeholder, secondary stays hidden, and the name is white.'}</div>
            </section>

            <section className="inspector-section">
              <div className="section-title-row"><div><h3>Upgrade stats</h3><p>Typed effects applied by this perk.</p></div><button className="small-button" onClick={addUpgrade} disabled={!hasAvailableUpgradeStat}><ToolbarIcon name="plus" /> Add</button></div>
              {selectedPerk.data.upgrades.length === 0 ? <div className="inline-empty">No effects yet. Add one from your stat pool.</div> : (
                <div className="upgrade-stack">
                  {selectedPerk.data.upgrades.map((upgrade, index) => {
                    const stat = statMap.get(upgrade.statId);
                    const statType = stat?.type ?? 'number';
                    return (
                      <div className="upgrade-card" key={upgrade.id}>
                        <div className="upgrade-card-head"><span>Effect {index + 1}</span><button onClick={() => removeUpgrade(upgrade.id)} aria-label="Remove effect"><ToolbarIcon name="trash" /></button></div>
                        <label className="field-label compact">Stat<select value={upgrade.statId} onChange={(event) => updateUpgrade(upgrade.id, { statId: event.target.value })}>{statGroups.map((group) => <optgroup key={group.id} label={group.name}>{group.stats.map((item) => { const unavailable = item.type === 'boolean' && booleanStatUsedElsewhere(item.id, upgrade.id); return <option key={item.id} value={item.id} disabled={unavailable}>{item.name}{unavailable ? ' — already used' : ''}</option>; })}</optgroup>)}</select></label>
                        <div className="field-grid effect-grid">
                          <label className="field-label compact">Modifier<select value={upgrade.operator} onChange={(event) => updateUpgrade(upgrade.id, { operator: event.target.value as UpgradeOperator })}>{statType === 'number' ? <><option value="add">Add (+)</option><option value="subtract">Subtract (−)</option><option value="multiply">Multiply (×)</option><option value="divide">Divide (÷)</option></> : <option value="set">Set</option>}</select></label>
                          <label className="field-label compact">Value{statType === 'number' ? <input type="number" step="any" value={Number(upgrade.value)} onChange={(event) => updateUpgrade(upgrade.id, { value: Number(event.target.value) })} /> : <select value={String(Boolean(upgrade.value))} onChange={(event) => updateUpgrade(upgrade.id, { value: event.target.value === 'true' })}><option value="true">On</option><option value="false">Off</option></select>}</label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
            <section className="inspector-section danger-section"><button className="danger-button" onClick={() => { setPerks((current) => current.filter((perk) => perk.id !== selectedPerk.id)); setSelectedId(null); }}><ToolbarIcon name="trash" /> Delete perk</button></section>
          </div>
        )}
      </aside>
    </section>
  );
}

export default PerksView;
