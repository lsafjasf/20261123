// UI wiring: flat-field capture, per-video correction parameters,
// switchable preview, corner sampling readout, PNG/video export.

import { FlatAccumulator, estimateGainMap } from "./flatfield.js";
import { serializeGainMap, deserializeGainMap } from "./gainmap.js";
import type { GainMap } from "./gainmap.js";
import { DEFAULT_OPTIONS } from "./correct.js";
import type { CorrectOptions } from "./correct.js";
import { renderGainMapImage } from "./correct.js";
import { Pipeline } from "./pipeline.js";
import type { PreviewMode } from "./pipeline.js";
import { grabRGBA, beep, StreamRecorder } from "./capture.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const statusEl = $("status");
const flatVideo = $("flatVideo") as HTMLVideoElement;
const workVideo = $("workVideo") as HTMLVideoElement;
const view = $("view") as HTMLCanvasElement;
const viewCtx = view.getContext("2d")!;
const mapPreview = $("mapPreview") as HTMLCanvasElement;
const monitor = $("monitor") as HTMLVideoElement;

const FLAT_W = 320;
const FLAT_H = 180;

let gainMap: GainMap | null = null;
let acc = new FlatAccumulator(FLAT_W, FLAT_H);
let mode: PreviewMode = "corrected";
const pipeline = new Pipeline();
const perVideo = new Map<string, CorrectOptions>();
let currentVideoKey = "";
const recorder = new StreamRecorder(monitor);

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

// --- correction parameters (per video) ----------------------------------

function readOptions(): CorrectOptions {
  return {
    strength: Number(($("strength") as HTMLInputElement).value) / 100,
    shoulder: Number(($("shoulder") as HTMLInputElement).value) / 100,
    knee: Number(($("knee") as HTMLInputElement).value) / 100,
    lumaLinked: ($("lumaLinked") as HTMLInputElement).checked,
  };
}

function writeOptions(o: CorrectOptions): void {
  ($("strength") as HTMLInputElement).value = String(Math.round(o.strength * 100));
  ($("shoulder") as HTMLInputElement).value = String(Math.round(o.shoulder * 100));
  ($("knee") as HTMLInputElement).value = String(Math.round(o.knee * 100));
  ($("lumaLinked") as HTMLInputElement).checked = o.lumaLinked;
  updateOutputs();
}

function updateOutputs(): void {
  const o = readOptions();
  $("strengthOut").textContent = `${Math.round(o.strength * 100)}%`;
  $("shoulderOut").textContent = `${Math.round(o.shoulder * 100)}%`;
  $("kneeOut").textContent = `${Math.round(o.knee * 100)}%`;
}

function currentOptions(): CorrectOptions {
  if (!currentVideoKey) return readOptions();
  const o = readOptions();
  perVideo.set(currentVideoKey, o);
  return o;
}

// --- rendering ------------------------------------------------------------

function renderView(): void {
  if (!pipeline.hasFrame) return;
  pipeline.render(viewCtx, mode, gainMap, currentOptions(), Number(($("splitPos") as HTMLInputElement).value) / 100);
  renderStats();
}

