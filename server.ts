// Timelapse Studio server — Node.js standard library only.
// Run: node server.ts  (Node >= 22.13, strips TypeScript types natively)
import http from 'node:http';
import { promises as fsp, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = path.join(ROOT, 'photos');
const EXPORT_DIR = path.join(ROOT, 'export');
const CLIENT_DIR = path.join(ROOT, 'src', 'client');
const PORT = Number(process.env.PORT || 8080);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webm': 'video/webm',
  '.csv': 'text/csv; charset=utf-8',
};

function send(res: http.ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

function safeJoin(base: string, rel: string): string | null {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base + path.sep) || p === base ? p : null;
}

async function readBody(req: http.IncomingMessage, limit = 512 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// --- TypeScript on-the-fly transpile (erasable-syntax-only sources) ---
const tsCache = new Map<string, { mtimeMs: number; js: string }>();

async function serveTypeScript(res: http.ServerResponse, file: string): Promise<void> {
  const stat = await fsp.stat(file);
  const hit = tsCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) {
    send(res, 200, hit.js, MIME['.ts']);
    return;
  }
  const src = await fsp.readFile(file, 'utf8');
  let js: string;
  try {
    js = stripTypeScriptTypes(src, { mode: 'strip', sourceMap: false });
  } catch (err) {
    send(res, 500, `// transpile error in ${path.basename(file)}: ${(err as Error).message}`, MIME['.ts']);
    return;
  }
  tsCache.set(file, { mtimeMs: stat.mtimeMs, js });
  send(res, 200, js, MIME['.ts']);
}

async function serveStatic(res: http.ServerResponse, file: string): Promise<void> {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.ts') {
    await serveTypeScript(res, file);
    return;
  }
  await fsp.access(file);
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// --- API ---
async function listPhotos(res: http.ServerResponse): Promise<void> {
  let names: string[] = [];
  try {
    names = (await fsp.readdir(PHOTOS_DIR))
      .filter((n) => /\.(png|jpe?g)$/i.test(n))
      .sort();
  } catch {
    // photos dir may not exist yet
  }
  const items = [];
  for (const n of names) {
    const st = await fsp.stat(path.join(PHOTOS_DIR, n));
    items.push({ name: n, url: `/photos/${encodeURIComponent(n)}`, bytes: st.size, mtime: st.mtimeMs });
  }
  sendJson(res, 200, { photos: items });
}

function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function saveReport(res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
  const body = await readBody(req);
  const report = JSON.parse(body.toString('utf8')) as {
    anomalies?: Array<Record<string, unknown>>;
    frames?: Array<Record<string, unknown>>;
  };
  await fsp.mkdir(EXPORT_DIR, { recursive: true });
  await fsp.writeFile(path.join(EXPORT_DIR, 'report.json'), JSON.stringify(report, null, 2));

  const anomalies = report.anomalies ?? [];
  const cols = ['frame', 'name', 'kind', 'detail'];
  const rows = [cols.join(',')].concat(
    anomalies.map((a) => cols.map((c) => csvEscape(a[c])).join(',')),
  );
  await fsp.writeFile(path.join(EXPORT_DIR, 'anomalies.csv'), rows.join('\n') + '\n');
  sendJson(res, 200, { ok: true, anomalies: anomalies.length });
}

async function saveBinary(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  filename: string,
): Promise<void> {
  const clean = path.basename(filename);
  if (!/^[A-Za-z0-9._-]+$/.test(clean)) {
    sendJson(res, 400, { ok: false, error: 'bad filename' });
    return;
  }
  const body = await readBody(req);
  await fsp.mkdir(EXPORT_DIR, { recursive: true });
  await fsp.writeFile(path.join(EXPORT_DIR, clean), body);
  sendJson(res, 200, { ok: true, file: `export/${clean}`, bytes: body.length });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const p = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && p === '/') {
      await serveStatic(res, path.join(CLIENT_DIR, 'index.html'));
      return;
    }
    if (req.method === 'GET' && p === '/api/photos') {
      await listPhotos(res);
      return;
    }
    if (req.method === 'POST' && p === '/api/export/report') {
      await saveReport(res, req);
      return;
    }
    if (req.method === 'POST' && (p === '/api/export/video' || p === '/api/export/frame')) {
      const name = url.searchParams.get('name') || (p.endsWith('video') ? 'timelapse.webm' : 'frame.png');
      await saveBinary(res, req, name);
      return;
    }
    if (req.method === 'GET' && (p.startsWith('/src/') || p.startsWith('/photos/') || p.startsWith('/export/'))) {
      const file = safeJoin(ROOT, p.slice(1));
      if (!file) {
        send(res, 403, 'forbidden');
        return;
      }
      await serveStatic(res, file);
      return;
    }
    send(res, 404, 'not found');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      send(res, 404, 'not found');
    } else {
      send(res, 500, `server error: ${(err as Error).message}`);
    }
  }
});

server.listen(PORT, () => {
  console.log(`Timelapse Studio → http://localhost:${PORT}`);
  console.log(`photos: ${PHOTOS_DIR}`);
  console.log(`export: ${EXPORT_DIR}`);
});
