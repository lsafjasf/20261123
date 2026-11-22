// Zero-dependency static + cue-list storage server (Node standard library only).
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DATA = join(ROOT, 'data');
const PORT = Number(process.env.PORT ?? 8046);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
};

function safeName(name: string): string | null {
  return /^[\w.-]{1,64}$/.test(name) ? name : null;
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname === '/api/cuelists' && req.method === 'GET') {
      await mkdir(DATA, { recursive: true });
      const names = (await readdir(DATA)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
      res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify(names));
      return;
    }
    if (url.pathname === '/api/cuelist') {
      const name = safeName(url.searchParams.get('name') ?? '');
      if (!name) {
        res.writeHead(400).end('bad name');
        return;
      }
      const file = join(DATA, `${name}.json`);
      if (req.method === 'GET') {
        const data = await readFile(file, 'utf8');
        res.writeHead(200, { 'content-type': MIME['.json'] }).end(data);
        return;
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        JSON.parse(body); // validate before writing
        await mkdir(DATA, { recursive: true });
        await writeFile(file, body);
        res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify({ ok: true }));
        return;
      }
    }
    // static files
    const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^([/\\])+/, '');
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) {
      res.writeHead(403).end();
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(data);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
    res.writeHead(code).end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`foley studio: http://localhost:${PORT}`);
});
