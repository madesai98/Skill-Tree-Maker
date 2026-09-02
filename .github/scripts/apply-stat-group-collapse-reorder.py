from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one {label} match, found {count}")
    return text.replace(old, new, 1)


app_path = Path("src/App.tsx")
app = app_path.read_text()

app = replace_once(
    app,
    "function Icon({ name }: { name: 'plus' | 'trash' | 'download' | 'upload' | 'tree' | 'perks' | 'playtest' | 'stats' | 'close' | 'link' | 'currency' | 'icons' | 'nodeName' | 'nodeStats' }) {",
    "function Icon({ name }: { name: 'plus' | 'trash' | 'download' | 'upload' | 'tree' | 'perks' | 'playtest' | 'stats' | 'close' | 'link' | 'currency' | 'icons' | 'nodeName' | 'nodeStats' | 'chevron' | 'grip' }) {",
    "Icon name union",
)

app = replace_once(
    app,
    "    nodeStats: <><path d=\"M4 6h7m4 0h5M4 12h3m4 0h9M4 18h9m4 0h3\" /><path d=\"M13 4v4M9 10v4M15 16v4\" /></>,\n",
    "    nodeStats: <><path d=\"M4 6h7m4 0h5M4 12h3m4 0h9M4 18h9m4 0h3\" /><path d=\"M13 4v4M9 10v4M15 16v4\" /></>,\n    chevron: <path d=\"m7 9 5 5 5-5\" />,\n    grip: <><circle cx=\"8\" cy=\"7\" r=\"1\" /><circle cx=\"8\" cy=\"12\" r=\"1\" /><circle cx=\"8\" cy=\"17\" r=\"1\" /><circle cx=\"16\" cy=\"7\" r=\"1\" /><circle cx=\"16\" cy=\"12\" r=\"1\" /><circle cx=\"16\" cy=\"17\" r=\"1\" /></>,\n",
    "Icon paths",
)

app = replace_once(
    app,
    "  const clipboardRef = useRef<ClipboardSnapshot | null>(null);\n  const pasteCountRef = useRef(0);\n\n  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;",
    "  const clipboardRef = useRef<ClipboardSnapshot | null>(null);\n  const pasteCountRef = useRef(0);\n  const [collapsedStatGroupIds, setCollapsedStatGroupIds] = useState<Set<string>>(() => new Set());\n  const [draggedStatGroupId, setDraggedStatGroupId] = useState<string | null>(null);\n  const [statGroupDropTarget, setStatGroupDropTarget] = useState<{ groupId: string; placement: 'before' | 'after' } | null>(null);\n\n  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;",
    "stat group UI state",
)

app = replace_once(
    app,
    "    return [...groups.values()];\n  }, [stats]);\n\n  const showNotice = useCallback((message: string) => {",
    "    return [...groups.values()];\n  }, [stats]);\n\n  useEffect(() => {\n    const validGroupIds = new Set(statGroups.map((group) => group.id));\n    setCollapsedStatGroupIds((current) => {\n      const next = new Set([...current].filter((groupId) => validGroupIds.has(groupId)));\n      return next.size === current.size ? current : next;\n    });\n    setDraggedStatGroupId((current) => current && !validGroupIds.has(current) ? null : current);\n    setStatGroupDropTarget((current) => current && !validGroupIds.has(current.groupId) ? null : current);\n  }, [statGroups]);\n\n  const showNotice = useCallback((message: string) => {",
    "stat group state cleanup effect",
)

app = replace_once(
    app,
    "  const updateStat = (statId: string, patch: Partial<StatDefinition>) => {",
    "  const toggleStatGroupCollapsed = (groupId: string) => {\n    setCollapsedStatGroupIds((current) => {\n      const next = new Set(current);\n      if (next.has(groupId)) next.delete(groupId);\n      else next.add(groupId);\n      return next;\n    });\n  };\n\n  const reorderStatGroup = (sourceGroupId: string, targetGroupId: string, placement: 'before' | 'after') => {\n    if (sourceGroupId === targetGroupId) return;\n    setStats((current) => {\n      const groupOrder: string[] = [];\n      const groupedStats = new Map<string, StatDefinition[]>();\n      current.forEach((stat) => {\n        if (!groupedStats.has(stat.groupId)) {\n          groupedStats.set(stat.groupId, []);\n          groupOrder.push(stat.groupId);\n        }\n        groupedStats.get(stat.groupId)!.push(stat);\n      });\n\n      if (!groupedStats.has(sourceGroupId) || !groupedStats.has(targetGroupId)) return current;\n      const nextGroupOrder = groupOrder.filter((groupId) => groupId !== sourceGroupId);\n      const targetIndex = nextGroupOrder.indexOf(targetGroupId);\n      const insertIndex = placement === 'after' ? targetIndex + 1 : targetIndex;\n      nextGroupOrder.splice(insertIndex, 0, sourceGroupId);\n      if (nextGroupOrder.every((groupId, index) => groupId === groupOrder[index])) return current;\n      return nextGroupOrder.flatMap((groupId) => groupedStats.get(groupId) ?? []);\n    });\n  };\n\n  const updateStat = (statId: string, patch: Partial<StatDefinition>) => {",
    "stat group reorder helpers",
)

