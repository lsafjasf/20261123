import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'src', 'server', 'server.ts');
const port = 8931;
let child: ChildProcess;
let base: string;

before(async () => {
  child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server boot timeout')), 5000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('http://')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
});

after(() => {
  child.kill('SIGTERM');
});

test('serves index.html', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const body = await res.text();
  assert.match(body, /stage-canvas/);
});

test('strips client TypeScript into browser JavaScript', async () => {
  const res = await fetch(base + '/main.ts');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /javascript/);
  const body = await res.text();
  assert.doesNotMatch(body, /: LayoutEngine/);
  assert.doesNotMatch(body, /interface /);
  assert.match(body, /import /);
  assert.match(body, /sourceMappingURL=data:application\/json/);
});

test('serves shared modules under /shared', async () => {
  const res = await fetch(base + '/shared/layout.ts');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /class LayoutEngine/);
  assert.doesNotMatch(body, /private /);
});

test('serves css with correct mime type', async () => {
  const res = await fetch(base + '/styles.css');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/css/);
});

test('returns 404 and blocks traversal', async () => {
  const missing = await fetch(base + '/nope.txt');
  assert.equal(missing.status, 404);
  const traversal = await fetch(base + '/../../etc/passwd');
  assert.notEqual(traversal.status, 200);
});
