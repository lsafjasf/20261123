/**
 * 零第三方依赖的静态服务器（node:http + node:fs）。
 * 浏览器（基于 Chromium，开启 --experimental-strip-types 的运行时，或
 * 通过 flag 支持 TS 模块的环境）可直接加载 .ts ESM；
 * 其他环境可由本服务把 TS 源码原样下发，MIME 标为 video/mp2t 之外的
 * text/javascript 以匹配 ESM 模块要求。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(process.cwd());
const PORT = Number(process.env.PORT ?? 8080);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function safePath(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const normalized = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = join(ROOT, normalized);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let path = safePath(req.url ?? '/');
  if (!path) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (existsSync(path) && statSync(path).isDirectory()) {
    path = join(path, 'index.html');
  }
  if (!existsSync(path)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const ext = extname(path);
  // 浏览器无法直接执行 TS：用内置 stripTypeScriptTypes 即时擦除类型，
  // 输出 ESM JS。所有源码已规避 enum / 参数属性等不可擦除语法。
  if (ext === '.ts') {
    try {
      const source = readFileSync(path, 'utf8');
      const js = stripTypeScriptTypes(source, { mode: 'strip' });
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(js);
      return;
    } catch (err) {
      res.writeHead(500);
      res.end(`TS 擦除失败: ${(err as Error).message}`);
      return;
    }
  }
  const type = MIME[ext] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(res);
});

server.listen(PORT, () => {
  console.log(`静态服务: http://localhost:${PORT}/demo/`);
  console.log(`根目录: ${ROOT}`);
});