app = replace_once(
    app,
    """              {statGroups.map((group) => (\n                <section className=\"stat-group-card\" key={group.id}>\n                  <div className=\"stat-group-head\">""",
    """              {statGroups.map((group) => {\n                const collapsed = collapsedStatGroupIds.has(group.id);\n                const dropPlacement = statGroupDropTarget?.groupId === group.id ? statGroupDropTarget.placement : null;\n                return (\n                <section\n                  className={`stat-group-card${collapsed ? ' is-collapsed' : ''}${draggedStatGroupId === group.id ? ' is-dragging' : ''}${dropPlacement ? ` is-drop-${dropPlacement}` : ''}`}\n                  key={group.id}\n                  onDragOver={(event) => {\n                    if (!draggedStatGroupId || draggedStatGroupId === group.id) return;\n                    event.preventDefault();\n                    event.dataTransfer.dropEffect = 'move';\n                    const rect = event.currentTarget.getBoundingClientRect();\n                    const placement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';\n                    setStatGroupDropTarget({ groupId: group.id, placement });\n                  }}\n                  onDrop={(event) => {\n                    event.preventDefault();\n                    const sourceGroupId = draggedStatGroupId ?? event.dataTransfer.getData('text/plain');\n                    if (sourceGroupId && sourceGroupId !== group.id && dropPlacement) {\n                      reorderStatGroup(sourceGroupId, group.id, dropPlacement);\n                    }\n                    setDraggedStatGroupId(null);\n                    setStatGroupDropTarget(null);\n                  }}\n                >\n                  <div className=\"stat-group-toolbar\">\n                    <button\n                      type=\"button\"\n                      className=\"stat-group-drag-handle\"\n                      draggable\n                      aria-label={`Reorder ${group.name} group`}\n                      title=\"Drag to reorder group. Arrow keys also work.\"\n                      onDragStart={(event) => {\n                        setDraggedStatGroupId(group.id);\n                        setStatGroupDropTarget(null);\n                        event.dataTransfer.effectAllowed = 'move';\n                        event.dataTransfer.setData('text/plain', group.id);\n                      }}\n                      onDragEnd={() => {\n                        setDraggedStatGroupId(null);\n                        setStatGroupDropTarget(null);\n                      }}\n                      onKeyDown={(event) => {\n                        const groupIndex = statGroups.findIndex((item) => item.id === group.id);\n                        if (event.key === 'ArrowUp' && groupIndex > 0) {\n                          event.preventDefault();\n                          reorderStatGroup(group.id, statGroups[groupIndex - 1].id, 'before');\n                        } else if (event.key === 'ArrowDown' && groupIndex >= 0 && groupIndex < statGroups.length - 1) {\n                          event.preventDefault();\n                          reorderStatGroup(group.id, statGroups[groupIndex + 1].id, 'after');\n                        }\n                      }}\n                    >\n                      <Icon name=\"grip\" />\n                    </button>\n                    <button\n                      type=\"button\"\n                      className=\"stat-group-collapse\"\n                      onClick={() => toggleStatGroupCollapsed(group.id)}\n                      aria-expanded={!collapsed}\n                      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${group.name} group`}\n                    >\n                      <Icon name=\"chevron\" />\n                    </button>\n                    <div className=\"stat-group-summary\">\n                      <strong>{group.name}</strong>\n                      <span>{group.stats.length} stat{group.stats.length === 1 ? '' : 's'} · {group.key}</span>\n                    </div>\n                  </div>\n                  {!collapsed && (\n                    <>\n                  <div className=\"stat-group-head\">""",
    "stat group card opening",
)

