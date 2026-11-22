/**
 * 静态资源服务：对 .ts 文件即时做类型擦除后以 JS 模块下发，
 * 其余文件按常规 MIME 提供。全程仅用 node: 标准库。
 */

import { createReadStream, stat } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { stripTypeScriptTypes } from 'node:module';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

export interface ServeResult {
  status: number;
  headers?: Record<string, string>;
  body?: Readable | Buffer | string;
}

export class StaticServer {
  private readonly root: string;
  private readonly sharedRoot: string;
  private readonly tsCache = new Map<string, { mtimeMs: number; code: string }>();

  constructor(root: string, sharedRoot?: string) {
    this.root = root;
    this.sharedRoot = sharedRoot ?? join(root, '..', 'shared');
  }

  async serve(urlPath: string): Promise<ServeResult> {
    const baseRoot = urlPath.startsWith('/shared/')
      ? this.sharedRoot
      : this.root;
    const relativePath = urlPath.startsWith('/shared/')
      ? urlPath.replace('/shared/', '/')
      : urlPath;
    const resolved = this.resolve(baseRoot, relativePath);
    if (resolved === null) {
      return { status: 403, body: 'Forbidden' };
    }
    try {
      const info = await statFile(resolved);
      if (info.isDirectory()) {
        return this.serve('/index.html');
      }
      const ext = extname(resolved).toLowerCase();
      const contentType = MIME[ext] ?? 'application/octet-stream';
      if (ext === '.ts') {
        const code = await this.compileTs(resolved, info.mtimeMs);
        return {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
          },
          body: code,
        };
      }
      return {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(info.size),
          'Cache-Control': 'no-store',
        },
        body: createReadStream(resolved),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { status: 404, body: 'Not Found' };
      }
      return { status: 500, body: 'Internal Server Error' };
    }
  }

  private resolve(root: string, urlPath: string): string | null {
    const clean = decodeURIComponent(urlPath.split('?')[0] ?? '/');
    const normalized = normalize(clean).replace(/^(\.\.[/\\])+/u, '');
    const target = join(root, normalized);
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (target !== this.root && !target.startsWith(rootWithSep)) {
      return null;
    }
    return target;
  }

  private async compileTs(file: string, mtimeMs: number): Promise<string> {
    const cached = this.tsCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.code;
    }
    const source = await readFileText(file);
    const code = stripTypeScriptTypes(source, { mode: 'strip' });
    this.tsCache.set(file, { mtimeMs, code });
    return code;
  }
}

function statFile(path: string): Promise<import('node:fs').Stats> {
  return new Promise((resolve, reject) => {
    stat(path, (error, info) => (error ? reject(error) : resolve(info)));
  });
}

function readFileText(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    import('node:fs').then((fs) =>
      fs.readFile(path, 'utf8', (error, data) =>
        error ? reject(error) : resolve(data),
      ),
    );
  });
}
