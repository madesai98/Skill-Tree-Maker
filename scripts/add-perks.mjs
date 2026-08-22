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
  if (source.indexOf(search, index + search.length) >= 0) throw new Error(`Transform anchor is not unique: ${label}`);
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

function insertBeforeOnce(source, anchor, addition, label) {
  return replaceOnce(source, anchor, addition + anchor, label);
}

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
`    changes.forEach((change) => {\n      if (change.key[0] === 'nodes' && change.key[1]) guards.add(\`node:\${change.key[1]}\`);\n    });`,
`    changes.forEach((change) => {\n      if (change.key[0] === 'nodes' && change.key[1]) guards.add(\`node:\${change.key[1]}\`);\n      if (change.key[0] === 'perks' && change.key[1]) guards.add(\`perk:\${change.key[1]}\`);\n    });`,
'guard perk dependencies');
write('src/projectData.ts', projectData);

let history = read('src/history.ts');
history = replaceOnce(history,
`  if (structural('nodes', true)) return 'Added skill';\n  if (structural('nodes', false)) return 'Removed skill';`,
`  if (structural('nodes', true)) return 'Added skill';\n  if (structural('nodes', false)) return 'Removed skill';\n  if (structural('perks', true)) return 'Added perk';\n  if (structural('perks', false)) return 'Removed perk';`,
'history perk structural labels');
history = replaceOnce(history,
`  if (changes.some((change) => change.key[0] === 'nodes' && change.key.includes('position'))) return 'Moved skill';\n  if (changes.some((change) => change.key[0] === 'nodes' && change.key.at(-1) === 'name')) return 'Renamed skill';`,
`  if (changes.some((change) => change.key[0] === 'nodes' && change.key.includes('position'))) return 'Moved skill';\n  if (changes.some((change) => change.key[0] === 'perks' && change.key.includes('position'))) return 'Moved perk';\n  if (changes.some((change) => change.key[0] === 'nodes' && change.key.at(-1) === 'name')) return 'Renamed skill';\n  if (changes.some((change) => change.key[0] === 'perks' && change.key.at(-1) === 'name')) return 'Renamed perk';`,
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
`function perkIdFromName(name: string) {\n  return name.toLowerCase().replaceAll(' ', '.');\n}\n\nfunction uniqueImportedPerkName(baseName: string, usedNames: Set<string>, usedIds: Set<string>) {\n  const base = baseName.trim() || 'New Perk';\n  if (!usedNames.has(base.toLowerCase()) && !usedIds.has(perkIdFromName(base))) return base;\n  let index = 2;\n  while (usedNames.has(\`${base} \${index}\`.toLowerCase()) || usedIds.has(perkIdFromName(\`${base} \${index}\`))) index += 1;\n  return \`${base} \${index}\`;\n}\n\n`,
'perk import helpers');
app = replaceOnce(app,
`  return {\n    version: 2,\n    nodes,\n    edges: sanitizeEdges(value.edges, nodes),\n    stats,\n    currencies,\n    icons,\n  };\n}`,
`  const perkGridSize = typeof value.perkGridSize === 'number' && Number.isFinite(value.perkGridSize)\n    ? Math.max(72, Math.min(320, Math.round(value.perkGridSize)))\n    : 140;\n  const rawPerks = Array.isArray(value.perks) ? value.perks : [];\n  const migratedPerks = rawPerks.length > 0\n    ? migrateProject({ version: 2, nodes: rawPerks, edges: [], stats, currencies, icons })?.nodes ?? []\n    : [];\n  const usedPerkNames = new Set<string>();\n  const usedPerkIds = new Set<string>();\n  const booleanStatsUsedBySkills = new Set(nodes.flatMap((node) => node.data.upgrades.flatMap((upgrade) =>\n    statMap.get(upgrade.statId)?.type === 'boolean' ? [upgrade.statId] : [],\n  )));\n  const perks = migratedPerks.map((node, index) => {\n    const name = uniqueImportedPerkName(node.data.name || \`Perk \${index + 1}\`, usedPerkNames, usedPerkIds);\n    const id = perkIdFromName(name);\n    usedPerkNames.add(name.toLowerCase());\n    usedPerkIds.add(id);\n    return {\n      ...node,\n      id,\n      position: {\n        x: Math.round(node.position.x / perkGridSize) * perkGridSize,\n        y: Math.round(node.position.y / perkGridSize) * perkGridSize,\n      },\n      data: {\n        ...node.data,\n        name,\n        upgrades: node.data.upgrades.filter((upgrade) =>\n          statMap.get(upgrade.statId)?.type !== 'boolean' || !booleanStatsUsedBySkills.has(upgrade.statId),\n        ),\n      },\n    };\n  });\n\n  return {\n    version: 2,\n    nodes,\n    edges: sanitizeEdges(value.edges, nodes),\n    stats,\n    currencies,\n    icons,\n    perks,\n    perkGridSize,\n  };\n}`,
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
`function Icon({ name }: { name: 'plus' | 'trash' | 'download' | 'upload' | 'tree' | 'playtest' | 'stats' | 'close' | 'link' | 'currency' | 'icons' | 'nodeName' | 'nodeStats' }) {`,
`function Icon({ name }: { name: 'plus' | 'trash' | 'download' | 'upload' | 'tree' | 'perks' | 'playtest' | 'stats' | 'close' | 'link' | 'currency' | 'icons' | 'nodeName' | 'nodeStats' }) {`,
'perks icon type');
app = replaceOnce(app,
`    tree: <path d="M12 4v5m0 0-5 4m5-4 5 4M7 13v5m10-5v5M4 18h6m4 0h6" />,\n    playtest:`,
`    tree: <path d="M12 4v5m0 0-5 4m5-4 5 4M7 13v5m10-5v5M4 18h6m4 0h6" />,\n    perks: <><circle cx="7" cy="7" r="2.4" /><circle cx="17" cy="7" r="2.4" /><circle cx="7" cy="17" r="2.4" /><circle cx="17" cy="17" r="2.4" /></>,\n    playtest:`,
'perks icon path');
app = replaceOnce(app,
`          <button className={activeView === 'playtest' ? 'active' : ''} onClick={() => setActiveView('playtest')}>\n            <Icon name="playtest" /> Playtest\n          </button>`,
`          <button className={activeView === 'perks' ? 'active' : ''} onClick={() => setActiveView('perks')}>\n            <Icon name="perks" /> Perks\n          </button>\n          <button className={activeView === 'playtest' ? 'active' : ''} onClick={() => setActiveView('playtest')}>\n            <Icon name="playtest" /> Playtest\n          </button>`,
'perks nav button');
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

console.log('Perks project integration applied.');
