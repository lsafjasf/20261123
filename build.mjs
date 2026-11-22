import { stripTypeScriptTypes } from 'node:module';
import { readdirSync, statSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const SRC = join(root, 'src');
const OUT = join(root, 'public', 'js');

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else if (name.endsWith('.ts')) files.push(p);
  }
  return files;
}

let count = 0;
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).replace(/\.ts$/, '.js');
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  const source = readFileSync(file, 'utf8');
  const js = stripTypeScriptTypes(source, { mode: 'strip', sourceMap: false });
  writeFileSync(dest, js);
  count++;
}
console.log(`built ${count} module(s) -> ${relative(root, OUT)}/`);
