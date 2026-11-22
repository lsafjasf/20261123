import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chromePath =
  process.env.CHROME_PATH ||
  "/home/hj/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell";
const port = 9333;
const viewport = {
  width: Number(process.env.VIEWPORT_WIDTH || 1440),
  height: Number(process.env.VIEWPORT_HEIGHT || 1000),
};
const profile = join(tmpdir(), `breath-gate-smoke-${process.pid}`);
const outputDir = new URL("../artifacts/", import.meta.url);
await mkdir(outputDir, { recursive: true });
await rm(profile, { recursive: true, force: true });

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(path, options) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

let ws;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result?.value;
}

async function waitFor(expression, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${expression}`);
}

async function screenshot(name) {
  const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(new URL(name, outputDir), Buffer.from(result.data, "base64"));
}

try {
  let version;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      version = await getJson("/json/version");
      break;
    } catch {
      await delay(150);
    }
  }
  if (!version) throw new Error("Chrome DevTools did not start");
  const tab = await getJson("/json/new?http://127.0.0.1:4173", { method: "PUT" });
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (message) => {
    const payload = JSON.parse(message.data);
    if (payload.id && pending.has(payload.id)) {
      const request = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) request.reject(new Error(payload.error.message));
      else request.resolve(payload.result);
    }
    if (payload.method === "Runtime.exceptionThrown") {
      consoleErrors.push(payload.params.exceptionDetails.text);
    }
    if (payload.method === "Runtime.consoleAPICalled" && payload.params.type === "error") {
      consoleErrors.push(payload.params.args.map((item) => item.value || item.description).join(" "));
    }
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: "http://127.0.0.1:4173" });
  await waitFor("document.readyState === 'complete'", 10000);
  await waitFor(
    "document.querySelector('#analysis-state')?.textContent.includes('事件') || document.querySelector('#analysis-state')?.textContent.includes('失败')",
    30000,
  );
  await delay(1000);
  await screenshot("smoke-editor.png");
  const summary = await evaluate(`({
    state: document.querySelector('#analysis-state')?.textContent,
    events: document.querySelectorAll('#event-body tr[data-id]').length,
    source: document.querySelector('#source-name')?.textContent,
    counts: [
      document.querySelector('#count-clean')?.textContent,
      document.querySelector('#count-emotional')?.textContent,
      document.querySelector('#count-impulse')?.textContent
    ],
    scope: document.querySelector('#edit-summary')?.textContent,
    canvas: document.querySelector('#waveform')?.width + 'x' + document.querySelector('#waveform')?.height
  })`);
  console.log("Editor:", JSON.stringify(summary, null, 2));

  await evaluate(`(() => {
    document.querySelector('#event-body tr[data-id]').click();
    document.querySelector('.action-grid button[data-action="fade"]').click();
  })()`);
  await delay(250);
  const fadeAction = await evaluate(
    "document.querySelector('#event-body tr.selected .action-tag')?.textContent",
  );
  await evaluate("document.querySelector('#bulk-restore').click()");
  await delay(250);
  const restoredAction = await evaluate(
    "document.querySelector('#event-body tr.selected .action-tag')?.textContent",
  );
  console.log("Interaction:", { fadeAction, restoredAction });
  if (fadeAction !== "淡出" || restoredAction !== "缩短") process.exitCode = 1;

  await evaluate("document.querySelector('#export-button').click()");
  await waitFor("document.querySelector('#export-dialog')?.open", 5000);
  await evaluate("document.querySelector('#run-export').click()");
  await waitFor("!document.querySelector('#verify-panel')?.classList.contains('hidden')", 30000);
  await delay(500);
  const verification = await evaluate(`({
    verdict: document.querySelector('#verify-verdict')?.textContent,
    rows: [...document.querySelectorAll('.verify-row')].map((row) => ({
      id: row.id,
      pass: row.classList.contains('pass'),
      text: row.querySelector('em')?.textContent
    })),
    audio: document.querySelector('#download-audio')?.download,
    manifest: document.querySelector('#download-manifest')?.download
  })`);
  console.log("Verification:", JSON.stringify(verification, null, 2));
  await screenshot("smoke-export.png");
  if (consoleErrors.length) {
    console.error("Console errors:", consoleErrors);
    process.exitCode = 1;
  }
  if (summary.events < 4 || verification.verdict !== "全部通过") process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill("SIGTERM");
  await delay(300);
  await rm(profile, { recursive: true, force: true });
}
