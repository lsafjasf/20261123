/** 纯 node:http 服务：静态托管浏览器端 + JSON API，无任何第三方依赖。 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION, DEFAULT_CONFIG, configHash } from '../shared/config.ts';
import { exportAll } from '../shared/exporters.ts';
import type { BatchUpload } from '../shared/types.ts';
import { ScanStore } from './store.ts';
import { analyzeFromStore, exportMasterShotsCsv } from './pipeline.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB_ROOT = normalize(join(HERE, '..', 'web'));
const SHARED_ROOT = normalize(join(HERE, '..', 'shared'));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.edl': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function createApp(store: ScanStore) {
  return createServer((req, res) => {
    handle(req, res, store).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, store: ScanStore): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = `${(req.method ?? 'GET').toUpperCase()} ${url.pathname}`;

  if (route === 'GET /api/health') {
    sendJson(res, 200, { ok: true, engineVersion: ENGINE_VERSION, configHash: configHash() });
    return;
  }
  if (route === 'GET /api/config') {
    sendJson(res, 200, { engineVersion: ENGINE_VERSION, config: DEFAULT_CONFIG });
    return;
  }
  if (route === 'GET /api/scans') {
    sendJson(res, 200, { scans: store.listStates() });
    return;
  }
  if (route === 'GET /api/results') {
    sendJson(res, 200, { results: store.listResults() });
    return;
  }
  if (route === 'GET /api/results/master-shots.csv') {
    res.writeHead(200, { 'content-type': MIME['.csv'] });
    res.end(exportMasterShotsCsv(store));
    return;
  }
  const stateMatch = url.pathname.match(/^\/api\/scans\/([a-f0-9]{64})$/);
  if (stateMatch && req.method === 'GET') {
    const state = store.getState(stateMatch[1]);
    if (!state) return sendJson(res, 404, { error: '扫描任务不存在' });
    return sendJson(res, 200, state);
  }
  if (route === 'POST /api/batches') {
    const body = (await readJson(req)) as BatchUpload;
    const ack = store.uploadBatch(body);
    return sendJson(res, 200, ack);
  }
  const completeMatch = url.pathname.match(/^\/api\/scans\/([a-f0-9]{64})\/complete$/);
  if (completeMatch && req.method === 'POST') {
    const body = (await readJson(req)) as { totalFrames: number };
    const state = store.complete(completeMatch[1], body.totalFrames);
    return sendJson(res, 200, state);
  }
  const analyzeMatch = url.pathname.match(/^\/api\/scans\/([a-f0-9]{64})\/analyze$/);
  if (analyzeMatch && req.method === 'POST') {
    const output = analyzeFromStore(store, analyzeMatch[1]);
    return sendJson(res, 200, { result: output.result, exportDir: output.exportDir });
  }
  const resultMatch = url.pathname.match(/^\/api\/results\/([a-f0-9]{64})$/);
  if (resultMatch && req.method === 'GET') {
    const result = store.getResult(resultMatch[1]);
    if (!result) return sendJson(res, 404, { error: '结果不存在' });
    return sendJson(res, 200, result);
  }
  const exportMatch = url.pathname.match(
    /^\/api\/results\/([a-f0-9]{64})\/export\/(.+)$/,
  );
  if (exportMatch && req.method === 'GET') {
    const result = store.getResult(exportMatch[1]);
    if (!result) return sendJson(res, 404, { error: '结果不存在' });
    const files = exportAll(result);
    const name = decodeURIComponent(exportMatch[2]);
    const content = files[name as keyof typeof files];
    if (!content) return sendJson(res, 404, { error: '导出文件不存在' });
    const ext = name.endsWith('.edl') ? '.edl' : name.endsWith('.json') ? '.json' : '.csv';
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'text/plain',
      'content-disposition': `attachment; filename="${name}"`,
    });
    return res.end(content);
  }
  return serveStatic(url.pathname, res);
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  let root = WEB_ROOT;
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (relative.startsWith('shared/')) {
    root = SHARED_ROOT;
    relative = relative.slice('shared/'.length);
  }
  const filePath = normalize(join(root, relative));
  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const info = await stat(filePath);
  if (!info.isFile()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const content = await readFile(filePath);
  res.writeHead(200, {
    'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(content);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
