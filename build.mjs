// 离线构建：用 Node 标准库 node:module.stripTypeScriptTypes 把 src/*.ts
// 擦除类型后输出到 public/js/*.js。不使用任何第三方包。
// 用法: node build.mjs [--watch]
import { stripTypeScriptTypes } from 'node:module';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, watch } from 'node:fs';
import { join, basename } from 'node:path';

const SRC = 'src';
const OUT = 'public/js';

function compileOne(file) {
  const src = readFileSync(join(SRC, file), 'utf8');
  const js = stripTypeScriptTypes(src, { mode: 'strip', sourceMap: false });
  const out = join(OUT, file.replace(/\.ts$/, '.js'));
  writeFileSync(out, js);
  console.log(`built ${out}`);
}

function compileAll() {
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(SRC)) {
    if (f.endsWith('.ts')) compileOne(f);
  }
}

compileAll();

if (process.argv.includes('--watch')) {
  watch(SRC, (_ev, name) => {
    if (name && name.endsWith('.ts')) {
      try { compileOne(basename(name)); } catch (e) { console.error(e.message); }
    }
  });
  console.log('watching src/ ...');
}
