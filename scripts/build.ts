import { stripTypeScriptTypes } from 'node:module';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceDir = join(root, 'src');
const outputDir = join(root, 'public', 'js');

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  }));
  return files.flat();
}

function rewriteImports(source: string): string {
  return source
    .replace(/(\bfrom\s+['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(\bimport\s*\(\s*['"])(\.[^'"]+)\.ts(['"]\s*\))/g, '$1$2.js$3');
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const files = (await walk(sourceDir)).filter((file) => file.endsWith('.ts'));
for (const file of files) {
  const source = await readFile(file, 'utf8');
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
  const target = join(outputDir, relative(sourceDir, file)).replace(/\.ts$/, '.js');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, rewriteImports(stripped), 'utf8');
}
await writeFile(join(outputDir, '.built'), new Date().toISOString(), 'utf8');
console.log(`Built ${files.length} TypeScript modules into public/js`);