function renderStats(): void {
  const s = pipeline.stats(gainMap, currentOptions());
  if (!s) return;
  const tbody = document.querySelector("#sampleTable tbody")!;
  tbody.innerHTML = "";
  const names: Record<string, string> = { TL: "左上", TR: "右上", BL: "左下", BR: "右下", C: "中心" };
  s.before.regions.forEach((r, i) => {
    const a = s.after.regions[i];
    const delta = r.luma > 1e-6 ? ((a.luma - r.luma) / r.luma) * 100 : 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${names[r.name] ?? r.name}</td><td>${r.luma.toFixed(1)}</td>` +
      `<td>${a.luma.toFixed(1)}</td><td>${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%</td>`;
    tbody.appendChild(tr);
  });
  $("ratioBefore").textContent = s.before.cornerToCenter.toFixed(3);
  $("ratioAfter").textContent = s.after.cornerToCenter.toFixed(3);
  const d = (s.after.cornerToCenter - s.before.cornerToCenter) * 100;
  $("ratioDelta").textContent = `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
}

async function captureAndRender(): Promise<void> {
  if (workVideo.readyState < 2) return;
  if (await pipeline.capture(workVideo)) {
    if (view.width !== pipeline.width) {
      view.width = pipeline.width;
      view.height = pipeline.height;
    }
    renderView();
  }
}

function startLoop(): void {
  const cb = () => {
    if (!workVideo.paused && !workVideo.ended) captureAndRender();
    workVideo.requestVideoFrameCallback(cb);
  };
  workVideo.requestVideoFrameCallback(cb);
}

// --- flat-field section ---------------------------------------------------

function refreshFlatInfo(): void {
  $("flatInfo").textContent = gainMap
    ? `增益图 ${gainMap.cols}×${gainMap.rows} · 来自 ${gainMap.meta.frames} 帧 · ${gainMap.meta.name}`
    : `已采集 ${acc.frames} 帧平场素材`;
  ($("estimate") as HTMLButtonElement).disabled = acc.frames === 0;
}

async function grabFlatFrame(): Promise<boolean> {
  if (flatVideo.readyState < 2) return false;
  acc.addFrame(await grabRGBA(flatVideo, FLAT_W, FLAT_H));
  refreshFlatInfo();
  return true;
}

function doEstimate(): void {
  if (acc.frames === 0) return;
  gainMap = estimateGainMap(acc, {
    sourceName: flatVideo.dataset.name ?? "flat-field",
    sourceWidth: flatVideo.videoWidth,
    sourceHeight: flatVideo.videoHeight,
  });
  const ctx = mapPreview.getContext("2d")!;
  const img = renderGainMapImage(gainMap, mapPreview.width, mapPreview.height);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img), mapPreview.width, mapPreview.height), 0, 0);
  ($("exportMap") as HTMLButtonElement).disabled = false;
  refreshFlatInfo();
  setStatus(`增益图已估计（${acc.frames} 帧）· 角落/中心增益已归一化`);
  beep(880);
  renderView();
}

function download(name: string, blob: Blob): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// --- events ----------------------------------------------------------------

$("flatFile").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  flatVideo.src = URL.createObjectURL(f);
  flatVideo.dataset.name = f.name;
  acc = new FlatAccumulator(FLAT_W, FLAT_H);
  gainMap = null;
  ($("exportMap") as HTMLButtonElement).disabled = true;
  refreshFlatInfo();
});

$("grabFlat").addEventListener("click", async () => {
  if (await grabFlatFrame()) setStatus(`已采集 ${acc.frames} 帧`);
});

$("autoFlat").addEventListener("click", async () => {
  if (flatVideo.readyState < 2) return;
  setStatus("自动采样平场帧…");
  flatVideo.currentTime = 0;
  await flatVideo.play();
  const timer = setInterval(async () => {
    await grabFlatFrame();
    if (flatVideo.ended || acc.frames >= 40) {
      clearInterval(timer);
      flatVideo.pause();
      doEstimate();
    }
  }, 150);
});

$("estimate").addEventListener("click", doEstimate);

$("exportMap").addEventListener("click", () => {
  if (gainMap) download("gain-map.json", new Blob([serializeGainMap(gainMap)], { type: "application/json" }));
});

$("importMapBtn").addEventListener("click", () => $("importMap").click());
$("importMap").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    gainMap = deserializeGainMap(await f.text());
    ($("exportMap") as HTMLButtonElement).disabled = false;
    setStatus(`已导入映射 ${gainMap.meta.name}（${gainMap.cols}×${gainMap.rows}）`);
    beep(660);
    renderView();
  } catch (err) {
    setStatus(`映射导入失败：${(err as Error).message}`);
  }
});

// --- working videos -------------------------------------------------------

const workList = $("workList") as HTMLSelectElement;

