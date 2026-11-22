// Zero-dependency build: strips TypeScript types with Node's built-in
// type stripping and rewrites .ts import specifiers to .js for the browser.
import { stripTypeScriptTypes } from 'node:module';
import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SRC_DIRS = ['src/shared', 'src/client'];
const OUT_DIR = 'public/js';

await mkdir(OUT_DIR, { recursive: true });

let built = 0;
for (const dir of SRC_DIRS) {
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith('.ts')) continue;
    const src = await readFile(join(dir, entry), 'utf8');
    const stripped = stripTypeScriptTypes(src, { mode: 'strip' });
    const out = stripped.replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2');
    await writeFile(join(OUT_DIR, entry.replace(/\.ts$/, '.js')), out);
    built++;
  }
}
console.log(`built ${built} modules -> ${OUT_DIR}`);
