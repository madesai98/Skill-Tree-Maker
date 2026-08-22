import fs from 'node:fs';

const sourcePath = new URL('./add-perks.mjs', import.meta.url);
const fixedPath = new URL('./add-perks-fixed.mjs', import.meta.url);
const source = fs.readFileSync(sourcePath, 'utf8');
const fixed = source
  .replaceAll(/(?<!\\)\$\{base\}/g, '\\${base}')
  .replaceAll(/(?<!\\)\$\{index \+ 1\}/g, '\\${index + 1}');

fs.writeFileSync(fixedPath, fixed);
try {
  await import(fixedPath.href);
} finally {
  fs.rmSync(fixedPath, { force: true });
}
