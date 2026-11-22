/**
 * FRAME/SAFE browser app. Fully offline; platform APIs only:
 * Canvas, WebCodecs, MediaSource, WebAudio.
 */
import { runPipeline } from "../src/core/pipeline.ts";
import type { Frame, Manifest, PipelineOptions } from "../src/core/types.ts";
import { buildZip } from "../src/core/zip.ts";
import type { ZipEntry } from "../src/core/zip.ts";
import { muxWebM } from "./webm.ts";
import type { MuxChunk } from "./webm.ts";

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const view = $("view") as HTMLCanvasElement;
const ctx = view.getContext("2d") as CanvasRenderingContext2D;
const status = (s: string): void => { $("status").textContent = s; };

interface AppState {
  input: Frame[];
  repaired: Frame[];
  manifest: Manifest | null;
  masks: Map<number, Uint8Array>;
  disabled: Set<number>;
  manual: Map<number, Frame>;
  cur: number;
  playing: boolean;
}
const state: AppState = {
  input: [], repaired: [], manifest: null, masks: new Map(),
  disabled: new Set(), manual: new Map(), cur: 0, playing: false,
};

function opts(): Partial<PipelineOptions> {
  return {
    fps: Number(($("fps") as HTMLInputElement).value) || 24,
    repairStrength: Number(($("strength") as HTMLInputElement).value),
    grainPreservation: Number(($("grain") as HTMLInputElement).value),
    disabledFrames: state.disabled,
  };
}

async function fileToFrame(file: File, index: number): Promise<Frame> {
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height);
  return { index, width: bmp.width, height: bmp.height, rgba: new Uint8ClampedArray(d.data.buffer.slice(0)) };
}

async function loadSequence(files: File[]): Promise<void> {
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  state.input = [];
  for (let i = 0; i < files.length; i++) {
    state.input.push(await fileToFrame(files[i], i));
    if (i % 10 === 0) status(`解码帧 ${i + 1}/${files.length}…`);
  }
  state.cur = 0;
  ($("scrub") as HTMLInputElement).max = String(state.input.length - 1);
  status(`已载入 ${state.input.length} 帧 ${state.input[0].width}x${state.input[0].height}`);
  runRestore();
}

async function loadVideo(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.src = url;
  await new Promise((res, rej) => {
    video.onloadedmetadata = res;
    video.onerror = () => rej(new Error("视频解码失败"));
  });
  const fps = Number(($("fps") as HTMLInputElement).value) || 24;
  const c = document.createElement("canvas");
  c.width = video.videoWidth; c.height = video.videoHeight;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  state.input = [];
  const count = Math.floor(video.duration * fps);
  for (let i = 0; i < count; i++) {
    await new Promise((res) => {
      video.onseeked = res;
      video.currentTime = i / fps;
    });
    g.drawImage(video, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    state.input.push({
      index: i, width: c.width, height: c.height,
      rgba: new Uint8ClampedArray(d.data.buffer.slice(0)),
    });
    if (i % 10 === 0) status(`抽帧 ${i + 1}/${count}…`);
  }
  URL.revokeObjectURL(url);
  state.cur = 0;
  ($("scrub") as HTMLInputElement).max = String(state.input.length - 1);
  status(`已抽取 ${state.input.length} 帧`);
  runRestore();
}

function runRestore(): void {
  if (!state.input.length) return;
  const name = ($("name") as HTMLInputElement).value || "REEL";
  status("时序分析中…");
  setTimeout(() => {
    const result = runPipeline(state.input, name, opts());
    state.repaired = result.frames;
    state.manifest = result.manifest;
    state.masks = result.masks;
    applyManual();
    status(`修复 ${result.manifest.summary.repairedMasks} 处 · ` +
      `锁定 ${result.manifest.lockedLines.length} 条竖线 · ` +
      `运动跳过 ${result.manifest.summary.skippedMotion} 处`);
    render();
    renderSide();
  }, 20);
}

function applyManual(): void {
  if (!state.manifest) return;
  state.manifest.manualFrames = [];
  for (const [idx, fr] of state.manual) {
    const slot = state.repaired.findIndex((f) => f.index === idx);
    if (slot < 0) continue;
    state.repaired[slot] = fr;
    state.manifest.frames[slot].manualEdit = true;
    state.manifest.manualFrames.push(idx);
  }
  state.manifest.summary.manualEdits = state.manifest.manualFrames.length;
}

function currentFrame(): Frame | null {
  if (!state.input.length) return null;
  const mode = ($("viewMode") as HTMLSelectElement).value;
  if (mode === "original" || !state.repaired.length) return state.input[state.cur];
  return state.repaired[state.cur];
}

function render(): void {
  const fr = currentFrame();
  if (!fr) return;
  if (view.width !== fr.width || view.height !== fr.height) {
    view.width = fr.width; view.height = fr.height;
  }
  const img = new ImageData(new Uint8ClampedArray(fr.rgba), fr.width, fr.height);
  ctx.putImageData(img, 0, 0);
  const mode = ($("viewMode") as HTMLSelectElement).value;
  if (mode === "mask" && state.manifest) {
    const mask = state.masks.get(fr.index);
    if (mask) {
      const overlay = ctx.createImageData(fr.width, fr.height);
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const p = i * 4;
        overlay.data[p] = 255; overlay.data[p + 3] = 110;
      }
      ctx.putImageData(overlay, 0, 0);
    }
  }
  const rep = state.manifest?.frames[state.cur];
  $("frameLabel").textContent =
    `F${String(fr.index).padStart(4, "0")} ${rep ? rep.timecode : ""} / ${state.input.length}`;
  ($("scrub") as HTMLInputElement).value = String(state.cur);
  ($("frameEnabled") as HTMLInputElement).checked = !state.disabled.has(fr.index);
  ($("frameManual") as HTMLInputElement).checked = state.manual.has(fr.index);
  renderSide();
}

