// End-to-end smoke test: drives the real UI in headless Chrome via CDP
// (Node built-in WebSocket, zero dependencies). The page synthesizes a
// flat-field clip and a vignetted scene clip with canvas.captureStream +
// MediaRecorder, then runs the full estimate -> correct flow.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ||
  "/home/hj/.cache/puppeteer/chrome/linux-157.0.8103.50/chrome-linux64/chrome";
const PORT = 8901;
const URL = `http://localhost:${PORT}/`;

async function startServer() {
  const proc = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(URL);
      if (res.ok) return proc;
    } catch {
      // not up yet
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("server did not start");
}

function launchChrome() {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "vc-chrome-"));
    const proc = spawn(CHROME, [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank",
    ]);
    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve({ proc, wsUrl: m[1] });
    });
    proc.on("exit", () => reject(new Error("chrome exited early")));
    setTimeout(() => reject(new Error("chrome ws timeout")), 15000);
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    };
    ws.onopen = () => resolve({
      events,
      send: (method, params = {}, sessionId) => new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      }),
    });
    ws.onerror = reject;
  });
}

const PAGE_SCRIPT = `(async () => {
  const vig = (nx, ny) => {
    const dx = nx - 0.5, dy = ny - 0.5;
    const r2 = (dx * dx + dy * dy) / 0.5;
    return 1 / (1 + 1.6 * r2 * r2);
  };
  const waitFor = (fn, ms = 25000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return res();
      if (Date.now() - t0 > ms) return rej(new Error("waitFor timeout"));
      setTimeout(tick, 100);
    };
    tick();
  });
  async function makeVideoFile(name, draw, seconds = 2, w = 640, h = 360) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: "video/webm" });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start();
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => {
        const t = (performance.now() - t0) / 1000;
        if (t >= seconds) return res();
        draw(ctx, w, h, t);
        requestAnimationFrame(tick);
      };
      tick();
    });
    rec.stop();
    await new Promise((res) => { rec.onstop = res; });
    return new File([new Blob(chunks, { type: "video/webm" })], name, { type: "video/webm" });
  }
  const setFiles = (input, files) => {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const flatFile = await makeVideoFile("flat.webm", (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = 220 * vig(x / (w - 1), y / (h - 1));
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i+1] = img.data[i+2] = v; img.data[i+3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  });
  setFiles(document.getElementById("flatFile"), [flatFile]);
  await waitFor(() => document.getElementById("flatVideo").readyState >= 2);
  document.getElementById("autoFlat").click();
  await waitFor(() => document.getElementById("status").textContent.includes("增益图已估计"));

  const sceneFile = await makeVideoFile("scene.webm", (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const nx = x / (w - 1);
      const g = (60 + 140 * nx) * vig(nx, y / (h - 1));
      const i = (y * w + x) * 4;
      img.data[i] = g; img.data[i+1] = g * 0.9; img.data[i+2] = g * 0.8; img.data[i+3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  });
  setFiles(document.getElementById("workFiles"), [sceneFile]);
  await waitFor(() => document.getElementById("status").textContent.includes("已加载"));
  await waitFor(() => document.getElementById("ratioAfter").textContent !== "—");
  await new Promise((res) => setTimeout(res, 500));

  for (const key of ["1", "2", "3", "4"]) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true }));
    await new Promise((res) => setTimeout(res, 100));
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));

  return {
    status: document.getElementById("status").textContent,
    flatInfo: document.getElementById("flatInfo").textContent,
    ratioBefore: parseFloat(document.getElementById("ratioBefore").textContent),
    ratioAfter: parseFloat(document.getElementById("ratioAfter").textContent),
    exportEnabled: !document.getElementById("exportPng").disabled,
    errs: window.__errs || [],
  };
})()`;

const server = await startServer();
const { proc, wsUrl } = await launchChrome();
try {
  const cdp = await connect(wsUrl);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.__errs=[];window.addEventListener('error',e=>window.__errs.push(String(e.message)));",
  }, sessionId);
  await cdp.send("Page.navigate", { url: URL }, sessionId);
  await new Promise((res) => setTimeout(res, 1500));
  const result = await cdp.send("Runtime.evaluate", {
    expression: PAGE_SCRIPT, awaitPromise: true, returnByValue: true, timeout: 90000,
  }, sessionId);
  const v = result.result.value;
  if (result.exceptionDetails) {
    console.error("page exception:", JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails));
    throw new Error("page script failed");
  }
  console.log(JSON.stringify(v, null, 2));
  const exceptions = cdp.events.filter((e) => e.method === "Runtime.exceptionThrown");
  if (exceptions.length) {
    console.error("page exceptions:", JSON.stringify(exceptions[0].params, null, 2).slice(0, 800));
  }
  if (!v) throw new Error("no result from page");
  if (v.errs.length) throw new Error("page errors: " + v.errs.join("; "));
  if (!(v.ratioBefore < 0.8)) throw new Error(`expected vignette before, got ${v.ratioBefore}`);
  if (!(v.ratioAfter > 0.95)) throw new Error(`expected flat after, got ${v.ratioAfter}`);
  if (!v.exportEnabled) throw new Error("export button not enabled");
  console.log("SMOKE TEST PASSED");
} finally {
  proc.kill("SIGKILL");
  server.kill("SIGKILL");
}
