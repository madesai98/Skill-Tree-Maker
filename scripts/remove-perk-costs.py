from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


app_path = Path('src/App.tsx')
app = app_path.read_text()

app = replace_once(app, """type SkillNodeData = {
  name: string;
  cost: SkillCost;
  upgrades: UpgradeEffect[];
  primaryIconId: string | null;
  secondaryIconId: string | null;
  secondaryColor: string | null;
};
""", """type SkillNodeData = {
  name: string;
  cost: SkillCost;
  upgrades: UpgradeEffect[];
  primaryIconId: string | null;
  secondaryIconId: string | null;
  secondaryColor: string | null;
};

type PerkNodeData = Omit<SkillNodeData, 'cost'>;
""", 'perk node data type')

app = replace_once(app, """type SkillFlowNode = Node<SkillNodeData, 'skill'>;
""", """type SkillFlowNode = Node<SkillNodeData, 'skill'>;
type PerkFlowNode = Node<PerkNodeData, 'skill'>;
""", 'perk flow node type')

app = replace_once(app, """  perks: SkillFlowNode[];
""", """  perks: PerkFlowNode[];
""", 'persisted perk type')

app = replace_once(app, """  data: SkillNodeData,
  statMap: ReadonlyMap<string, StatDefinition>,
""", """  data: Pick<SkillNodeData, 'upgrades' | 'primaryIconId' | 'secondaryIconId' | 'secondaryColor'>,
  statMap: ReadonlyMap<string, StatDefinition>,
""", 'appearance input type')

app = replace_once(app, """  const perks = migratedPerks.map((node, index) => {
    const name = uniqueImportedPerkName(node.data.name || `Perk ${index + 1}`, usedPerkNames, usedPerkIds);
    const id = perkIdFromName(name);
    usedPerkNames.add(name.toLowerCase());
    usedPerkIds.add(id);
    return {
      ...node,
      id,
      position: {
        x: Math.round(node.position.x / perkGridSize) * perkGridSize,
        y: Math.round(node.position.y / perkGridSize) * perkGridSize,
      },
      data: {
        ...node.data,
        name,
        upgrades: node.data.upgrades.filter((upgrade) =>
          statMap.get(upgrade.statId)?.type !== 'boolean' || !booleanStatsUsedBySkills.has(upgrade.statId),
        ),
      },
    };
  });
""", """  const perks: PerkFlowNode[] = migratedPerks.map((node, index) => {
    const name = uniqueImportedPerkName(node.data.name || `Perk ${index + 1}`, usedPerkNames, usedPerkIds);
    const id = perkIdFromName(name);
    const { cost: _legacyCost, ...perkData } = node.data;
    usedPerkNames.add(name.toLowerCase());
    usedPerkIds.add(id);
    return {
      ...node,
      id,
      position: {
        x: Math.round(node.position.x / perkGridSize) * perkGridSize,
        y: Math.round(node.position.y / perkGridSize) * perkGridSize,
      },
      data: {
        ...perkData,
        name,
        upgrades: node.data.upgrades.filter((upgrade) =>
          statMap.get(upgrade.statId)?.type !== 'boolean' || !booleanStatsUsedBySkills.has(upgrade.statId),
        ),
      },
    };
  });
""", 'strip legacy perk costs during migration')

app = replace_once(app, """      const updateNodeEffects = (current: SkillFlowNode[]) => current.map((node) => ({
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
      }));
""", """      const updateNodeEffects = <T extends SkillFlowNode | PerkFlowNode>(current: T[]) => current.map((node) => ({
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
      })) as T[];
""", 'generic stat type update')

app = replace_once(app, """    const removeStatEffects = (current: SkillFlowNode[]) => current.map((node) => ({
      ...node,
      data: { ...node.data, upgrades: node.data.upgrades.filter((upgrade) => upgrade.statId !== statId) },
    }));
""", """    const removeStatEffects = <T extends SkillFlowNode | PerkFlowNode>(current: T[]) => current.map((node) => ({
      ...node,
      data: { ...node.data, upgrades: node.data.upgrades.filter((upgrade) => upgrade.statId !== statId) },
    })) as T[];
""", 'generic stat removal')

app = replace_once(app, """    const assignCurrency = (current: SkillFlowNode[]) => current.map((node) =>
      node.data.cost.currencyId
        ? node
        : { ...node, data: { ...node.data, cost: { ...node.data.cost, currencyId: id } } },
    );
    setNodes(assignCurrency);
    setPerks(assignCurrency);
""", """    setNodes((current) => current.map((node) =>
      node.data.cost.currencyId
        ? node
        : { ...node, data: { ...node.data, cost: { ...node.data.cost, currencyId: id } } },
    ));
""", 'currency assignment only affects skills')

