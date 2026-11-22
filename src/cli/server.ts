// 零依赖静态服务器：离线提供 Web 标注台
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml',
};

export function serve(port: number): void {
  const root = fileURLToPath(new URL('../../public/', import.meta.url));
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let path = normalize(decodeURIComponent(url.pathname));
      if (path === '/' || path === '\\') path = '/index.html';
      const file = join(root, path);
      if (!file.startsWith(root)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      try {
        const data = await readFile(file);
        res.writeHead(200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(data);
      } catch {
        res.writeHead(404).end('not found');
      }
    })();
  });
  server.listen(port, () => {
    console.log(`标注台已启动: http://localhost:${port}/ （完全离线，Ctrl+C 停止）`);
  });
}