function renderSide(): void {
  const rep = state.manifest?.frames[state.cur];
  const list = $("masklist");
  if (!rep) { list.textContent = "—"; return; }
  $("frameInfo").textContent = rep.disabled
    ? "本帧修复已关闭，原样输出。"
    : rep.manualEdit ? "本帧为人工修复帧。" : "";
  list.innerHTML = rep.masks.length ? "" : "<div>无候选缺陷</div>";
  for (const m of rep.masks) {
    const div = document.createElement("div");
    div.className = m.decision === "repaired" ? "repaired"
      : m.decision === "locked-content" ? "locked" : "motion";
    div.textContent =
      `${m.id} ${m.kind} [${m.bbox.x},${m.bbox.y} ${m.bbox.w}x${m.bbox.h}] ` +
      `conf=${m.confidence} persist=${m.temporal.persistence} → ${m.decision}`;
    list.appendChild(div);
  }
  const locked = $("lockedlist");
  locked.innerHTML = "";
  for (const l of state.manifest?.lockedLines ?? []) {
    const div = document.createElement("div");
    div.textContent = `x=${l.x} · ${l.frames.length} 帧 · ${l.reason}`;
    locked.appendChild(div);
  }
  if (!state.manifest?.lockedLines.length) locked.textContent = "无";
}

// --- playback, clocked by WebAudio ---
const audio = new AudioContext();
let playStart = 0;
let playBase = 0;

function playTick(): void {
  if (!state.playing) return;
  const fps = Number(($("fps") as HTMLInputElement).value) || 24;
  const elapsed = audio.currentTime - playStart;
  state.cur = (playBase + Math.floor(elapsed * fps)) % state.input.length;
  render();
  requestAnimationFrame(playTick);
}

$("play").addEventListener("click", () => {
  if (!state.input.length) return;
  if (state.playing) {
    state.playing = false;
    ($("play") as HTMLButtonElement).textContent = "▶ 播放";
    void audio.suspend();
    return;
  }
  state.playing = true;
  playBase = state.cur;
  void audio.resume().then(() => {
    playStart = audio.currentTime;
    ($("play") as HTMLButtonElement).textContent = "⏸ 暂停";
    requestAnimationFrame(playTick);
  });
});

function step(d: number): void {
  if (!state.input.length) return;
  state.cur = (state.cur + d + state.input.length) % state.input.length;
  render();
}
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
$("scrub").addEventListener("input", (e) => {
  state.cur = Number((e.target as HTMLInputElement).value);
  render();
});
$("viewMode").addEventListener("change", render);

$("frameEnabled").addEventListener("change", (e) => {
  const idx = state.input[state.cur]?.index;
  if (idx === undefined) return;
  if ((e.target as HTMLInputElement).checked) state.disabled.delete(idx);
  else state.disabled.add(idx);
  runRestore();
});

$("frameManual").addEventListener("change", (e) => {
  const idx = state.input[state.cur]?.index;
  if (idx === undefined) return;
  if (!(e.target as HTMLInputElement).checked) {
    state.manual.delete(idx);
    runRestore();
  }
});

$("manualImport").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  const idx = state.input[state.cur]?.index;
  if (!file || idx === undefined) return;
  const fr = await fileToFrame(file, idx);
  state.manual.set(idx, fr);
  applyManual();
  status(`F${idx} 已替换为人工修复帧`);
  render();
});

$("seqInput").addEventListener("change", async (e) => {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  if (files.length) await loadSequence(files);
});
$("videoInput").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) await loadVideo(file);
});
$("run").addEventListener("click", runRestore);

