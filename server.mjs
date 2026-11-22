// 零依赖静态服务器：仅用 Node 标准库。
// 浏览器请求 .ts 模块时，用内置 module.stripTypeScriptTypes 去类型后
// 以 JavaScript module MIME 返回；.ts 源码本身按 text/plain 兜底。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const normalized = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const target = join(root, normalized);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

const server = createServer(async (req, res) => {
  try {
    let path = safePath(req.url ?? '/');
    if (!path) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    let info = await stat(path).catch(() => null);
    if (info?.isDirectory()) path = join(path, 'index.html');
    info = await stat(path).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = extname(path);
    if (ext === '.ts') {
      const source = await readFile(path, 'utf8');
      const js = stripTypeScriptTypes(source, { mode: 'transform' });
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(js);
      return;
    }
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});

server.listen(port, () => {
  console.log(`dev server: http://localhost:${port}/web/index.html`);
});
