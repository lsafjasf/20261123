/**
 * Offline static + JSON API server using only node:http.
 * Serves the browser app, transpiles .ts sources on the fly with the built-in
 * type-stripping API, and exposes an analysis endpoint over uploaded WAV files.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { parseWav } from '../core/wav.ts';
import { analyzeTracks, prepareTracks } from '../core/analyze.ts';
import { DEFAULT_THRESHOLDS, type DecodedTrack } from '../core/types.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const CURRENT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(CURRENT_DIR, '..', 'web', 'public');
const PROJECT_ROOT = join(CURRENT_DIR, '..', '..');

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveFile(res: ServerResponse, absolutePath: string): void {
  if (!existsSync(absolutePath) || statSync(absolutePath).isDirectory()) {
    send(res, 404, 'Not found');
    return;
  }
  const ext = extname(absolutePath).toLowerCase();
  if (ext === '.ts') {
    const source = readFileSync(absolutePath, 'utf8');
    const stripped = stripTypeScriptTypes(source, { mode: 'transform' });
    send(res, 200, stripped, MIME['.js']);
    return;
  }
  send(res, 200, readFileSync(absolutePath), MIME[ext] ?? 'application/octet-stream');
}

/** Resolve a URL path to a project file, blocking path traversal. */
function resolveSource(urlPath: string): string | null {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  if (urlPath.startsWith('/src/')) return join(PROJECT_ROOT, clean);
  return join(PUBLIC_DIR, clean === '/' ? 'index.html' : clean);
}

function readBody(req: IncomingMessage, maxBytes = 256 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Upload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleAnalyze(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const payload = JSON.parse(body.toString('utf8')) as {
    files: { name: string; base64: string }[];
  };
  const tracks: DecodedTrack[] = payload.files.map((file) => {
    const bytes = Buffer.from(file.base64, 'base64');
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const decoded = parseWav(arrayBuffer);
    return {
      fileName: file.name,
      kind: 'unknown',
      sampleRate: decoded.sampleRate,
      channelCount: decoded.channelCount,
      durationSec: decoded.pcm.channels[0].length / decoded.sampleRate,
      pcm: decoded.pcm,
    };
  });
  const report = analyzeTracks(prepareTracks(tracks), DEFAULT_THRESHOLDS);
  send(res, 200, JSON.stringify(report), MIME['.json']);
}

/** List WAV/MP4 files inside the served media root for the picker UI. */
function handleList(mediaRoot: string, res: ServerResponse): void {
  const result: { audio: string[]; video: string[] } = { audio: [], video: [] };
  if (existsSync(mediaRoot) && statSync(mediaRoot).isDirectory()) {
    for (const entry of readdirSync(mediaRoot).sort()) {
      const ext = extname(entry).toLowerCase();
      const full = join(mediaRoot, entry);
      if (!statSync(full).isFile()) continue;
      if (ext === '.wav') result.audio.push(entry);
      if (ext === '.mp4' || ext === '.webm') result.video.push(entry);
    }
  }
  send(res, 200, JSON.stringify(result), MIME['.json']);
}

export async function startServer(mediaRoot: string, port: number): Promise<void> {
  const absoluteMediaRoot = join(process.cwd(), mediaRoot);
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0];
    Promise.resolve()
      .then(async () => {
        if (req.method === 'POST' && path === '/api/analyze') {
          await handleAnalyze(req, res);
          return;
        }
        if (req.method === 'GET' && path === '/api/list') {
          handleList(absoluteMediaRoot, res);
          return;
        }
        if (req.method === 'GET' && path.startsWith('/media/')) {
          const file = join(absoluteMediaRoot, normalize(path.slice('/media/'.length)));
          serveFile(res, file);
          return;
        }
        serveFile(res, resolveSource(path) ?? join(PUBLIC_DIR, 'index.html'));
      })
      .catch((error: Error) => send(res, 500, JSON.stringify({ error: error.message }), MIME['.json']));
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`Offline server running at http://localhost:${port}`);
  console.log(`Media root: ${absoluteMediaRoot}`);
}
