from pathlib import Path
import re

APP_PATH = Path('src/App.tsx')
CSS_PATH = Path('src/styles.css')
app = APP_PATH.read_text()
css = CSS_PATH.read_text()


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one exact match, found {count}')
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{label}: expected one regex match, found {count}')
    return updated


app = replace_once(
    app,
    """type StatDefinition = {\n  id: string;\n  key: string;\n  name: string;\n  type: StatType;\n};""",
    """type StatDefinition = {\n  id: string;\n  key: string;\n  name: string;\n  type: StatType;\n  groupId: string;\n  groupName: string;\n  groupKey: string;\n};""",
    'StatDefinition type',
)

app = replace_once(
    app,
    """const starterStats: StatDefinition[] = [\n  { id: 'stat-damage', key: 'tower.damage', name: 'Tower Damage', type: 'number' },\n  { id: 'stat-range', key: 'tower.range', name: 'Tower Range', type: 'number' },\n  { id: 'stat-crit', key: 'tower.canCrit', name: 'Can Critical Hit', type: 'boolean' },\n];""",
    """const starterStats: StatDefinition[] = [\n  { id: 'stat-damage', key: 'tower.damage', name: 'Tower Damage', type: 'number', groupId: 'stat-group-tower', groupName: 'Tower', groupKey: 'tower' },\n  { id: 'stat-range', key: 'tower.range', name: 'Tower Range', type: 'number', groupId: 'stat-group-tower', groupName: 'Tower', groupKey: 'tower' },\n  { id: 'stat-crit', key: 'tower.canCrit', name: 'Can Critical Hit', type: 'boolean', groupId: 'stat-group-tower', groupName: 'Tower', groupKey: 'tower' },\n];""",
    'starter stats',
)

helper_block = r"""
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
"""
app = replace_once(
    app,
    """function uid(prefix: string) {\n  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;\n}\n""",
    """function uid(prefix: string) {\n  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;\n}\n""" + helper_block,
    'stat group helpers',
)

normalize_stats = r"""function normalizeStats(raw: unknown): StatDefinition[] {
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
"""
app = regex_once(
    app,
    r"function normalizeStats\(raw: unknown\): StatDefinition\[] \{.*?\n\}\n\n(?=function normalizeCurrencies)",
    normalize_stats + "\n",
    'normalizeStats',
)

app = replace_once(
    app,
    """  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;\n""",
    """  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;\n  const statGroups = useMemo(() => {\n    const groups = new Map<string, { id: string; name: string; key: string; stats: StatDefinition[] }>();\n    stats.forEach((stat) => {\n      const existing = groups.get(stat.groupId);\n      if (existing) {\n        existing.stats.push(stat);\n        return;\n      }\n      groups.set(stat.groupId, { id: stat.groupId, name: stat.groupName, key: stat.groupKey, stats: [stat] });\n    });\n    return [...groups.values()];\n  }, [stats]);\n""",
    'statGroups memo',
)

stat_functions = r"""  const addStatGroup = () => {
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
"""
app = regex_once(
    app,
    r"  const addStat = \(\) => \{.*?\n  const deleteStat = \(statId: string\) => \{.*?\n  \};\n\n(?=  const addCurrency)",
    stat_functions + "\n",
    'stat CRUD functions',
)

app = replace_once(
    app,
    """                                {stats.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}""",
    """                                {statGroups.map((group) => (\n                                  <optgroup key={group.id} label={group.name}>\n                                    {group.stats.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}\n                                  </optgroup>\n                                ))}""",
    'grouped stat selector',
)

stats_view = r"""      ) : activeView === 'stats' ? (
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
"""
app = regex_once(
    app,
    r"      \) : activeView === 'stats' \? \(\n.*?\n      \) : \(\n        <section className=\"stat-pool-view currency-pool-view\">",
    stats_view + "        <section className=\"stat-pool-view currency-pool-view\">",
    'stats view',
)

css_block = r"""

/* Grouped stat pool */
.stat-group-list {
  max-width: 1080px;
  margin: 0 auto;
  display: grid;
  gap: 16px;
}
.stat-group-card {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #0d1117;
  box-shadow: 0 18px 60px rgba(0,0,0,.14);
}
.stat-group-head {
  min-height: 78px;
  padding: 13px 15px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  align-items: end;
  border-bottom: 1px solid var(--line);
  background: rgba(255,255,255,.025);
}
.stat-group-fields {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) minmax(180px, 1.1fr);
  gap: 12px;
  max-width: 620px;
}
.stat-group-fields label {
  min-width: 0;
  display: grid;
  gap: 6px;
  color: #697382;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: .07em;
  text-transform: uppercase;
}
.stat-group-fields input { height: 35px; text-transform: none; letter-spacing: normal; font-weight: 500; }
.stat-group-actions { display: flex; justify-content: flex-end; gap: 7px; padding-bottom: 3px; }
.stat-group-card .stat-table-card {
  max-width: none;
  margin: 0;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
.stat-group-card .stat-row:last-child { border-bottom: 0; }
.stat-key-composer {
  width: 100%;
  height: 35px;
  min-width: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.095);
  border-radius: 8px;
  background: #11151c;
  transition: border-color .13s ease, background .13s ease, box-shadow .13s ease;
}
.stat-key-composer:focus-within {
  border-color: rgba(182,255,86,.45);
  background: #131821;
  box-shadow: 0 0 0 3px rgba(182,255,86,.045);
}
.stat-key-prefix {
  flex: 0 0 auto;
  padding-left: 10px;
  color: #657080;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  white-space: nowrap;
}
.stat-key-composer input {
  height: 33px !important;
  padding-left: 1px;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none !important;
}
.stat-key-composer input:focus { border: 0; background: transparent; box-shadow: none; }

@media (max-width: 760px) {
  .stat-group-list { gap: 12px; }
  .stat-group-card { overflow: visible; background: #0d1117; }
  .stat-group-head {
    grid-template-columns: 1fr;
    gap: 12px;
    align-items: stretch;
    padding: 13px;
  }
  .stat-group-fields { max-width: none; }
  .stat-group-actions { justify-content: flex-start; padding: 0; }
  .stat-group-card .stat-table-card { padding: 0 10px 2px; }
  .stat-group-card .stat-row { margin-bottom: 10px; }
}

@media (max-width: 520px) {
  .stat-group-fields { grid-template-columns: 1fr; }
  .stat-group-actions { display: grid; grid-template-columns: 1fr 1fr; }
  .stat-group-actions .small-button { width: 100%; }
  .stat-key-composer { min-width: 0; }
  .stat-key-prefix { max-width: 55%; overflow: hidden; text-overflow: ellipsis; }
}
"""
if '/* Grouped stat pool */' not in css:
    css = css.rstrip() + css_block + '\n'
else:
    raise SystemExit('Grouped stat pool CSS already exists')

APP_PATH.write_text(app)
CSS_PATH.write_text(css)
print('Applied grouped stat pool changes.')
