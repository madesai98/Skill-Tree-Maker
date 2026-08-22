from pathlib import Path

path = Path('src/App.tsx')
text = path.read_text()
old = "  const [perks, setPerks] = useState<SkillFlowNode[]>(initial.perks);\n"
new = "  const [perks, setPerks] = useState<PerkFlowNode[]>(initial.perks);\n"
if text.count(old) != 1:
    raise RuntimeError(f'perk state type: expected one match, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
print('Updated perk state type.')
