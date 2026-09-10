from pathlib import Path

path = Path('.github/render-isolation-patch.py')
script = path.read_text()
start = script.index("swap(\n    \"function MaskedSvgIcon")
end = script.index("\nswap(\n    \"  const clipboardRef", start)
script = script[:start] + script[end + 1:]
exec(compile(script, str(path), 'exec'))