app = replace_once(
    app,
    """                    })}\n                  </div>\n                </section>\n              ))}\n            </div>""",
    """                    })}\n                  </div>\n                    </>\n                  )}\n                </section>\n                );\n              })}\n            </div>""",
    "stat group card closing",
)

app_path.write_text(app)

css_path = Path("src/styles.css")
css = css_path.read_text()

css = replace_once(
    css,
    ".view-switcher button svg, .icon-button svg, .primary-button svg, .small-button svg, .danger-button svg, .ghost-icon svg, .row-delete svg, .upgrade-card-head button svg, .prereq-row button svg {",
    ".view-switcher button svg, .icon-button svg, .primary-button svg, .small-button svg, .danger-button svg, .ghost-icon svg, .row-delete svg, .upgrade-card-head button svg, .prereq-row button svg, .stat-group-drag-handle svg, .stat-group-collapse svg {",
    "shared icon styling",
)

css = replace_once(
    css,
    """.stat-group-card {\n  overflow: hidden;\n  border: 1px solid var(--line);\n  border-radius: 14px;\n  background: #0d1117;\n  box-shadow: 0 18px 60px rgba(0,0,0,.14);\n}\n.stat-group-head {""",
    """.stat-group-card {\n  position: relative;\n  overflow: hidden;\n  border: 1px solid var(--line);\n  border-radius: 14px;\n  background: #0d1117;\n  box-shadow: 0 18px 60px rgba(0,0,0,.14);\n  transition: border-color .14s ease, box-shadow .14s ease, opacity .14s ease;\n}\n.stat-group-card.is-dragging { opacity: .48; }\n.stat-group-card.is-drop-before {\n  border-top-color: var(--accent);\n  box-shadow: inset 0 2px 0 var(--accent), 0 18px 60px rgba(0,0,0,.14);\n}\n.stat-group-card.is-drop-after {\n  border-bottom-color: var(--accent);\n  box-shadow: inset 0 -2px 0 var(--accent), 0 18px 60px rgba(0,0,0,.14);\n}\n.stat-group-toolbar {\n  min-height: 48px;\n  padding: 8px 12px;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  border-bottom: 1px solid var(--line);\n  background: rgba(255,255,255,.016);\n}\n.stat-group-card.is-collapsed .stat-group-toolbar { border-bottom: 0; }\n.stat-group-drag-handle, .stat-group-collapse {\n  width: 30px;\n  height: 30px;\n  flex: 0 0 30px;\n  display: grid;\n  place-items: center;\n  padding: 0;\n  border: 1px solid transparent;\n  border-radius: 7px;\n  background: transparent;\n  color: #697382;\n}\n.stat-group-drag-handle { cursor: grab; }\n.stat-group-drag-handle:active { cursor: grabbing; }\n.stat-group-drag-handle:hover, .stat-group-collapse:hover, .stat-group-drag-handle:focus-visible, .stat-group-collapse:focus-visible {\n  border-color: var(--line);\n  background: rgba(255,255,255,.04);\n  color: #dfe5ea;\n  outline: none;\n}\n.stat-group-drag-handle svg, .stat-group-collapse svg { width: 16px; height: 16px; }\n.stat-group-collapse svg { transition: transform .14s ease; }\n.stat-group-card.is-collapsed .stat-group-collapse svg { transform: rotate(-90deg); }\n.stat-group-summary {\n  min-width: 0;\n  display: grid;\n  gap: 3px;\n}\n.stat-group-summary strong {\n  overflow: hidden;\n  color: #dfe5ea;\n  font-size: 11px;\n  font-weight: 760;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.stat-group-summary span {\n  overflow: hidden;\n  color: #687180;\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 9px;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.stat-group-head {""",
    "stat group drag/collapse styles",
)

css = replace_once(
    css,
    """  .stat-group-list { gap: 12px; }\n  .stat-group-card { overflow: visible; background: #0d1117; }\n  .stat-group-head {""",
    """  .stat-group-list { gap: 12px; }\n  .stat-group-card { overflow: visible; background: #0d1117; }\n  .stat-group-toolbar { padding-inline: 10px; }\n  .stat-group-summary span { max-width: 70vw; }\n  .stat-group-head {""",
    "mobile stat group styles",
)

css_path.write_text(css)
print("Applied collapsible and reorderable stat group UI changes.")
