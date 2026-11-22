// 浏览器端 UI：WebAudio 解码/播放、Canvas 波形与衰减区可视化、WAV 导出。
// 处理核心与 Node 回归测试共用 src/dsp/debleed.ts，保证线上线下行为一致。

import { deBleed, type DeBleedResult } from "../dsp/debleed.js";
import { encodeWav } from "../dsp/wav.js";

interface TrackState {
  name: string;
  samples: Float32Array; // 原始录音（永不修改）
}

interface AppState {
  sampleRate: number;
  a: TrackState | null;
  b: TrackState | null;
  result: DeBleedResult | null;
  playing: { ctx: AudioContext; startedAt: number; offset: number; sources: AudioBufferSourceNode[] } | null;
  seekSec: number;
}

const state: AppState = {
  sampleRate: 44100,
  a: null,
  b: null,
  result: null,
  playing: null,
  seekSec: 0,
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = (msg: string) => { $("status").textContent = msg; };

async function decodeFile(file: File, ctx: AudioContext): Promise<Float32Array> {
  const buf = await file.arrayBuffer();
  const audio = await ctx.decodeAudioData(buf);
  return audio.getChannelData(0).slice();
}

async function onFilesChanged(): Promise<void> {
  const fileA = ($("fileA") as HTMLInputElement).files?.[0];
  const fileB = ($("fileB") as HTMLInputElement).files?.[0];
  state.a = null;
  state.b = null;
  state.result = null;
  refreshButtons();
  if (!fileA || !fileB) {
    status("请分别选择两支领夹麦的录音文件");
    return;
  }
  status("解码中…");
  try {
    const ctx = new AudioContext();
    state.sampleRate = ctx.sampleRate;
    const [sa, sb] = await Promise.all([decodeFile(fileA, ctx), decodeFile(fileB, ctx)]);
    await ctx.close();
    state.a = { name: fileA.name, samples: sa };
    state.b = { name: fileB.name, samples: sb };
    const dur = Math.max(sa.length, sb.length) / state.sampleRate;
    status(`已加载：${fileA.name} / ${fileB.name}，时长 ${dur.toFixed(1)}s @ ${state.sampleRate}Hz（原文件未改动）`);
  } catch (err) {
    status(`解码失败：${String(err)}`);
  }
  refreshButtons();
}

function runProcess(): void {
  if (!state.a || !state.b) return;
  stopPlayback();
  status("处理中…");
  // 让出一帧刷新状态，再跑同步 DSP（24s@44.1k 约几十毫秒）
  setTimeout(() => {
    const maxAttenuationDb = Number(($("maxAtten") as HTMLInputElement).value);
    const levelMatch = ($("levelMatch") as HTMLInputElement).checked;
    state.result = deBleed(state.a!.samples, state.b!.samples, {
      sampleRate: state.sampleRate,
      maxAttenuationDb,
      levelMatch,
    });
    state.seekSec = 0;
    const r = state.result;
    status(
      `完成：估计串音比 A→B ${r.bleedRatioAbDb.toFixed(1)}dB，B→A ${r.bleedRatioBaDb.toFixed(1)}dB；` +
      `电平匹配 A ${r.a.levelMatchGainDb.toFixed(1)}dB / B ${r.b.levelMatchGainDb.toFixed(1)}dB`,
    );
    renderAll();
    renderSegments();
    refreshButtons();
  }, 30);
}

function refreshButtons(): void {
  const ready = state.a !== null && state.b !== null;
  const done = state.result !== null;
  ($("processBtn") as HTMLButtonElement).disabled = !ready;
  ($("playBtn") as HTMLButtonElement).disabled = !done;
  ($("stopBtn") as HTMLButtonElement).disabled = state.playing === null;
  ($("exportA") as HTMLButtonElement).disabled = !done;
  ($("exportB") as HTMLButtonElement).disabled = !done;
}

// ---------- 可视化 ----------

// 静态层（波形+衰减区）离屏缓存：播放时每秒重绘数十次，只合成光标。
const staticLayer: (HTMLCanvasElement | null)[] = [null, null];

function durationSec(): number {
  if (!state.a || !state.b) return 0;
  return Math.max(state.a.samples.length, state.b.samples.length) / state.sampleRate;
}

function renderStaticLayer(trackIndex: 0 | 1): void {
  const track = trackIndex === 0 ? state.a : state.b;
  if (!track) return;
  const dpr = window.devicePixelRatio || 1;
  const visible = $(trackIndex === 0 ? "canvasA" : "canvasB") as HTMLCanvasElement;
  const cssW = visible.clientWidth || 800;
  const cssH = 130;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  const samples = track.samples;
  const dur = durationSec();
  const mid = cssH * 0.45;
  const amp = cssH * 0.38;

  // 波形（每像素 min/max）
  ctx.strokeStyle = "#5b8def";
  ctx.beginPath();
  for (let x = 0; x < cssW; x++) {
    const start = Math.floor((x / cssW) * samples.length);
    const end = Math.max(start + 1, Math.floor(((x + 1) / cssW) * samples.length));
    let lo = 0;
    let hi = 0;
    for (let i = start; i < end && i < samples.length; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    ctx.moveTo(x + 0.5, mid - hi * amp);
    ctx.lineTo(x + 0.5, mid - lo * amp + 1);
  }
  ctx.stroke();

  if (state.result) {
    const r = trackIndex === 0 ? state.result.a : state.result.b;
    const fps = state.result.controlFps;
    const maxDepth = Number(($("maxAtten") as HTMLInputElement).value);
    // 衰减区红色覆盖，透明度随深度
    for (let f = 0; f < r.gainDb.length; f++) {
      const g = r.gainDb[f];
      if (g < -0.5) {
        const x = (f / fps / dur) * cssW;
        const w = Math.max(1, cssW / fps / dur);
        ctx.fillStyle = `rgba(235, 87, 87, ${Math.min(0.55, (-g / maxDepth) * 0.55)})`;
        ctx.fillRect(x, 0, w, cssH);
      }
    }
    // 增益曲线（底部，0 到 -maxDepth dB）
    ctx.strokeStyle = "#eb5757";
    ctx.beginPath();
    for (let f = 0; f < r.gainDb.length; f++) {
      const x = (f / fps / dur) * cssW;
      const y = cssH - 4 + (r.gainDb[f] / maxDepth) * (cssH * 0.22);
      if (f === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  staticLayer[trackIndex] = canvas;
}

function composeTrack(canvasId: string, trackIndex: 0 | 1): void {
  const layer = staticLayer[trackIndex];
  if (!layer) return;
  const canvas = $(canvasId) as HTMLCanvasElement;
  canvas.width = layer.width;
  canvas.height = layer.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(layer, 0, 0);
  const dpr = window.devicePixelRatio || 1;
  const cssW = layer.width / dpr;
  const cssH = layer.height / dpr;
  const dur = durationSec();
  const cursorX = dur > 0 ? (state.seekSec / dur) * cssW : 0;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.strokeStyle = "#e8c468";
  ctx.beginPath();
  ctx.moveTo(cursorX, 0);
  ctx.lineTo(cursorX, cssH);
  ctx.stroke();
  ctx.restore();
}

function renderAll(): void {
  renderStaticLayer(0);
  renderStaticLayer(1);
  composeTrack("canvasA", 0);
  composeTrack("canvasB", 1);
  if (state.a) $("infoA").textContent = `${state.a.name} · ${(state.a.samples.length / state.sampleRate).toFixed(1)}s`;
  if (state.b) $("infoB").textContent = `${state.b.name} · ${(state.b.samples.length / state.sampleRate).toFixed(1)}s`;
}

function renderSegments(): void {
  if (!state.result) return;
  for (const [tableId, statId, segs] of [
    ["segA", "statA", state.result.a.segments],
    ["segB", "statB", state.result.b.segments],
  ] as const) {
    const table = $(tableId);
    table.innerHTML = "<tr><th>开始</th><th>结束</th><th>最大衰减</th></tr>";
    let total = 0;
    for (const seg of segs) {
      total += seg.endSec - seg.startSec;
      const tr = document.createElement("tr");
      const fmt = (s: number) => s.toFixed(2);
      tr.innerHTML =
        `<td class="t">${fmt(seg.startSec)}s</td><td class="t">${fmt(seg.endSec)}s</td>` +
        `<td>-${seg.maxDepthDb.toFixed(1)} dB</td>`;
      tr.addEventListener("click", () => seekTo(seg.startSec));
      table.appendChild(tr);
    }
    $(statId).textContent = `共 ${segs.length} 段 / ${total.toFixed(1)}s`;
  }
}

// ---------- 播放（旁路的轨用原始录音） ----------

function effectiveSamples(trackIndex: 0 | 1): Float32Array {
  const bypass = (trackIndex === 0
    ? ($("bypassA") as HTMLInputElement)
    : ($("bypassB") as HTMLInputElement)).checked;
  const orig = trackIndex === 0 ? state.a! : state.b!;
  if (bypass || !state.result) return orig.samples;
  return trackIndex === 0 ? state.result.a.samples : state.result.b.samples;
}

function startPlayback(): void {
  if (!state.result || state.playing) return;
  const ctx = new AudioContext({ sampleRate: state.sampleRate });
  const len = Math.max(
    effectiveSamples(0).length,
    effectiveSamples(1).length,
  );
  const sources: AudioBufferSourceNode[] = [];
  for (const trackIndex of [0, 1] as const) {
    const data = effectiveSamples(trackIndex);
    const buf = ctx.createBuffer(1, len, state.sampleRate);
    buf.getChannelData(0).set(data);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0, Math.min(state.seekSec, len / state.sampleRate));
    sources.push(src);
  }
  state.playing = { ctx, startedAt: ctx.currentTime, offset: state.seekSec, sources };
  $("playBtn").textContent = "播放中…";
  ($("playBtn") as HTMLButtonElement).disabled = true;
  ($("stopBtn") as HTMLButtonElement).disabled = false;
  tickPlayhead();
}

function stopPlayback(): void {
  if (!state.playing) return;
  for (const s of state.playing.sources) {
    try { s.stop(); } catch { /* 已停止 */ }
  }
  void state.playing.ctx.close();
  state.playing = null;
  $("playBtn").textContent = "播放";
  refreshButtons();
  $("playPos").textContent = "";
}

function tickPlayhead(): void {
  if (!state.playing) return;
  const pos = state.playing.offset + (state.playing.ctx.currentTime - state.playing.startedAt);
  const dur = durationSec();
  if (pos >= dur) {
    stopPlayback();
    state.seekSec = 0;
    renderAll();
    return;
  }
  state.seekSec = pos;
  $("playPos").textContent = `${pos.toFixed(1)} / ${dur.toFixed(1)}s`;
  composeTrack("canvasA", 0);
  composeTrack("canvasB", 1);
  requestAnimationFrame(tickPlayhead);
}

function seekTo(sec: number): void {
  const wasPlaying = state.playing !== null;
  if (wasPlaying) stopPlayback();
  state.seekSec = Math.max(0, Math.min(sec, durationSec()));
  renderAll();
  if (wasPlaying) startPlayback();
}

// ---------- 导出 ----------

function exportTrack(trackIndex: 0 | 1): void {
  if (!state.result) return;
  const data = effectiveSamples(trackIndex);
  const wav = encodeWav([data], state.sampleRate);
  const blob = new Blob([wav], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const orig = trackIndex === 0 ? state.a! : state.b!;
  const bypassed = (trackIndex === 0
    ? ($("bypassA") as HTMLInputElement)
    : ($("bypassB") as HTMLInputElement)).checked;
  const base = orig.name.replace(/\.[^.]+$/, "");
  a.href = url;
  a.download = `${base}${bypassed ? "_原始" : "_去串音"}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- 事件绑定 ----------

function bindEvents(): void {
  $("fileA").addEventListener("change", onFilesChanged);
  $("fileB").addEventListener("change", onFilesChanged);
  $("processBtn").addEventListener("click", runProcess);
  $("playBtn").addEventListener("click", startPlayback);
  $("stopBtn").addEventListener("click", () => { stopPlayback(); renderAll(); });
  $("exportA").addEventListener("click", () => exportTrack(0));
  $("exportB").addEventListener("click", () => exportTrack(1));
  $("maxAtten").addEventListener("input", () => {
    $("maxAttenVal").textContent = ($("maxAtten") as HTMLInputElement).value;
  });
  for (const id of ["bypassA", "bypassB"]) {
    $(id).addEventListener("change", () => {
      if (state.playing) { stopPlayback(); startPlayback(); }
    });
  }
  for (const [canvasId, trackIndex] of [["canvasA", 0], ["canvasB", 1]] as const) {
    $(canvasId).addEventListener("click", (ev) => {
      const canvas = ev.currentTarget as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      seekTo(((ev.clientX - rect.left) / rect.width) * durationSec());
    });
  }
  window.addEventListener("resize", renderAll);
}

bindEvents();
status("请分别选择两支领夹麦的录音文件");