// --- exports ---
function download(data: Uint8Array | string, name: string, type: string): void {
  const blob = typeof data === "string" ? new Blob([data], { type }) : new Blob([data.buffer as ArrayBuffer], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function framePng(fr: Frame): Promise<Uint8Array> {
  const c = document.createElement("canvas");
  c.width = fr.width; c.height = fr.height;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.putImageData(new ImageData(new Uint8ClampedArray(fr.rgba), fr.width, fr.height), 0, 0);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
  return new Uint8Array(await (blob as Blob).arrayBuffer());
}

$("exportManifest").addEventListener("click", () => {
  if (!state.manifest) return;
  download(JSON.stringify(state.manifest, null, 2), "mask-manifest.json", "application/json");
});

$("exportZip").addEventListener("click", async () => {
  if (!state.manifest) return;
  const name = ($("name") as HTMLInputElement).value || "REEL";
  const pad = (v: number): string => String(v).padStart(4, "0");
  const entries: ZipEntry[] = [];
  status("打包 PNG 序列…");
  for (const fr of state.repaired) {
    entries.push({
      name: `sequence/${name}_repaired_F${pad(fr.index)}.png`,
      data: await framePng(fr),
    });
  }
  for (const [idx, mask] of state.masks) {
    const fr = state.repaired[0];
    const rgba = new Uint8ClampedArray(mask.length * 4);
    for (let i = 0; i < mask.length; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = mask[i] * 255;
      rgba[i * 4 + 3] = 255;
    }
    entries.push({
      name: `masks/F${pad(idx)}_mask.png`,
      data: await framePng({ index: idx, width: fr.width, height: fr.height, rgba }),
    });
  }
  for (const [idx, fr] of state.manual) {
    entries.push({ name: `manual-frames/F${pad(idx)}_manual.png`, data: await framePng(fr) });
  }
  entries.push({
    name: "mask-manifest.json",
    data: new TextEncoder().encode(JSON.stringify(state.manifest, null, 2)),
  });
  download(buildZip(entries), `${name}_delivery.zip`, "application/zip");
  status("交付包已导出");
});

$("exportWebm").addEventListener("click", async () => {
  if (!state.repaired.length) return;
  const fps = Number(($("fps") as HTMLInputElement).value) || 24;
  const { width, height } = state.repaired[0];
  const codecs: [string, string][] = [
    ["vp09.00.10.08", "V_VP9"],
    ["vp8", "V_VP8"],
  ];
  let encoder: VideoEncoder | null = null;
  let codecId = "";
  const chunks: MuxChunk[] = [];
  for (const [codec, ebml] of codecs) {
    const support = await VideoEncoder.isConfigSupported({ codec, width, height, framerate: fps });
    if (!support.supported) continue;
    codecId = ebml;
    encoder = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({
          data,
          timestampMs: (chunk.timestamp ?? 0) / 1000,
          keyframe: chunk.type === "key",
        });
      },
      error: (e) => status(`编码错误: ${e.message}`),
    });
    encoder.configure({ codec, width, height, framerate: fps, bitrate: 8_000_000 });
    break;
  }
  if (!encoder) { status("此浏览器不支持 VP8/VP9 编码"); return; }
  status("WebCodecs 编码中…");
  const c = document.createElement("canvas");
  c.width = width; c.height = height;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  for (let i = 0; i < state.repaired.length; i++) {
    const fr = state.repaired[i];
    g.putImageData(new ImageData(new Uint8ClampedArray(fr.rgba), width, height), 0, 0);
    const vf = new VideoFrame(c, { timestamp: (i * 1_000_000) / fps });
    encoder.encode(vf, { keyFrame: i % 96 === 0 });
    vf.close();
    if (i % 20 === 0) status(`编码 ${i + 1}/${state.repaired.length}…`);
  }
  await encoder.flush();
  encoder.close();
  const webm = muxWebM(chunks, {
    width, height, codecId,
    durationMs: (state.repaired.length * 1000) / fps,
  });
  download(webm, `${($("name") as HTMLInputElement).value || "REEL"}_repaired.webm`, "video/webm");
  // 通过 MediaSource 在页面内回放校验
  const preview = $("webmPreview") as HTMLVideoElement;
  const ms = new MediaSource();
  preview.src = URL.createObjectURL(ms);
  preview.hidden = false;
  ms.addEventListener("sourceopen", () => {
    const buf = ms.addSourceBuffer(`video/webm; codecs="${codecId === "V_VP9" ? "vp09.00.10.08" : "vp8"}"`);
    buf.addEventListener("updateend", () => {
      if (ms.readyState === "open") ms.endOfStream();
    });
    buf.appendBuffer(webm);
  });
  status("WebM 已导出，右侧可回放校验");
});
