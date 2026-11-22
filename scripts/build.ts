// 构建：用 Node 内置的类型擦除把 src/web 与 src/shared 转成浏览器可跑的 JS。
// 零第三方依赖；仅做类型擦除 + 导入路径 .ts→.js 重写。
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIRS = ['src/web', 'src/shared'];
const OUT = join(root, 'public/app');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

let count = 0;
for (const dir of SRC_DIRS) {
  for (const file of walk(join(root, dir))) {
    const src = readFileSync(file, 'utf8');
    let js = stripTypeScriptTypes(src, { mode: 'strip', sourceMap: false });
    // 重写相对导入的 .ts 后缀为 .js
    js = js.replace(/(from\s+['"]|import\s*\(\s*['"])(\.\.?\/[^'"]+)\.ts(['"])/g, '$1$2.js$3');
    const rel = relative(join(root, 'src'), file).replace(/\.ts$/, '.js');
    const outFile = join(OUT, rel);
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, js);
    count++;
  }
}
console.log(`构建完成: ${count} 个模块 → public/app/`);
