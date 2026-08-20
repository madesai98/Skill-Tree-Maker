from pathlib import Path

path = Path('src/App.tsx')
text = path.read_text()
old = """      if (touched.has('stats')) {
        setStats((current) => applyHistoryTransitionsToCollection(current, 'stats', detail.transitions));
      }
"""
new = """      if (touched.has('stats')) {
        setStats((current) => normalizeStats(
          applyHistoryTransitionsToCollection(current, 'stats', detail.transitions),
        ));
      }
"""
if text.count(old) != 1:
    raise SystemExit(f'Expected one stats history block, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
print('Normalized stat history transitions for legacy/cloud compatibility.')
