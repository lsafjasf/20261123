import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const port = 44_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;

for (const file of await readdir(join(root, "src"))) {
  if (!file.endsWith(".ts")) {
    continue;
  }
  const source = await readFile(join(root, "src", file), "utf8");
  const javascript = stripTypeScriptTypes(source, { mode: "strip", sourceMap: false });
  assert.ok(javascript.length > 0, `${file} produced empty JavaScript`);
}

const server = spawn(process.execPath, ["--experimental-strip-types", "server.ts"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
  stdio: "ignore",
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      ready = response.ok;
      if (ready) {
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "local server did not become ready");

  const health = await fetch(`${baseUrl}/health`);
  assert.deepEqual(await health.json(), { ok: true, local: true });

  const index = await fetch(`${baseUrl}/`);
  assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await index.text();
  assert.match(html, /id="liveCanvas"/);
  assert.match(html, /id="replayButton"/);

  const app = await fetch(`${baseUrl}/src/app.ts`);
  assert.equal(app.headers.get("content-type"), "text/javascript; charset=utf-8");
  const appSource = await app.text();
  assert.match(appSource, /import \{ KeyframeRingBuffer/);
  assert.doesNotMatch(appSource, /interface ReplayRecord/);

  const csp = index.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /media-src 'self' blob:/);
  console.log(`Server check passed on ${baseUrl}`);
} finally {
  server.kill("SIGTERM");
}