app = replace_once(app, """      const replaceCurrency = (nodeList: SkillFlowNode[]) => nodeList.map((node) =>
        node.data.cost.currencyId === currencyId
          ? { ...node, data: { ...node.data, cost: { ...node.data.cost, currencyId: replacement } } }
          : node,
      );
      setNodes(replaceCurrency);
      setPerks(replaceCurrency);
""", """      setNodes((nodeList) => nodeList.map((node) =>
        node.data.cost.currencyId === currencyId
          ? { ...node, data: { ...node.data, cost: { ...node.data.cost, currencyId: replacement } } }
          : node,
      ));
""", 'currency deletion only affects skills')

app = replace_once(app, """    const clearNodeIcon = (current: SkillFlowNode[]) => current.map((node) => ({
      ...node,
      data: {
        ...node.data,
        primaryIconId: node.data.primaryIconId === iconId ? null : node.data.primaryIconId,
        secondaryIconId: node.data.secondaryIconId === iconId ? null : node.data.secondaryIconId,
      },
    }));
""", """    const clearNodeIcon = <T extends SkillFlowNode | PerkFlowNode>(current: T[]) => current.map((node) => ({
      ...node,
      data: {
        ...node.data,
        primaryIconId: node.data.primaryIconId === iconId ? null : node.data.primaryIconId,
        secondaryIconId: node.data.secondaryIconId === iconId ? null : node.data.secondaryIconId,
      },
    })) as T[];
""", 'generic icon clearing')

app = replace_once(app, """          stats={stats}
          currencies={currencies}
          icons={icons}
""", """          stats={stats}
          icons={icons}
""", 'remove currencies perk prop')

app_path.write_text(app)

perks_path = Path('src/PerksView.tsx')
perks = perks_path.read_text()

