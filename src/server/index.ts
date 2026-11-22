#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { transformBrowserTs } from './ts-transform.ts';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const webRoot = join(projectRoot, 'src/browser');
const sharedRoot = join(projectRoot, 'src/shared');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};

const safeJoin = (root: string, pathname: string): string | null => {
  const decoded = decodeURIComponent(pathname.split('?')[0]);
  const normalized = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = join(root, normalized);
  if (!full.startsWith(root)) return null;
  return full;
};

const send = (res: ServerResponse, status: number, body: string | Buffer, type?: string): void => {
  res.writeHead(status, {
    'Content-Type': type ?? 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

const serveTs = async (filePath: string, res: ServerResponse): Promise<void> => {
  try {
    const source = await readFile(filePath, 'utf8');
    send(res, 200, transformBrowserTs(source), MIME['.js']);
  } catch {
    send(res, 404, `未找到模块：${filePath}`);
  }
};

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;

  if (pathname.startsWith('/shared/')) {
    const relative = pathname
      .replace('/shared/', '')
      .replace(/\.js$/, '.ts');
    const full = safeJoin(sharedRoot, relative);
    if (!full) return send(res, 403, '路径越界');
    if (extname(full) === '.ts') return serveTs(full, res);
    return send(res, 404, '共享模块仅提供 .ts');
  }

  // Browser code requests TypeScript files as ".js?ts=1" after rewriting.
  if (url.searchParams.get('ts') === '1' || pathname.endsWith('.ts')) {
    const full = safeJoin(webRoot, pathname.replace(/\.js$/, '.ts'));
    if (!full) return send(res, 403, '路径越界');
    return serveTs(full, res);
  }

  const full = safeJoin(webRoot, pathname);
  if (!full) return send(res, 403, '路径越界');
  try {
    const body = await readFile(full);
    send(res, 200, body, MIME[extname(full)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, `未找到：${pathname}`);
  }
});

const port = Number(process.env.PORT ?? 8127);
server.listen(port, () => {
  process.stdout.write(
    [
      `课程混音本地检查器已启动：http://localhost:${port}`,
      '所有音频仅在本机浏览器内处理，不会上传。',
    ].join('\n'),
  );
});
