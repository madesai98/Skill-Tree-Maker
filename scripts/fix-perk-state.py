from pathlib import Path

path = Path('src/App.tsx')
text = path.read_text()

replacements = [
    (
        "  const [perks, setPerks] = useState<SkillFlowNode[]>(initial.perks);\n",
        "  const [perks, setPerks] = useState<PerkFlowNode[]>(initial.perks);\n",
        'perk state type',
    ),
    (
        "              const usage = [...nodes, ...perks].filter((node) => node.data.cost.currencyId === currency.id).length;\n",
        "              const usage = nodes.filter((node) => node.data.cost.currencyId === currency.id).length;\n",
        'currency usage count',
    ),
]

for old, new, label in replacements:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    text = text.replace(old, new, 1)

path.write_text(text)
print('Updated perk state and currency usage typing.')