perks = replace_once(perks, """type CurrencyDefinition = {
  id: string;
  key: string;
  name: string;
  iconId: string | null;
  color: string;
  symbol?: string;
};

""", "", 'remove perk currency type')
perks = replace_once(perks, """type SkillCost = { currencyId: string; amount: number };

""", "", 'remove perk cost type')
perks = replace_once(perks, """  cost: SkillCost;
""", "", 'remove perk cost data')
perks = replace_once(perks, """  currencies: CurrencyDefinition[];
""", "", 'remove currencies prop')
perks = replace_once(perks, """  currencyIcon: IconAsset | null;
  currencyColor: string;
""", "", 'remove currency visuals')
perks = replace_once(perks, """function ToolbarIcon({ name }: { name: 'plus' | 'currency' | 'name' | 'stats' | 'trash' | 'close' }) {
  const path = name === 'plus'
    ? <path d="M12 5v14M5 12h14" />
    : name === 'currency'
      ? <><path d="M12 3 20 8l-8 13L4 8l8-5Z" /><path d="M4 8h16" /></>
      : name === 'name'
""", """function ToolbarIcon({ name }: { name: 'plus' | 'name' | 'stats' | 'trash' | 'close' }) {
  const path = name === 'plus'
    ? <path d="M12 5v14M5 12h14" />
    : name === 'name'
""", 'remove currency toolbar icon')
perks = replace_once(perks, """          {label.currency && (
            <div className="skill-node-label-currency" style={{ color: visual?.currencyColor ?? '#ffffff' }}>
              {visual?.currencyIcon && <MaskedSvgIcon icon={visual.currencyIcon} color={visual.currencyColor} className="skill-node-label-currency-icon" />}
              <span>{label.currency.text}</span>
            </div>
          )}
""", "", 'remove currency floating label')
perks = replace_once(perks, """function PerksView({ perks, setPerks, skills, stats, currencies, icons, gridSize, setGridSize, onAddIcon }: PerksViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(perks[0]?.id ?? null);
  const [showCurrency, setShowCurrency] = useState(true);
""", """function PerksView({ perks, setPerks, skills, stats, icons, gridSize, setGridSize, onAddIcon }: PerksViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(perks[0]?.id ?? null);
""", 'remove currency state and prop')
perks = replace_once(perks, """  const currencyMap = useMemo(() => new Map(currencies.map((currency) => [currency.id, currency])), [currencies]);
""", "", 'remove currency map')
perks = replace_once(perks, """    cost: { ...data.cost },
""", "", 'remove cloned cost')
perks = replace_once(perks, """      data: { name, cost: { currencyId: currencies[0]?.id ?? '', amount: 0 }, upgrades: [], primaryIconId: null, secondaryIconId: null, secondaryColor: null },
""", """      data: { name, upgrades: [], primaryIconId: null, secondaryIconId: null, secondaryColor: null },
""", 'new perk has no cost')
perks = replace_once(perks, """  }, [currencies, findOpenPosition, perks, rfInstance, setPerks]);
""", """  }, [findOpenPosition, perks, rfInstance, setPerks]);
""", 'remove currencies add dependency')
perks = replace_once(perks, """  const selectedCurrency = selectedPerk ? currencyMap.get(selectedPerk.data.cost.currencyId) : undefined;
  const selectedCurrencyIcon = selectedCurrency?.iconId ? iconMap.get(selectedCurrency.iconId) ?? null : null;
  const selectedCurrencyColor = selectedCurrency ? normalizeColor(selectedCurrency.color, '#ffffff') : '#ffffff';
""", "", 'remove selected currency')
perks = replace_once(perks, """    const currency = currencyMap.get(perk.data.cost.currencyId);
    return [perk.id, {
      primaryIcon: primaryId && iconIds.has(primaryId) ? iconMap.get(primaryId) ?? null : null,
      secondaryIcon: secondaryId && iconIds.has(secondaryId) ? iconMap.get(secondaryId) ?? null : null,
      secondaryColor: perk.data.secondaryColor ?? (firstStat ? normalizeColor(firstStat.groupColor, '#ffffff') : '#ffffff'),
      currencyIcon: currency?.iconId && iconIds.has(currency.iconId) ? iconMap.get(currency.iconId) ?? null : null,
      currencyColor: currency ? normalizeColor(currency.color, '#ffffff') : '#ffffff',
    }];
  })), [currencyMap, iconIds, iconMap, perks, statMap]);
""", """    return [perk.id, {
      primaryIcon: primaryId && iconIds.has(primaryId) ? iconMap.get(primaryId) ?? null : null,
      secondaryIcon: secondaryId && iconIds.has(secondaryId) ? iconMap.get(secondaryId) ?? null : null,
      secondaryColor: perk.data.secondaryColor ?? (firstStat ? normalizeColor(firstStat.groupColor, '#ffffff') : '#ffffff'),
    }];
  })), [iconIds, iconMap, perks, statMap]);
""", 'remove currency from perk visuals')
perks = replace_once(perks, """  const labels = useMemo(() => buildNodeLabelLayout(perks.map((perk) => {
    const currency = currencyMap.get(perk.data.cost.currencyId);
    return {
      id: perk.id,
      position: perk.position,
      name: perk.data.name,
      currency: currency ? { amount: perk.data.cost.amount, hasIcon: Boolean(currency.iconId && iconIds.has(currency.iconId)) } : null,
""", """  const labels = useMemo(() => buildNodeLabelLayout(perks.map((perk) => ({
      id: perk.id,
      position: perk.position,
      name: perk.data.name,
      currency: null,
""", 'remove currency label data')
perks = replace_once(perks, """      }),
    };
  }), [], { showCurrency, showNames, showStats }), [currencyMap, iconIds, perks, showCurrency, showNames, showStats, statMap]);
""", """      }),
  })), [], { showCurrency: false, showNames, showStats }), [perks, showNames, showStats, statMap]);
""", 'close no-currency label map')
perks = replace_once(perks, """          <button className={`canvas-icon-toggle${showCurrency ? ' is-active' : ''}`} type="button" aria-label="Toggle perk currency costs" aria-pressed={showCurrency} onClick={() => setShowCurrency((value) => !value)}><ToolbarIcon name="currency" /></button>
""", "", 'remove currency display toggle')
perks = replace_once(perks, """          <div className="empty-inspector"><div className="empty-orbit"><span /></div><h3>Select a perk</h3><p>Choose a circle on the grid to edit its identity, cost, appearance, stat effects, and grid cell.</p></div>
""", """          <div className="empty-inspector"><div className="empty-orbit"><span /></div><h3>Select a perk</h3><p>Choose a circle on the grid to edit its identity, appearance, stat effects, and grid cell.</p></div>
""", 'remove cost copy')
perks = replace_once(perks, """              <div className="field-grid cost-grid">
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
""", "", 'remove perk cost inspector')

perks_path.write_text(perks)
print('Removed perk currency costs.')
