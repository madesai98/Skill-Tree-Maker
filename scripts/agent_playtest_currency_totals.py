from pathlib import Path


def replace_once(text: str, old: str, new: str, path: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected exactly one match, found {count}: {old[:100]!r}')
    return text.replace(old, new, 1)


app_path = Path('src/App.tsx')
app = app_path.read_text()

app = replace_once(
    app,
    """function PlaytestInspector({
  groups,
  values,
  iconMap,
  unlockedCount,
  totalNodes,
}: {
  groups: StatGroupView[];
  values: ReadonlyMap<string, number | boolean>;
  iconMap: ReadonlyMap<string, IconAsset>;
  unlockedCount: number;
  totalNodes: number;
}) {""",
    """function PlaytestInspector({
  groups,
  values,
  iconMap,
  currencies,
  currencyTotals,
  unlockedCount,
  totalNodes,
}: {
  groups: StatGroupView[];
  values: ReadonlyMap<string, number | boolean>;
  iconMap: ReadonlyMap<string, IconAsset>;
  currencies: CurrencyDefinition[];
  currencyTotals: ReadonlyMap<string, number>;
  unlockedCount: number;
  totalNodes: number;
}) {""",
    str(app_path),
)

app = replace_once(
    app,
    """        <div className=\"playtest-progress\">
          <span>Unlocked skills</span>
          <strong>{unlockedCount} / {totalNodes}</strong>
        </div>
        {groups.length === 0 ? (""",
    """        <div className=\"playtest-progress\">
          <span>Unlocked skills</span>
          <strong>{unlockedCount} / {totalNodes}</strong>
        </div>
        <section className=\"playtest-currency-summary\">
          <div className=\"playtest-currency-summary-head\">Currency used</div>
          {currencies.length === 0 ? (
            <div className=\"playtest-currency-empty\">No currencies are configured.</div>
          ) : (
            <div className=\"playtest-currency-list\">
              {currencies.map((currency) => {
                const currencyIcon = currency.iconId ? iconMap.get(currency.iconId) ?? null : null;
                const currencyColor = normalizeColor(currency.color, '#ffffff');
                return (
                  <div className=\"playtest-currency-row\" key={currency.id}>
                    <div className=\"playtest-currency-identity\">
                      {currencyIcon ? (
                        <MaskedSvgIcon icon={currencyIcon} color={currencyColor} className=\"playtest-currency-icon\" />
                      ) : (
                        <span className=\"playtest-currency-symbol\" style={{ color: currencyColor }} aria-hidden=\"true\">{currency.symbol ?? '◇'}</span>
                      )}
                      <span>{currency.name}</span>
                    </div>
                    <strong style={{ color: currencyColor }}>{formatSimulatedNumber(currencyTotals.get(currency.id) ?? 0)}</strong>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        {groups.length === 0 ? (""",
    str(app_path),
)

app = replace_once(
    app,
    """  const simulatedStats = useMemo(() =>
    simulateStatValues(stats, nodes, unlockedNodeIds),
  [nodes, stats, unlockedNodeIds]);

  const unlockPlaytestNode = useCallback((nodeId: string) => {""",
    """  const simulatedStats = useMemo(() =>
    simulateStatValues(stats, nodes, unlockedNodeIds),
  [nodes, stats, unlockedNodeIds]);

  const playtestCurrencyTotals = useMemo(() => {
    const totals = new Map<string, number>(currencies.map((currency) => [currency.id, 0]));
    nodes.forEach((node) => {
      if (!unlockedNodeIds.has(node.id)) return;
      const { currencyId, amount } = node.data.cost;
      if (!currencyId || !Number.isFinite(amount)) return;
      totals.set(currencyId, (totals.get(currencyId) ?? 0) + amount);
    });
    return totals;
  }, [currencies, nodes, unlockedNodeIds]);

  const unlockPlaytestNode = useCallback((nodeId: string) => {""",
    str(app_path),
)

app = replace_once(
    app,
    """              groups={statGroups}
              values={simulatedStats}
              iconMap={iconMap}
              unlockedCount={unlockedNodeIds.size}""",
    """              groups={statGroups}
              values={simulatedStats}
              iconMap={iconMap}
              currencies={currencies}
              currencyTotals={playtestCurrencyTotals}
              unlockedCount={unlockedNodeIds.size}""",
    str(app_path),
)

app_path.write_text(app)

css_path = Path('src/playtest.css')
css = css_path.read_text()
css = replace_once(
    css,
    """.playtest-progress strong {
  color: #dce2e8;
  font-size: 14px;
}
.playtest-stat-group {""",
    """.playtest-progress strong {
  color: #dce2e8;
  font-size: 14px;
}
.playtest-currency-summary {
  padding: 13px 17px 15px;
  border-bottom: 1px solid var(--line);
}
.playtest-currency-summary-head {
  margin-bottom: 9px;
  color: #626c79;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.playtest-currency-list {
  display: grid;
  gap: 5px;
}
.playtest-currency-row {
  min-height: 34px;
  padding: 6px 9px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid rgba(255,255,255,.055);
  border-radius: 8px;
  background: rgba(255,255,255,.015);
}
.playtest-currency-identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  color: #aeb7c2;
  font-size: 10px;
  font-weight: 680;
}
.playtest-currency-identity > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.playtest-currency-icon {
  width: 17px;
  height: 17px;
  flex: 0 0 17px;
}
.playtest-currency-symbol {
  width: 17px;
  flex: 0 0 17px;
  font-size: 14px;
  line-height: 1;
  text-align: center;
}
.playtest-currency-row > strong {
  flex: 0 0 auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-weight: 760;
}
.playtest-currency-empty {
  color: #697382;
  font-size: 10px;
}
.playtest-stat-group {""",
    str(css_path),
)
css_path.write_text(css)

Path('.github/workflows/agent-playtest-currency-totals.yml').unlink(missing_ok=True)
Path('scripts/agent_playtest_currency_totals.py').unlink(missing_ok=True)
