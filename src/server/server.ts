import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { contentTypeFor } from './mime.ts';
import { transpileClientModule } from './transpile.ts';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const publicDir = join(projectRoot, 'src', 'client');
const sharedDir = join(projectRoot, 'src', 'shared');

const transpileCache = new Map<string, { mtimeMs: number; code: string }>();

function safeResolve(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname.split('?')[0] ?? '/');
  const relative = decoded === '/' ? '/index.html' : decoded;
  const candidates = [
    join(publicDir, normalize(relative)),
    join(sharedDir, normalize(relative.replace(/^\/shared\//, '/'))),
  ];
  for (const candidate of candidates) {
    const inside =
      candidate.startsWith(publicDir + sep) ||
      candidate.startsWith(sharedDir + sep);
    if (inside && existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function serveTranspiled(filePath: string, res: ServerResponse): void {
  const stat = statSync(filePath);
  const cached = transpileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(cached.code);
    return;
  }
  const source = readFileSync(filePath, 'utf8');
  const sourceUrl = '/' + filePath.slice(projectRoot.length + 1);
  const { code } = transpileClientModule(source, sourceUrl);
  transpileCache.set(filePath, { mtimeMs: stat.mtimeMs, code });
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
  res.end(code);
}

function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
): void {
  if (extname(filePath) === '.ts') {
    serveTranspiled(filePath, res);
    return;
  }
  const stat = statSync(filePath);
  const type = contentTypeFor(filePath);
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (start >= 0 && end < stat.size && start <= end) {
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
        });
        createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
  });
  createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
  const pathname = req.url ?? '/';
  const filePath = safeResolve(pathname);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  try {
    serveFile(req, res, filePath);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`500 ${(err as Error).message}`);
  }
});

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => {
  console.log(`esports multiview: http://localhost:${port}/`);
  console.log(`serving ${publicDir} (+ shared modules via /shared/*)`);
});
