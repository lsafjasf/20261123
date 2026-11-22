// 构建脚本：用 Node 内置 module.stripTypeScriptTypes 把 src/*.ts 转成 public/*.js
// 不引入任何第三方依赖；TS 源码仅使用可擦除语法（无 enum/namespace/参数属性）。
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const targets = ['main.ts', 'worklet.ts'];

mkdirSync(join(root, 'public'), { recursive: true });

for (const name of targets) {
  const src = readFileSync(join(root, 'src', name), 'utf8');
  const js = stripTypeScriptTypes(src, { mode: 'strip' });
  const out = join(root, 'public', name.replace(/\.ts$/, '.js'));
  writeFileSync(out, js);
  console.log(`built: src/${name} -> public/${name.replace(/\.ts$/, '.js')} (${js.length} bytes)`);
}