$("workFiles").addEventListener("change", (e) => {
  const files = Array.from((e.target as HTMLInputElement).files ?? []);
  workList.innerHTML = "";
  for (const f of files) {
    const opt = document.createElement("option");
    opt.value = URL.createObjectURL(f);
    opt.textContent = f.name;
    opt.dataset.key = f.name;
    workList.appendChild(opt);
  }
  if (files.length > 0) {
    workList.selectedIndex = 0;
    loadWorkVideo();
  }
});

workList.addEventListener("change", loadWorkVideo);

function loadWorkVideo(): void {
  const opt = workList.selectedOptions[0];
  if (!opt) return;
  currentVideoKey = opt.dataset.key ?? opt.textContent ?? "";
  writeOptions(perVideo.get(currentVideoKey) ?? { ...DEFAULT_OPTIONS });
  workVideo.src = opt.value;
  workVideo.load();
  ($("exportPng") as HTMLButtonElement).disabled = false;
  ($("recordToggle") as HTMLButtonElement).disabled = false;
  setStatus(`已加载 ${currentVideoKey} · 空格播放/暂停`);
}

workVideo.addEventListener("loadeddata", () => captureAndRender());
workVideo.addEventListener("seeked", () => captureAndRender());

// --- preview modes ----------------------------------------------------------

const MODE_KEYS: PreviewMode[] = ["original", "corrected", "split", "gainmap"];

function setMode(m: PreviewMode): void {
  mode = m;
  document.querySelectorAll(".modes button").forEach((b) => {
    b.classList.toggle("on", (b as HTMLButtonElement).dataset.mode === m);
  });
  $("splitRow").hidden = m !== "split";
  renderView();
}

document.querySelectorAll(".modes button").forEach((b) => {
  b.addEventListener("click", () => setMode((b as HTMLButtonElement).dataset.mode as PreviewMode));
});

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const idx = ["1", "2", "3", "4"].indexOf(e.key);
  if (idx >= 0) setMode(MODE_KEYS[idx]);
  if (e.key === " " && workVideo.src) {
    e.preventDefault();
    if (workVideo.paused) workVideo.play().catch(() => {});
    else workVideo.pause();
  }
});

for (const id of ["strength", "shoulder", "knee", "lumaLinked", "splitPos"]) {
  $(id).addEventListener("input", () => {
    updateOutputs();
    renderView();
  });
}

// --- export -----------------------------------------------------------------

$("exportPng").addEventListener("click", async () => {
  if (!gainMap || !workVideo.src) return;
  setStatus("渲染全分辨率校正帧…");
  const { data, width, height } = await pipeline.exportCorrected(workVideo, gainMap, currentOptions());
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  c.toBlob((blob) => {
    if (blob) {
      download(`${currentVideoKey || "frame"}-corrected.png`, blob);
      setStatus(`已导出 ${width}×${height} PNG`);
      beep(990);
    }
  }, "image/png");
});

$("recordToggle").addEventListener("click", async () => {
  const btn = $("recordToggle") as HTMLButtonElement;
  const link = $("download") as HTMLAnchorElement;
  if (!recorder.active) {
    if (!recorder.start(view)) {
      setStatus("当前浏览器不支持 MediaRecorder");
      return;
    }
    btn.textContent = "停止录制";
    if (workVideo.paused) workVideo.play().catch(() => {});
    setStatus("录制中 · 监视窗通过 MediaSource 实时回放");
  } else {
    const blob = await recorder.stop();
    btn.textContent = "录制校正视频";
    link.href = URL.createObjectURL(blob);
    link.download = `${currentVideoKey || "video"}-corrected.webm`;
    link.textContent = `下载校正视频（${(blob.size / 1048576).toFixed(1)} MB）`;
    link.hidden = false;
    setStatus("录制完成");
    beep(990);
  }
});

// --- init ---------------------------------------------------------------------

writeOptions({ ...DEFAULT_OPTIONS });
refreshFlatInfo();
setMode("corrected");
startLoop();
