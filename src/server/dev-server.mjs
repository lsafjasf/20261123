/**
 * 离线开发服务器：仅使用 Node.js 标准库（node:http / node:fs / node:path），
 * 不连接任何外部服务，不安装第三方依赖。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const root = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.PORT ?? 8080);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') {
      pathname = '/index.html';
    }
    const relativePath = normalize(pathname).replace(/^([/\\])+/, '');
    const filePath = join(root, relativePath);
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const raw = await readFile(filePath, 'utf8');
    if (extname(filePath) === '.ts') {
      // 服务端即时类型擦除：浏览器拿到的是标准 ESM JavaScript，无需实验标志或外部依赖。
      const javascript = stripTypeScriptTypes(raw, { mode: 'strip' });
      res.writeHead(200, { 'Content-Type': mime['.ts'] });
      res.end(javascript);
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[extname(filePath)] ?? 'application/octet-stream' });
    res.end(raw);
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`not found: ${String(error)}`);
  }
});

server.listen(port, () => {
  console.log(`offline dev server: http://localhost:${port}/  (root: ${root})`);
});
