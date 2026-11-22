import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:4173";
const debugUrl = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const screenshotDir = join(process.cwd(), "artifacts");
await mkdir(screenshotDir, { recursive: true });

const targets = await fetch(`${debugUrl}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === "page");
if (!target) throw new Error("No Chrome page target found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let sequence = 0;
const pending = new Map();
const errors = [];
const consoleMessages = [];
rpc("Runtime.enable");
rpc("Page.enable");
rpc("Log.enable");
rpc("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

function rpc(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    errors.push(message.params.exceptionDetails.text);
  }
  if (message.method === "Runtime.consoleAPICalled") {
    consoleMessages.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
  }
});

async function evaluate(expression) {
  const result = await rpc("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(expression, timeout = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const status = await evaluate(`({
    progress: document.querySelector("#progressLabel")?.textContent,
    detail: document.querySelector("#progressDetail")?.textContent,
    toast: document.querySelector("#toast")?.textContent,
    hint: document.querySelector("#setupHint")?.textContent
  })`);
  throw new Error(`Timed out waiting for ${expression}: ${JSON.stringify(status)}`);
}

async function screenshot(name) {
  const result = await rpc("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(screenshotDir, name), Buffer.from(result.data, "base64"));
}

await rpc("Page.navigate", { url: baseUrl });
await waitFor(`!document.querySelector("#dashboard").hidden && document.querySelector("#statTotal")?.textContent === "7"`, 120_000);
await screenshot("relink-dashboard.png");
const summary = await evaluate(`({
  stats: {
    total: document.querySelector("#statTotal")?.textContent,
    matched: document.querySelector("#statMatched")?.textContent,
    review: document.querySelector("#statReview")?.textContent,
    missing: document.querySelector("#statMissing")?.textContent
  },
  rows: [...document.querySelectorAll(".match-row")].slice(0, 8).map((row) => ({
    status: row.querySelector(".status-badge")?.textContent,
    file: row.querySelector(".file-main strong")?.textContent,
    candidate: row.querySelector(".candidate-cell strong")?.textContent,
    score: row.querySelector(".score-cell b")?.textContent
  }))
})`);

await evaluate(`document.querySelector('.filter-tab[data-filter="all"]').click()`);
await evaluate(`[...document.querySelectorAll(".match-row")].find((row) => row.querySelector(".file-main strong")?.textContent === "BROLL_0001.MP4")?.click()`);
await new Promise((resolve) => setTimeout(resolve, 300));
await evaluate(`document.querySelector(".candidate-card [data-preview]")?.click()`);
await new Promise((resolve) => setTimeout(resolve, 2500));
const preview = await evaluate(`(() => {
  const video = document.querySelector(".candidate-preview");
  return video ? { transport: video.dataset.previewTransport, readyState: video.readyState, duration: video.duration } : null;
})()`);
await screenshot("relink-preview.png");
await evaluate(`[...document.querySelectorAll(".match-row")].find((row) => row.querySelector(".file-main strong")?.textContent === "IMG_4825.MOV")?.click()`);
await new Promise((resolve) => setTimeout(resolve, 500));
await screenshot("relink-inspector.png");

const beforeConfirm = await evaluate(`({
  review: document.querySelector("#statReview")?.textContent,
  inspector: document.querySelector("#inspectorContent h3")?.textContent,
  confirmButton: document.querySelector("[data-confirm]")?.textContent
})`);

await evaluate(`document.querySelector("[data-confirm]")?.click()`);
await new Promise((resolve) => setTimeout(resolve, 400));
const afterConfirm = await evaluate(`({ review: document.querySelector("#statReview")?.textContent, matched: document.querySelector("#statMatched")?.textContent })`);

await evaluate(`document.querySelector("#exportButton").click()`);
await new Promise((resolve) => setTimeout(resolve, 250));
await evaluate(`document.querySelector("#confirmExportButton").click()`);
await waitFor(`!document.querySelector("#exportResult").hidden`);
await screenshot("relink-export.png");
const exportLinks = await evaluate(`[...document.querySelectorAll("#exportResult a")].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute("href") }))`);

console.log(JSON.stringify({ summary, preview, beforeConfirm, afterConfirm, exportLinks, errors, consoleMessages: consoleMessages.slice(-10) }, null, 2));
socket.close();
