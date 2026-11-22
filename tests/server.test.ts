import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

const PORT = 5211;
const child = spawn(
  process.execPath,
  ["--experimental-strip-types", join(process.cwd(), "src", "server", "server.ts")],
  {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", () => undefined);
child.stderr.on("data", () => undefined);

before(async () => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const probe = await fetch(`http://localhost:${PORT}/public/styles.css`);
      if (probe.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error("测试服务器未在 5 秒内就绪");
});

after(() => {
  child.kill("SIGTERM");
});

async function get(path: string): Promise<{ status: number; type: string; body: string }> {
  const response = await fetch(`http://localhost:${PORT}${path}`);
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
}

test("服务器返回 HTML 与 CSS", async () => {
  const html = await get("/");
  assert.equal(html.status, 200);
  assert.ok(html.type.includes("text/html"));
  assert.ok(html.body.includes("节拍切点编辑器"));
  const css = await get("/public/styles.css");
  assert.equal(css.status, 200);
  assert.ok(css.type.includes("text/css"));
});

test(".ts 模块被即时擦除为可执行 JS", async () => {
  const js = await get("/src/core/timeline.ts");
  assert.equal(js.status, 200);
  assert.ok(js.type.includes("text/javascript"));
  assert.ok(!js.body.includes("interface "));
  assert.ok(js.body.includes("export function"));
});

test("目录穿越被拒绝", async () => {
  const blocked = await get("/..%2f..%2f..%2fetc%2fpasswd");
  assert.notEqual(blocked.status, 200);
  assert.ok(!blocked.body.includes("root:"));
});
