import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

function replaceOnce(source, search, replacement, label) {
  const index = source.indexOf(search);
  if (index < 0) throw new Error(`Missing transform anchor: ${label}`);
  if (source.indexOf(search, index + search.length) >= 0) {
    throw new Error(`Transform anchor is not unique: ${label}`);
  }
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

function insertBeforeOnce(source, anchor, addition, label) {
  return replaceOnce(source, anchor, addition + anchor, label);
}

const perksView = String.raw`import {
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

type CurrencyDefinition = {
  id: string;
  key: string;
  name: string;
  iconId: string | null;
  color: string;
  symbol?: string;
};

type UpgradeEffect = {
  id: string;
  statId: string;
  operator: UpgradeOperator;
  value: number | boolean;
};

type SkillCost = { currencyId: string; amount: number };

type PerkNodeData = {
  name: string;
  cost: SkillCost;
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
  currencies: CurrencyDefinition[];
  icons: IconAsset[];
  gridSize: number;
  setGridSize: Dispatch<SetStateAction<number>>;
  onAddIcon: (file: File) => Promise<string | null>;
};

type PerkVisual = {
  primaryIcon: IconAsset | null;
  secondaryIcon: IconAsset | null;
  secondaryColor: string;
  currencyIcon: IconAsset | null;
  currencyColor: string;
};

type InteractionContextValue = {
  duplicatePerk: (id: string) => void;
  beginRightPan: (event: ReactPointerEvent<HTMLDivElement>) => void;
  labels: ReadonlyMap<string, NodeLabelView>;
  visuals: ReadonlyMap<string, PerkVisual>;
};

const InteractionContext = createContext<InteractionContextValue | null>(null);
const NODE_SIZE = 62;
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

function ToolbarIcon({ name }: { name: 'plus' | 'currency' | 'name' | 'stats' | 'trash' | 'close' }) {
  const path = name === 'plus'
    ? <path d="M12 5v14M5 12h14" />
    : name === 'currency'
      ? <><path d="M12 3 20 8l-8 13L4 8l8-5Z" /><path d="M4 8h16" /></>
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
        <div
          className="skill-node-label"
          style={{ left: `${label.left}px`, top: `${label.top}px`, width: `${label.width}px`, textAlign: label.align }}
          aria-hidden="true"
        >
          {label.currency && (
            <div className="skill-node-label-currency" style={{ color: visual?.currencyColor ?? '#ffffff' }}>
              {visual?.currencyIcon && <MaskedSvgIcon icon={visual.currencyIcon} color={visual.currencyColor} className="skill-node-label-currency-icon" />}
              <span>{label.currency.text}</span>
            </div>
          )}
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
  return {
    x: Math.round(position.x / gridSize) * gridSize,
    y: Math.round(position.y / gridSize) * gridSize,
  };
}

function PerksView({ perks, setPerks, skills, stats, currencies, icons, gridSize, setGridSize, onAddIcon }: PerksViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(perks[0]?.id ?? null);
  const [showCurrency, setShowCurrency] = useState(true);
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
  const currencyMap = useMemo(() => new Map(currencies.map((currency) => [currency.id, currency])), [currencies]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2200);
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
  }, []);

  useEffect(() => {
    if (selectedId && !perks.some((perk) => perk.id === selectedId)) setSelectedId(null);
  }, [perks, selectedId]);

  useEffect(() => {
    setNameDraft(selectedPerk?.data.name ?? '');
  }, [selectedPerk?.id, selectedPerk?.data.name]);

  useEffect(() => {
    const preventSuppressedContextMenu = (event: MouseEvent) => {
      if (Date.now() < suppressContextMenuUntilRef.current) event.preventDefault();
    };
    window.addEventListener('contextmenu', preventSuppressedContextMenu);
    return () => window.removeEventListener('contextmenu', preventSuppressedContextMenu);
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
    [...skills, ...perks].some((node) => node.data.upgrades.some((upgrade) =>
      upgrade.statId === statId && upgrade.id !== upgradeId,
    )), [perks, skills]);

  const cloneData = useCallback((data: PerkNodeData): PerkNodeData => ({
    name: data.name,
    cost: { ...data.cost },
    upgrades: data.upgrades
      .filter((upgrade) => statMap.get(upgrade.statId)?.type !== 'boolean')
      .map((upgrade) => ({ ...upgrade, id: uid('upgrade') })),
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
      data: {
        name,
        cost: { currencyId: currencies[0]?.id ?? '', amount: 0 },
        upgrades: [],
        primaryIconId: null,
        secondaryIconId: null,
        secondaryColor: null,
      },
      selected: true,
    };
    setPerks((current) => [...current.map((perk) => ({ ...perk, selected: false })), node]);
    setSelectedId(id);
  }, [currencies, findOpenPosition, perks, rfInstance, setPerks]);

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
    const onMove = (moveEvent: PointerEvent) => {
      void rfInstance.setViewport({
        x: initial.x + moveEvent.clientX - start.x,
        y: initial.y + moveEvent.clientY - start.y,
        zoom: initial.zoom,
      });
    };
    const onUp = () => {
      suppressContextMenuUntilRef.current = Date.now() + 250;
      window.removeEventListener('pointermove', onMove);
    };
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
    setPerks((current) => current.map((perk) => ({
      ...perk,
      position: {
        x: Math.round(perk.position.x / gridSize) * next,
        y: Math.round(perk.position.y / gridSize) * next,
      },
    })));
    setGridSize(next);
  }, [gridSize, setGridSize, setPerks]);

  const copySelected = useCallback(() => {
    let selected = perks.filter((perk) => perk.selected);
    if (selected.length === 0 && selectedPerk) selected = [selectedPerk];
    if (selected.length === 0) {
      showNotice('Select at least one perk to copy.');
      return;
    }
    clipboardRef.current = selected.map((perk) => ({
      ...perk,
      position: { ...perk.position },
      data: cloneData(perk.data),
      selected: false,
    }));
    pasteCountRef.current = 0;
    showNotice(`Copied ${selected.length} perk${selected.length === 1 ? '' : 's'}.`);
  }, [cloneData, perks, selectedPerk, showNotice]);

  const pasteCopied = useCallback(() => {
    const snapshot = clipboardRef.current;
    if (!snapshot?.length) {
      showNotice('Copy one or more perks first.');
      return;
    }
    pasteCountRef.current += 1;
    const added: PerkFlowNode[] = [];
    snapshot.forEach((source) => {
      const name = uniquePerkName(source.data.name, [...perks, ...added]);
      const preferred = {
        x: source.position.x + gridSize * pasteCountRef.current,
        y: source.position.y + gridSize * pasteCountRef.current,
      };
      const node: PerkFlowNode = {
        id: perkIdFromName(name),
        type: 'skill',
        position: findOpenPosition(preferred, added),
        data: { ...cloneData(source.data), name },
        selected: true,
      };
      added.push(node);
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
      if (event.key.toLowerCase() === 'c' && !event.shiftKey) {
        event.preventDefault();
        copySelected();
      } else if (event.key.toLowerCase() === 'v') {
        event.preventDefault();
        pasteCopied();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [copySelected, pasteCopied]);

  const commitName = useCallback(() => {
    if (!selectedPerk) return;
    const nextName = nameDraft.trim();
    if (!nextName) {
      setNameDraft(selectedPerk.data.name);
      showNotice('Perk names cannot be empty.');
      return;
    }
    const nextId = perkIdFromName(nextName);
    const duplicate = perks.some((perk) => perk.id !== selectedPerk.id && (
      perk.data.name.trim().toLowerCase() === nextName.toLowerCase() || perk.id === nextId
    ));
    if (duplicate) {
      setNameDraft(selectedPerk.data.name);
      showNotice('Perk names must be unique.');
      return;
    }
    if (nextName === selectedPerk.data.name && nextId === selectedPerk.id) return;
    setPerks((current) => current.map((perk) => perk.id === selectedPerk.id
      ? { ...perk, id: nextId, data: { ...perk.data, name: nextName } }
      : perk));
    setSelectedId(nextId);
  }, [nameDraft, perks, selectedPerk, setPerks, showNotice]);

  const addUpgrade = () => {
    if (!selectedPerk) return;
    const stat = stats.find((item) => item.type === 'number' || !booleanStatUsedElsewhere(item.id));
    if (!stat) {
      showNotice('Every toggle stat is already assigned.');
      return;
    }
    updatePerk(selectedPerk.id, {
      upgrades: [...selectedPerk.data.upgrades, {
        id: uid('upgrade'),
        statId: stat.id,
        operator: stat.type === 'number' ? 'add' : 'set',
        value: stat.type === 'number' ? 1 : true,
      }],
    });
  };

  const updateUpgrade = (upgradeId: string, patch: Partial<UpgradeEffect>) => {
    if (!selectedPerk) return;
    if (patch.statId) {
      const nextStat = statMap.get(patch.statId);
      if (nextStat?.type === 'boolean' && booleanStatUsedElsewhere(nextStat.id, upgradeId)) {
        showNotice('That toggle stat is already assigned to another node.');
        return;
      }
    }
    updatePerk(selectedPerk.id, {
      upgrades: selectedPerk.data.upgrades.map((upgrade) => {
        if (upgrade.id !== upgradeId) return upgrade;
        const next = { ...upgrade, ...patch } as UpgradeEffect;
        if (patch.statId) {
          const nextStat = statMap.get(patch.statId);
          if (nextStat?.type === 'boolean') {
            next.operator = 'set';
            next.value = true;
          } else if (nextStat?.type === 'number') {
            next.operator = 'add';
            next.value = 1;
          }
        }
        return next;
      }),
    });
  };

  const removeUpgrade = (upgradeId: string) => {
    if (!selectedPerk) return;
    updatePerk(selectedPerk.id, { upgrades: selectedPerk.data.upgrades.filter((upgrade) => upgrade.id !== upgradeId) });
  };

  const selectedCurrency = selectedPerk ? currencyMap.get(selectedPerk.data.cost.currencyId) : undefined;
  const selectedCurrencyIcon = selectedCurrency?.iconId ? iconMap.get(selectedCurrency.iconId) ?? null : null;
  const selectedCurrencyColor = selectedCurrency ? normalizeColor(selectedCurrency.color, '#ffffff') : '#ffffff';
  const selectedFirstStat = selectedPerk?.data.upgrades[0] ? statMap.get(selectedPerk.data.upgrades[0].statId) : undefined;

  const visuals = useMemo<ReadonlyMap<string, PerkVisual>>(() => new Map(perks.map((perk) => {
    const firstStat = perk.data.upgrades[0] ? statMap.get(perk.data.upgrades[0].statId) : undefined;
    const primaryId = perk.data.primaryIconId ?? firstStat?.iconId ?? null;
    const secondaryId = perk.data.secondaryIconId ?? firstStat?.groupIconId ?? null;
    const currency = currencyMap.get(perk.data.cost.currencyId);
    return [perk.id, {
      primaryIcon: primaryId && iconIds.has(primaryId) ? iconMap.get(primaryId) ?? null : null,
      secondaryIcon: secondaryId && iconIds.has(secondaryId) ? iconMap.get(secondaryId) ?? null : null,
      secondaryColor: perk.data.secondaryColor ?? (firstStat ? normalizeColor(firstStat.groupColor, '#ffffff') : '#ffffff'),
      currencyIcon: currency?.iconId && iconIds.has(currency.iconId) ? iconMap.get(currency.iconId) ?? null : null,
      currencyColor: currency ? normalizeColor(currency.color, '#ffffff') : '#ffffff',
    }];
  })), [currencyMap, iconIds, iconMap, perks, statMap]);

  const labels = useMemo(() => buildNodeLabelLayout(perks.map((perk) => {
    const currency = currencyMap.get(perk.data.cost.currencyId);
    return {
      id: perk.id,
      position: perk.position,
      name: perk.data.name,
      currency: currency ? { amount: perk.data.cost.amount, hasIcon: Boolean(currency.iconId && iconIds.has(currency.iconId)) } : null,
      effects: perk.data.upgrades.flatMap((upgrade) => {
        const stat = statMap.get(upgrade.statId);
        if (!stat) return [];
        return [{ operator: upgrade.operator, value: upgrade.value, groupName: stat.groupName, statName: stat.name }];
      }),
    };
  }), [], { showCurrency, showNames, showStats }), [currencyMap, iconIds, perks, showCurrency, showNames, showStats, statMap]);

  const selectedVisual = selectedPerk ? visuals.get(selectedPerk.id) ?? null : null;
  const hasAvailableUpgradeStat = stats.some((stat) => stat.type === 'number' || !booleanStatUsedElsewhere(stat.id));

  return (
    <section className="tree-layout perks-layout">
      <div className="flow-panel perks-flow-panel" ref={flowWrapRef}>
        <div className="canvas-toolbar perks-canvas-toolbar">
          <button className="primary-button" onClick={addPerk}><ToolbarIcon name="plus" /> Add perk</button>
          <label className="perk-grid-size-control">
            <span>Grid size</span>
            <input
              type="number"
              min={MIN_GRID_SIZE}
              max={MAX_GRID_SIZE}
              step="4"
              value={gridSize}
              onChange={(event) => changeGridSize(Number(event.target.value))}
            />
            <span>px</span>
          </label>
        </div>

        <div className="canvas-display-toolbar" aria-label="Perk display options">
          <button className={`canvas-icon-toggle${showCurrency ? ' is-active' : ''}`} type="button" aria-label="Toggle perk currency costs" aria-pressed={showCurrency} onClick={() => setShowCurrency((value) => !value)}><ToolbarIcon name="currency" /></button>
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
          <div>
            <span className="section-kicker">PERK INSPECTOR</span>
            <h2>{selectedPerk ? selectedPerk.data.name : 'No perk selected'}</h2>
          </div>
          {selectedPerk && <button className="ghost-icon" onClick={() => setSelectedId(null)} aria-label="Close perk selection"><ToolbarIcon name="close" /></button>}
        </div>

        {!selectedPerk ? (
          <div className="empty-inspector">
            <div className="empty-orbit"><span /></div>
            <h3>Select a perk</h3>
            <p>Choose a circle on the grid to edit its identity, cost, appearance, stat effects, and grid cell.</p>
          </div>
        ) : (
          <div className="inspector-scroll">
            <section className="inspector-section">
              <div className="section-title-row"><h3>Perk</h3><span className="id-chip">{selectedPerk.id}</span></div>
              <label className="field-label">Name
                <input
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onBlur={commitName}
                  onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                />
              </label>
              <div className="perk-id-note">ID/key is generated from the name: lowercase with spaces replaced by periods.</div>
              <div className="field-grid cost-grid">
                <label className="field-label">Currency
                  <div className={`currency-select-wrap${selectedCurrencyIcon ? ' has-icon' : ''}`}>
                    {selectedCurrencyIcon && <MaskedSvgIcon icon={selectedCurrencyIcon} color={selectedCurrencyColor} className="inspector-currency-icon" />}
                    <select value={selectedPerk.data.cost.currencyId} onChange={(event) => updatePerk(selectedPerk.id, { cost: { ...selectedPerk.data.cost, currencyId: event.target.value } })} disabled={currencies.length === 0}>
                      {currencies.length === 0 && <option value="">No currencies</option>}
                      {currencies.map((currency) => <option key={currency.id} value={currency.id}>{currency.name}</option>)}
                    </select>
                  </div>
                </label>
                <label className="field-label">Cost
                  <div className={`number-wrap currency-number-wrap${selectedCurrencyIcon ? ' has-icon' : ''}`}>
                    {selectedCurrencyIcon && <MaskedSvgIcon icon={selectedCurrencyIcon} color={selectedCurrencyColor} className="inspector-currency-icon" />}
                    <input type="number" min="0" value={selectedPerk.data.cost.amount} onChange={(event) => updatePerk(selectedPerk.id, { cost: { ...selectedPerk.data.cost, amount: Number(event.target.value) } })} />
                  </div>
                </label>
              </div>
              <div className="field-grid">
                <label className="field-label">Grid column
                  <input type="number" step="1" value={Math.round(selectedPerk.position.x / gridSize)} onChange={(event) => {
                    const column = Number(event.target.value);
                    if (!Number.isFinite(column)) return;
                    setPerks((current) => current.map((perk) => perk.id === selectedPerk.id ? { ...perk, position: { ...perk.position, x: Math.round(column) * gridSize } } : perk));
                  }} />
                </label>
                <label className="field-label">Grid row
                  <input type="number" step="1" value={Math.round(selectedPerk.position.y / gridSize)} onChange={(event) => {
                    const row = Number(event.target.value);
                    if (!Number.isFinite(row)) return;
                    setPerks((current) => current.map((perk) => perk.id === selectedPerk.id ? { ...perk, position: { ...perk.position, y: Math.round(row) * gridSize } } : perk));
                  }} />
                </label>
              </div>
            </section>

            <section className="inspector-section node-appearance-section">
              <div className="section-title-row"><div><h3>Node appearance</h3><p>Empty icon slots inherit from the first upgrade stat.</p></div></div>
              <div className="node-appearance-icons">
                <label className="field-label compact">Primary icon
                  <IconPicker icons={icons} value={selectedPerk.data.primaryIconId} ariaLabel={`${selectedPerk.data.name} primary icon override`} onChange={(primaryIconId) => updatePerk(selectedPerk.id, { primaryIconId })} onUpload={async (file) => {
                    const primaryIconId = await onAddIcon(file);
                    if (primaryIconId) {
                      updatePerk(selectedPerk.id, { primaryIconId });
                      showNotice('SVG added to the icon pool.');
                    }
                  }} />
                </label>
                <label className="field-label compact">Secondary icon
                  <IconPicker icons={icons} value={selectedPerk.data.secondaryIconId} ariaLabel={`${selectedPerk.data.name} secondary icon override`} onChange={(secondaryIconId) => updatePerk(selectedPerk.id, { secondaryIconId })} onUpload={async (file) => {
                    const secondaryIconId = await onAddIcon(file);
                    if (secondaryIconId) {
                      updatePerk(selectedPerk.id, { secondaryIconId });
                      showNotice('SVG added to the icon pool.');
                    }
                  }} />
                </label>
              </div>
              <label className="field-label">Secondary color
                <div className="node-color-control">
                  <input type="color" value={selectedVisual?.secondaryColor ?? '#ffffff'} aria-label="Secondary icon and perk name color" onChange={(event) => updatePerk(selectedPerk.id, { secondaryColor: event.target.value })} />
                  <button type="button" className="small-button" disabled={selectedPerk.data.secondaryColor === null} onClick={() => updatePerk(selectedPerk.id, { secondaryColor: null })}>Auto</button>
                  <span>{selectedPerk.data.secondaryColor === null ? 'Inherited' : 'Custom'}</span>
                </div>
              </label>
              <div className="appearance-inheritance-note">
                {selectedFirstStat
                  ? `Auto uses ${selectedFirstStat.name}: stat icon, ${selectedFirstStat.groupName} group icon, and group color.`
                  : 'No upgrade stat: primary uses the empty placeholder, secondary stays hidden, and the name is white.'}
              </div>
            </section>

            <section className="inspector-section">
              <div className="section-title-row">
                <div><h3>Upgrade stats</h3><p>Typed effects applied by this perk.</p></div>
                <button className="small-button" onClick={addUpgrade} disabled={!hasAvailableUpgradeStat}><ToolbarIcon name="plus" /> Add</button>
              </div>
              {selectedPerk.data.upgrades.length === 0 ? (
                <div className="inline-empty">No effects yet. Add one from your stat pool.</div>
              ) : (
                <div className="upgrade-stack">
                  {selectedPerk.data.upgrades.map((upgrade, index) => {
                    const stat = statMap.get(upgrade.statId);
                    const statType = stat?.type ?? 'number';
                    return (
                      <div className="upgrade-card" key={upgrade.id}>
                        <div className="upgrade-card-head"><span>Effect {index + 1}</span><button onClick={() => removeUpgrade(upgrade.id)} aria-label="Remove effect"><ToolbarIcon name="trash" /></button></div>
                        <label className="field-label compact">Stat
                          <select value={upgrade.statId} onChange={(event) => updateUpgrade(upgrade.id, { statId: event.target.value })}>
                            {statGroups.map((group) => (
                              <optgroup key={group.id} label={group.name}>
                                {group.stats.map((item) => {
                                  const unavailable = item.type === 'boolean' && booleanStatUsedElsewhere(item.id, upgrade.id);
                                  return <option key={item.id} value={item.id} disabled={unavailable}>{item.name}{unavailable ? ' — already used' : ''}</option>;
                                })}
                              </optgroup>
                            ))}
                          </select>
                        </label>
                        <div className="field-grid effect-grid">
                          <label className="field-label compact">Modifier
                            <select value={upgrade.operator} onChange={(event) => updateUpgrade(upgrade.id, { operator: event.target.value as UpgradeOperator })}>
                              {statType === 'number' ? <><option value="add">Add (+)</option><option value="subtract">Subtract (−)</option><option value="multiply">Multiply (×)</option><option value="divide">Divide (÷)</option></> : <option value="set">Set</option>}
                            </select>
                          </label>
                          <label className="field-label compact">Value
                            {statType === 'number'
                              ? <input type="number" step="any" value={Number(upgrade.value)} onChange={(event) => updateUpgrade(upgrade.id, { value: Number(event.target.value) })} />
                              : <select value={String(Boolean(upgrade.value))} onChange={(event) => updateUpgrade(upgrade.id, { value: event.target.value === 'true' })}><option value="true">On</option><option value="false">Off</option></select>}
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="inspector-section danger-section">
              <button className="danger-button" onClick={() => {
                setPerks((current) => current.filter((perk) => perk.id !== selectedPerk.id));
                setSelectedId(null);
              }}><ToolbarIcon name="trash" /> Delete perk</button>
            </section>
          </div>
        )}
      </aside>
    </section>
  );
}

export default PerksView;
`;

const perksCss = String.raw`.perks-flow-panel .react-flow__background {
  opacity: 0.45;
}

.perks-flow-panel .react-flow__background-pattern.dots circle {
  fill: #58616c;
}

.perks-canvas-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.perk-grid-size-control {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 36px;
  padding: 5px 9px;
  border: 1px solid #303943;
  border-radius: 9px;
  background: rgba(16, 21, 26, 0.92);
  color: #9da8b2;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.perk-grid-size-control input {
  width: 70px;
  height: 26px;
  padding: 3px 6px;
  border-radius: 6px;
  text-align: right;
}

.perk-node {
  cursor: grab;
}

.perk-node:active {
  cursor: grabbing;
}

.perk-id-note {
  margin-top: -5px;
  color: #707b86;
  font-size: 11px;
  line-height: 1.45;
}

@media (max-width: 760px) {
  .perks-canvas-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .perk-grid-size-control {
    width: max-content;
  }
}
`;

write('src/PerksView.tsx', perksView);
write('src/perks.css', perksCss);

let main = read('src/main.tsx');
main = replaceOnce(main, "import './playtest.css';\n", "import './playtest.css';\nimport './perks.css';\n", 'main perks css import');
write('src/main.tsx', main);

let projectData = read('src/projectData.ts');
projectData = replaceOnce(projectData,
`  icons: JsonRecord[];\n};`,
`  icons: JsonRecord[];\n  perks: JsonRecord[];\n  perkGridSize: number;\n};`,
'canonical project perks fields');
projectData = replaceOnce(projectData,
`    return {\n      version: 2,\n      nodes,\n      edges,`,
`    const perks = Array.isArray(parsed.perks)\n      ? parsed.perks.flatMap<JsonRecord>((item) => {\n        if (!isRecord(item) || typeof item.id !== 'string') return [];\n        return [{\n          id: item.id,\n          type: item.type ?? 'skill',\n          position: cloneValue(item.position),\n          data: cloneValue(item.data),\n        }];\n      })\n      : [];\n    const perkGridSize = typeof parsed.perkGridSize === 'number' && Number.isFinite(parsed.perkGridSize)\n      ? Math.max(72, Math.min(320, Math.round(parsed.perkGridSize)))\n      : 140;\n\n    return {\n      version: 2,\n      nodes,\n      edges,\n      perks,\n      perkGridSize,`,
'normalize project perks');
projectData = replaceOnce(projectData,
`export function createStarterProject(): CanonicalProject {\n  return {\n    version: 2,\n    nodes:`,
`export function createStarterProject(): CanonicalProject {\n  return {\n    version: 2,\n    perks: [],\n    perkGridSize: 140,\n    nodes:`,
'starter project perks');
projectData = replaceOnce(projectData,
`    version: 2,\n    nodes: [],\n    edges: [],\n    stats: cloneValue(basis.stats),`,
`    version: 2,\n    nodes: [],\n    edges: [],\n    perks: [],\n    perkGridSize: basis.perkGridSize,\n    stats: cloneValue(basis.stats),`,
'blank project perks');
projectData = replaceOnce(projectData,
`  diffValue(before.icons, after.icons, ['icons'], changes);\n  return changes;`,
`  diffValue(before.icons, after.icons, ['icons'], changes);\n  diffValue(before.perks, after.perks, ['perks'], changes);\n  diffValue(before.perkGridSize, after.perkGridSize, ['perkGridSize'], changes);\n  return changes;`,
'diff project perks');
projectData = replaceOnce(projectData,
`  collection: 'nodes' | 'edges' | 'stats' | 'currencies' | 'icons',`,
`  collection: 'nodes' | 'edges' | 'stats' | 'currencies' | 'icons' | 'perks',`,
'history collection perks');
projectData = replaceOnce(projectData,
`          : collection === 'icons'\n            ? 'icon'\n            : collection;`,
`          : collection === 'icons'\n            ? 'icon'\n            : collection === 'perks'\n              ? 'perk'\n              : collection;`,
'entity key perks');
projectData = replaceOnce(projectData,
`    if (['nodes', 'edges', 'stats', 'currencies', 'icons'].includes(collection)) touched.add(entityKey(collection, id));`,
`    if (['nodes', 'edges', 'stats', 'currencies', 'icons', 'perks'].includes(collection)) touched.add(entityKey(collection, id));`,
'touched entity perks');
projectData = replaceOnce(projectData,
`    if (collection === 'nodes') {\n      const oldNode = collectionEntity(before, 'nodes', id);\n      const newNode = collectionEntity(after, 'nodes', id);`,
`    if (collection === 'nodes' || collection === 'perks') {\n      const collectionKey = collection as 'nodes' | 'perks';\n      const oldNode = collectionEntity(before, collectionKey, id);\n      const newNode = collectionEntity(after, collectionKey, id);`,
'perk dependency touches');
projectData = replaceOnce(projectData,
`    changes.forEach((change) => {\n      if (change.key[0] === 'nodes' && change.key[1]) guards.add(\`node:${change.key[1]}\`);\n    });`,
`    changes.forEach((change) => {\n      if (change.key[0] === 'nodes' && change.key[1]) guards.add(\`node:${change.key[1]}\`);\n      if (change.key[0] === 'perks' && change.key[1]) guards.add(\`perk:${change.key[1]}\`);\n    });`,
'guard perk dependencies');
write('src/projectData.ts', projectData);

let history = read('src/history.ts');
history = replaceOnce(history,
`  if (structural('nodes', true)) return 'Added skill';\n  if (structural('nodes', false)) return 'Removed skill';`,
`  if (structural('nodes', true)) return 'Added skill';\n  if (structural('nodes', false)) return 'Removed skill';\n  if (structural('perks', true)) return 'Added perk';\n  if (structural('perks', false)) return 'Removed perk';`,
'history perk structural labels');
history = replaceOnce(history,
`  if (changes.some((change) => change.key[0] === 'nodes' && change.key.includes('position'))) return 'Moved skill';\n  if (changes.some((change) => change.key[0] === 'nodes' && change.key.at(-1) === 'name')) return 'Renamed skill';`,
`  if (changes.some((change) => change.key[0] === 'nodes' && change.key.includes('position'))) return 'Moved skill';\n  if (changes.some((change) => change.key[0] === 'perks' && change.key.includes('position'))) return 'Moved perk';\n  if (changes.some((change) => change.key[0] === 'nodes' && change.key.at(-1) === 'name')) return 'Renamed skill';\n  if (changes.some((change) => change.key[0] === 'perks' && (change.key.at(-1) === 'name' || change.key.at(-1) === 'id'))) return 'Renamed perk';`,
'history perk edit labels');
history = replaceOnce(history,
`  if (changes.some((change) => change.key[0] === 'icons')) return 'Edited icon pool';\n  if (changes.some((change) => change.key[0] === 'nodes')) return 'Edited skill';\n  return 'Project change';`,
`  if (changes.some((change) => change.key[0] === 'icons')) return 'Edited icon pool';\n  if (changes.some((change) => change.key[0] === 'nodes')) return 'Edited skill';\n  if (changes.some((change) => change.key[0] === 'perks')) return 'Edited perk';\n  if (changes.some((change) => change.key[0] === 'perkGridSize')) return 'Changed perk grid';\n  return 'Project change';`,
'history perk fallback labels');
write('src/history.ts', history);

let app = read('src/App.tsx');
app = replaceOnce(app,
`import { canLockPlaytestNode, canUnlockPlaytestNode, simulateStatValues } from './playtest';\n`,
`import { canLockPlaytestNode, canUnlockPlaytestNode, simulateStatValues } from './playtest';\nimport PerksView from './PerksView';\n`,
'App perks import');
app = replaceOnce(app,
`type EditorView = 'tree' | 'playtest' | 'stats' | 'currencies' | 'icons';`,
`type EditorView = 'tree' | 'perks' | 'playtest' | 'stats' | 'currencies' | 'icons';`,
'editor view perks');
app = replaceOnce(app,
`  icons: IconAsset[];\n};`,
`  icons: IconAsset[];\n  perks: SkillFlowNode[];\n  perkGridSize: number;\n};`,
'persisted project perks fields');
app = replaceOnce(app,
`    currencies: starterCurrencies,\n    icons: [],`,
`    currencies: starterCurrencies,\n    icons: [],\n    perks: [],\n    perkGridSize: 140,`,
'default project perks');
app = insertBeforeOnce(app,
`function migrateProject(raw: unknown): PersistedProject | null {`,
`function perkIdFromName(name: string) {\n  return name.toLowerCase().replaceAll(' ', '.');\n}\n\nfunction uniqueImportedPerkName(baseName: string, usedNames: Set<string>, usedIds: Set<string>) {\n  const base = baseName.trim() || 'New Perk';\n  if (!usedNames.has(base.toLowerCase()) && !usedIds.has(perkIdFromName(base))) return base;\n  let index = 2;\n  while (usedNames.has(\`${base} ${index}\`.toLowerCase()) || usedIds.has(perkIdFromName(\`${base} ${index}\`))) index += 1;\n  return \`${base} ${index}\`;\n}\n\n`,
'perk import helpers');
app = replaceOnce(app,
`  return {\n    version: 2,\n    nodes,\n    edges: sanitizeEdges(value.edges, nodes),\n    stats,\n    currencies,\n    icons,\n  };\n}`,
`  const perkGridSize = typeof value.perkGridSize === 'number' && Number.isFinite(value.perkGridSize)\n    ? Math.max(72, Math.min(320, Math.round(value.perkGridSize)))\n    : 140;\n  const rawPerks = Array.isArray(value.perks) ? value.perks : [];\n  const migratedPerks = rawPerks.length > 0\n    ? migrateProject({ version: 2, nodes: rawPerks, edges: [], stats, currencies, icons })?.nodes ?? []\n    : [];\n  const usedPerkNames = new Set<string>();\n  const usedPerkIds = new Set<string>();\n  const booleanStatsUsedBySkills = new Set(nodes.flatMap((node) => node.data.upgrades.flatMap((upgrade) =>\n    statMap.get(upgrade.statId)?.type === 'boolean' ? [upgrade.statId] : [],\n  )));\n  const perks = migratedPerks.map((node, index) => {\n    const name = uniqueImportedPerkName(node.data.name || \`Perk ${index + 1}\`, usedPerkNames, usedPerkIds);\n    const id = perkIdFromName(name);\n    usedPerkNames.add(name.toLowerCase());\n    usedPerkIds.add(id);\n    return {\n      ...node,\n      id,\n      position: {\n        x: Math.round(node.position.x / perkGridSize) * perkGridSize,\n        y: Math.round(node.position.y / perkGridSize) * perkGridSize,\n      },\n      data: {\n        ...node.data,\n        name,\n        upgrades: node.data.upgrades.filter((upgrade) =>\n          statMap.get(upgrade.statId)?.type !== 'boolean' || !booleanStatsUsedBySkills.has(upgrade.statId),\n        ),\n      },\n    };\n  });\n\n  return {\n    version: 2,\n    nodes,\n    edges: sanitizeEdges(value.edges, nodes),\n    stats,\n    currencies,\n    icons,\n    perks,\n    perkGridSize,\n  };\n}`,
'migrate project perks');
app = replaceOnce(app,
`  const [icons, setIcons] = useState<IconAsset[]>(initial.icons);\n  const [activeView, setActiveView] = useState<EditorView>('tree');`,
`  const [icons, setIcons] = useState<IconAsset[]>(initial.icons);\n  const [perks, setPerks] = useState<SkillFlowNode[]>(initial.perks);\n  const [perkGridSize, setPerkGridSize] = useState(initial.perkGridSize);\n  const [activeView, setActiveView] = useState<EditorView>('tree');`,
'perk editor state');
app = replaceOnce(app,
`      if (touched.has('icons')) {\n        setIcons((current) => applyHistoryTransitionsToCollection(current, 'icons', detail.transitions));\n      }\n\n      const removedNodeIds`,
`      if (touched.has('icons')) {\n        setIcons((current) => applyHistoryTransitionsToCollection(current, 'icons', detail.transitions));\n      }\n      if (touched.has('perks')) {\n        setPerks((current) => applyHistoryTransitionsToCollection(current, 'perks', detail.transitions));\n      }\n      if (touched.has('perkGridSize')) {\n        setPerkGridSize((current) => {\n          let next = current;\n          detail.transitions.forEach((transition) => {\n            transition.changes.forEach((change) => {\n              if (change.key.length !== 1 || change.key[0] !== 'perkGridSize') return;\n              const value = transition.direction === 'undo' ? change.oldValue : change.newValue;\n              if (typeof value === 'number' && Number.isFinite(value)) next = value;\n            });\n          });\n          return next;\n        });\n      }\n\n      const removedNodeIds`,
'history apply perks');
app = replaceOnce(app,
`    const project: PersistedProject = { version: 2, nodes, edges, stats, currencies, icons };`,
`    const project: PersistedProject = { version: 2, nodes, edges, stats, currencies, icons, perks, perkGridSize };`,
'persist perks project');
app = replaceOnce(app,
`  }, [nodes, edges, stats, currencies, icons]);`,
`  }, [nodes, edges, stats, currencies, icons, perks, perkGridSize]);`,
'persist perks dependencies');
app = replaceOnce(app,
`  const booleanStatUsedElsewhere = useCallback((statId: string, upgradeId?: string) =>\n    nodes.some((node) => node.data.upgrades.some((upgrade) =>\n      upgrade.statId === statId && upgrade.id !== upgradeId,\n    )), [nodes]);`,
`  const booleanStatUsedElsewhere = useCallback((statId: string, upgradeId?: string) =>\n    [...nodes, ...perks].some((node) => node.data.upgrades.some((upgrade) =>\n      upgrade.statId === statId && upgrade.id !== upgradeId,\n    )), [nodes, perks]);`,
'boolean stat usage perks');
app = replaceOnce(app,
`      const usage = nodes.reduce((total, node) => total + node.data.upgrades.filter((upgrade) => upgrade.statId === statId).length, 0);`,
`      const usage = [...nodes, ...perks].reduce((total, node) => total + node.data.upgrades.filter((upgrade) => upgrade.statId === statId).length, 0);`,
'convert stat usage perks');
app = replaceOnce(app,
`    if (patch.type) {\n      setNodes((current) => current.map((node) => ({\n        ...node,\n        data: {\n          ...node.data,\n          upgrades: node.data.upgrades.map((upgrade) => {\n            if (upgrade.statId !== statId) return upgrade;\n            return patch.type === 'boolean'\n              ? { ...upgrade, operator: 'set' as const, value: true }\n              : { ...upgrade, operator: 'add' as const, value: 1 };\n          }),\n        },\n      })));\n    }`,
`    if (patch.type) {\n      const updateNodeEffects = (current: SkillFlowNode[]) => current.map((node) => ({\n        ...node,\n        data: {\n          ...node.data,\n          upgrades: node.data.upgrades.map((upgrade) => {\n            if (upgrade.statId !== statId) return upgrade;\n            return patch.type === 'boolean'\n              ? { ...upgrade, operator: 'set' as const, value: true }\n              : { ...upgrade, operator: 'add' as const, value: 1 };\n          }),\n        },\n      }));\n      setNodes(updateNodeEffects);\n      setPerks(updateNodeEffects);\n    }`,
'update stat type perks');
app = replaceOnce(app,
`    setNodes((current) => current.map((node) => ({\n      ...node,\n      data: { ...node.data, upgrades: node.data.upgrades.filter((upgrade) => upgrade.statId !== statId) },\n    })));\n  };\n\n  const addCurrency`,
`    const removeStatEffects = (current: SkillFlowNode[]) => current.map((node) => ({\n      ...node,\n      data: { ...node.data, upgrades: node.data.upgrades.filter((upgrade) => upgrade.statId !== statId) },\n    }));\n    setNodes(removeStatEffects);\n    setPerks(removeStatEffects);\n  };\n\n  const addCurrency`,
'delete stat perks');
app = replaceOnce(app,
`    setNodes((current) => current.map((node) =>\n      node.data.cost.currencyId\n        ? node\n        : { ...node, data: { ...node.data, cost: { ...node.data.cost, currencyId: id } } },\n    ));`,
`    const assignCurrency = (current: SkillFlowNode[]) => current.map((node) =>\n      node.data.cost.currencyId\n        ? node\n        : { ...node, data: { ...node.data, cost: { ...node.data.cost, currencyId: id } } },\n    );\n    setNodes(assignCurrency);\n    setPerks(assignCurrency);`,
'add currency perks');
app = replaceOnce(app,
`      setNodes((nodeList) => nodeList.map((node) =>\n        node.data.cost.currencyId === currencyId\n          ? { ...node, data: { ...node.data, cost: { ...node.data.cost, currencyId: replacement } } }\n          : node,\n      ));`,
`      const replaceCurrency = (nodeList: SkillFlowNode[]) => nodeList.map((node) =>\n        node.data.cost.currencyId === currencyId\n          ? { ...node, data: { ...node.data, cost: { ...node.data.cost, currencyId: replacement } } }\n          : node,\n      );\n      setNodes(replaceCurrency);\n      setPerks(replaceCurrency);`,
'delete currency perks');
app = replaceOnce(app,
`    count += nodes.filter((node) => node.data.primaryIconId === iconId).length;\n    count += nodes.filter((node) => node.data.secondaryIconId === iconId).length;`,
`    count += [...nodes, ...perks].filter((node) => node.data.primaryIconId === iconId).length;\n    count += [...nodes, ...perks].filter((node) => node.data.secondaryIconId === iconId).length;`,
'icon usage perks');
app = replaceOnce(app,
`    setNodes((current) => current.map((node) => ({\n      ...node,\n      data: {\n        ...node.data,\n        primaryIconId: node.data.primaryIconId === iconId ? null : node.data.primaryIconId,\n        secondaryIconId: node.data.secondaryIconId === iconId ? null : node.data.secondaryIconId,\n      },\n    })));\n    showNotice('Icon deleted and cleared from its assignments.');`,
`    const clearNodeIcon = (current: SkillFlowNode[]) => current.map((node) => ({\n      ...node,\n      data: {\n        ...node.data,\n        primaryIconId: node.data.primaryIconId === iconId ? null : node.data.primaryIconId,\n        secondaryIconId: node.data.secondaryIconId === iconId ? null : node.data.secondaryIconId,\n      },\n    }));\n    setNodes(clearNodeIcon);\n    setPerks(clearNodeIcon);\n    showNotice('Icon deleted and cleared from its assignments.');`,
'delete icon perks');
app = replaceOnce(app,
`    const project = { version: 2, nodes: exportNodes, edges, stats, currencies, icons };`,
`    const exportPerks = perks.map((node) => ({\n      ...node,\n      data: {\n        ...node.data,\n        resolvedAppearance: resolveSkillAppearance(node.data, statMap, iconIds),\n      },\n    }));\n    const project = { version: 2, nodes: exportNodes, edges, stats, currencies, icons, perks: exportPerks, perkGridSize };`,
'export perks');
app = replaceOnce(app,
`        setIcons(project.icons);\n        setUnlockedNodeIds(new Set());`,
`        setIcons(project.icons);\n        setPerks(project.perks);\n        setPerkGridSize(project.perkGridSize);\n        setUnlockedNodeIds(new Set());`,
'import perks');
app = replaceOnce(app,
`          <button className={activeView === 'playtest' ? 'active' : ''} onClick={() => setActiveView('playtest')}>\n            <Icon name="playtest" /> Playtest\n          </button>`,
`          <button className={activeView === 'perks' ? 'active' : ''} onClick={() => setActiveView('perks')}>\n            <Icon name="perks" /> Perks\n          </button>\n          <button className={activeView === 'playtest' ? 'active' : ''} onClick={() => setActiveView('playtest')}>\n            <Icon name="playtest" /> Playtest\n          </button>`,
'perks nav button');
app = replaceOnce(app,
`function Icon({ name }: { name: 'plus' | 'trash' | 'download' | 'upload' | 'tree' | 'playtest' | 'stats' | 'close' | 'link' | 'currency' | 'icons' | 'nodeName' | 'nodeStats' }) {`,
`function Icon({ name }: { name: 'plus' | 'trash' | 'download' | 'upload' | 'tree' | 'perks' | 'playtest' | 'stats' | 'close' | 'link' | 'currency' | 'icons' | 'nodeName' | 'nodeStats' }) {`,
'perks icon type');
app = replaceOnce(app,
`    tree: <path d="M12 4v5m0 0-5 4m5-4 5 4M7 13v5m10-5v5M4 18h6m4 0h6" />,\n    playtest:`,
`    tree: <path d="M12 4v5m0 0-5 4m5-4 5 4M7 13v5m10-5v5M4 18h6m4 0h6" />,\n    perks: <><circle cx="7" cy="7" r="2.4" /><circle cx="17" cy="7" r="2.4" /><circle cx="7" cy="17" r="2.4" /><circle cx="17" cy="17" r="2.4" /></>,\n    playtest:`,
'perks icon path');
app = replaceOnce(app,
`      ) : activeView === 'stats' ? (`,
`      ) : activeView === 'perks' ? (\n        <PerksView\n          perks={perks}\n          setPerks={setPerks}\n          skills={nodes}\n          stats={stats}\n          currencies={currencies}\n          icons={icons}\n          gridSize={perkGridSize}\n          setGridSize={setPerkGridSize}\n          onAddIcon={addIconAsset}\n        />\n      ) : activeView === 'stats' ? (`,
'perks view render');
app = replaceOnce(app,
`                      const usage = nodes.reduce((total, node) => total + node.data.upgrades.filter((upgrade) => upgrade.statId === stat.id).length, 0);`,
`                      const usage = [...nodes, ...perks].reduce((total, node) => total + node.data.upgrades.filter((upgrade) => upgrade.statId === stat.id).length, 0);`,
'stat pool perk usage');
app = replaceOnce(app,
`              const usage = nodes.filter((node) => node.data.cost.currencyId === currency.id).length;`,
`              const usage = [...nodes, ...perks].filter((node) => node.data.cost.currencyId === currency.id).length;`,
'currency perk usage');
write('src/App.tsx', app);

console.log('Perks implementation applied.');
