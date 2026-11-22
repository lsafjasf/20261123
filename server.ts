import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(import.meta.dirname);
const publicDir = join(root, 'public');
const artifactDir = join(root, 'artifacts');
const port = Number(process.env.PORT || 4173);

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
  '.svg': 'image/svg+xml'
};

function safePath(base: string, requestPath: string): string | null {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const candidate = resolve(base, `.${normalize(decoded)}`);
  return candidate.startsWith(base + '/') || candidate === base ? candidate : null;
}

async function sendFile(req: IncomingMessage, res: ServerResponse, filePath: string): Promise<void> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error('not a file');

  const range = req.headers.range;
  const headers: Record<string, string | number> = {
    'Content-Type': mime[extname(filePath)] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  };

  let start = 0;
  let end = info.size - 1;
  let status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      start = match[1] ? Number(match[1]) : 0;
      end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath, { start, end }).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    if (!req.url) throw new Error('missing url');
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, streaming: true }));
      return;
    }
    if (url.pathname === '/') {
      await sendFile(req, res, join(publicDir, 'index.html'));
      return;
    }
    if (url.pathname.startsWith('/artifacts/')) {
      const target = safePath(artifactDir, url.pathname.slice('/artifacts'.length));
      if (!target) throw new Error('bad path');
      await sendFile(req, res, target);
      return;
    }
    const target = safePath(publicDir, url.pathname);
    if (!target) throw new Error('bad path');
    await sendFile(req, res, target);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

function listen(candidate: number): void {
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (!process.env.PORT && error.code === 'EADDRINUSE' && candidate < port + 20) {
      listen(candidate + 1);
      return;
    }
    throw error;
  });
  server.listen(candidate, '127.0.0.1', () => {
    console.log(`Loudness Desk: http://127.0.0.1:${candidate}`);
  });
}

listen(port);
