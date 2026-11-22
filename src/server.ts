// Local static server that serves TypeScript as browser-runnable JavaScript.
// Uses Node's built-in type-stripping module API only — no bundler or package.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT ?? 8731);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function stripTypes(source: string): Promise<string> {
  // node:module's stripTypeScriptTypes is available on Node >= 22.6.
  const moduleApi = await import('node:module');
  const strip =
    (moduleApi as { stripTypeScriptTypes?: (s: string) => string }).stripTypeScriptTypes;
  if (typeof strip !== 'function') {
    throw new Error('当前 Node 版本缺少 module.stripTypeScriptTypes，请升级到 Node >= 22.6');
  }
  // Rewrite .ts import specifiers so the browser loads the stripped modules.
  const rewritten = source.replace(/(from\s+['"])([^'"]+?)\.ts(['"])/g, '$1$2.ts$3');
  return strip(rewritten);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/web/index.html';
    const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(root, safePath);
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = extname(filePath);
    if (ext === '.ts') {
      const source = await readFile(filePath, 'utf8');
      const js = await stripTypes(source);
      res.writeHead(200, { 'Content-Type': MIME[ext]! });
      res.end(js);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(await readFile(filePath));
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404: ${(error as Error).message}`);
  }
});

server.listen(port, () => {
  console.log(`浏览器验证页: http://localhost:${port}/web/index.html`);
  console.log('按 Ctrl+C 停止');
});
