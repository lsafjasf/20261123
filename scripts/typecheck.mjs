/**
 * 零依赖类型擦除闸门：
 * 离线环境没有 tsc 时，用 Node 内置 stripTypeScriptTypes 校验所有源码
 * 都属于“可擦除 TypeScript”（无 enum / namespace / 参数属性），
 * 保证浏览器与 Node 都能直接加载。
 * 若环境中安装了 typescript，可改用 `npx tsc --noEmit` 做完整类型检查。
 */
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scanDirs = ['src', 'test'];
const files = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
    } else if (extname(full) === '.ts') {
      files.push(full);
    }
  }
}

for (const directory of scanDirs) {
  walk(join(root, directory));
}

let failed = 0;
for (const file of files) {
  try {
    stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
    console.log(`ok   ${file.replace(root, '')}`);
  } catch (error) {
    failed += 1;
    console.error(`fail ${file.replace(root, '')}: ${error.message}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) contain non-strippable TypeScript syntax.`);
  process.exit(1);
}
console.log(`\nall ${files.length} TypeScript files are strippable and runtime-safe.`);
