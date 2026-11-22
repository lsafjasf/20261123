// Interview de-reverb UI. All processing is local: WebAudio for decode and
// playback, Canvas for visualisation, WebCodecs + MediaSource for streaming
// export. No network calls.
import { decodeWav, encodeWav } from "../dsp/wav.ts";
import { segmentSpeech, type Segment } from "../dsp/segment.ts";
import { fft } from "../dsp/fft.ts";
import { muxOpusWebm, type OpusPacket } from "./webm.ts";
import type { ProcessRequest } from "./worker.ts";

interface State {
  input: Float32Array;
  output: Float32Array | null;
  residual: Float32Array | null;
  sampleRate: number;
  segments: (Segment & { strength: number; bypass: boolean })[];
  duration: number;
}

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const state: State = {
  input: new Float32Array(0),
  output: null,
  residual: null,
  sampleRate: 48000,
  segments: [],
  duration: 0,
};

let audioCtx: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let worker: Worker | null = null;

function ctx(): AudioContext {
  if (audioCtx === null) audioCtx = new AudioContext();
  return audioCtx;
}

function setStatus(msg: string): void {
  $("status").textContent = msg;
}

// ---------- file loading ----------

function setInput(samples: Float32Array, sampleRate: number, label: string): void {
  state.input = samples;
  state.sampleRate = sampleRate;
  state.duration = samples.length / sampleRate;
  state.output = null;
  state.residual = null;
  state.segments = segmentSpeech(samples, sampleRate).map((s) => ({
    ...s,
    strength: Number($<HTMLInputElement>("strength").value) / 100,
    bypass: false,
  }));
  $("controls").hidden = false;
  $("segPanel").hidden = false;
  $("views").hidden = false;
  renderSegments();
  drawWave();
  drawResidual();
  setStatus(`${label}:${state.duration.toFixed(1)}s @ ${sampleRate}Hz,` +
    ` 识别到 ${state.segments.length} 个语句段`);
}

async function loadFile(file: File): Promise<void> {
  setStatus("解码中…");
  const buf = await file.arrayBuffer();
  if (file.name.toLowerCase().endsWith(".wav")) {
    const w = decodeWav(buf); // our own decoder, no browser quirks
    setInput(w.samples, w.sampleRate, `已加载 ${file.name}`);
  } else {
    // WebAudio decode for compressed formats
    const ab = await ctx().decodeAudioData(buf);
    setInput(ab.getChannelData(0), ab.sampleRate, `已加载 ${file.name}`);
  }
}

// ---------- processing ----------

function runProcess(): void {
  if (state.input.length === 0) return;
  if (worker !== null) worker.terminate();
  worker = new Worker("./app/worker.js", { type: "module" });
  const prog = $<HTMLProgressElement>("prog");
  prog.hidden = false;
  prog.value = 0.2;
  setStatus("处理中…");
  const req: ProcessRequest = {
    samples: state.input.slice(),
    sampleRate: state.sampleRate,
    t60: Number($<HTMLInputElement>("t60").value) / 100,
    segments: state.segments.map((s) => ({
      startSec: s.startSec,
      endSec: s.endSec,
      strength: s.strength,
      bypass: s.bypass,
    })),
    defaultStrength: Number($<HTMLInputElement>("strength").value) / 100,
  };
  worker.onmessage = (ev: MessageEvent) => {
    const d = ev.data;
    state.output = d.output as Float32Array;
    state.residual = d.residual as Float32Array;
    prog.hidden = true;
    setStatus("处理完成。可切换 A/B 对比,或只听残余尾音确认词尾保留。");
    drawWave();
    drawResidual();
    prepareExport();
  };
  worker.onerror = (e: ErrorEvent) => {
    prog.hidden = true;
    setStatus(`处理失败:${e.message}`);
  };
  worker.postMessage(req, [req.samples.buffer]);
}

// ---------- playback (WebAudio) ----------

function play(samples: Float32Array, offsetSec = 0): void {
  stopPlayback();
  const ac = ctx();
  const buf = ac.createBuffer(1, samples.length, state.sampleRate);
  buf.copyToChannel(samples, 0);
  source = ac.createBufferSource();
  source.buffer = buf;
  source.connect(ac.destination);
  source.start(0, offsetSec);
}

function stopPlayback(): void {
  if (source !== null) {
    try { source.stop(); } catch { /* already stopped */ }
    source = null;
  }
}

function activeOutput(): Float32Array {
  const bypassed = $<HTMLInputElement>("bypass").checked;
  if (bypassed || state.output === null) return state.input;
  return state.output;
}

// ---------- visualisation (Canvas) ----------

function drawWave(): void {
  const canvas = $<HTMLCanvasElement>("wave");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr;
  const h = 120 * dpr;
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (g === null) return;
  g.fillStyle = "#10141a";
  g.fillRect(0, 0, w, h);
  const drawOne = (data: Float32Array, color: string): void => {
    g.strokeStyle = color;
    g.lineWidth = dpr;
    g.beginPath();
    const n = data.length;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor((x / w) * n);
      const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * n));
      let mn = 0;
      let mx = 0;
      for (let i = i0; i < i1; i++) {
        const v = data[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      g.moveTo(x, (0.5 - mx * 0.45) * h);
      g.lineTo(x, (0.5 - mn * 0.45) * h);
    }
    g.stroke();
  };
  drawOne(state.input, "rgba(150,160,175,0.8)");
  if (state.output !== null) drawOne(activeOutput(), "rgba(80,140,255,0.85)");
  // segment markers
  g.fillStyle = "rgba(255,255,255,0.06)";
  for (const s of state.segments) {
    const x0 = (s.startSec / state.duration) * w;
    const x1 = (s.endSec / state.duration) * w;
    g.fillRect(x0, 0, x1 - x0, h);
  }
}

function drawResidual(): void {
  const canvas = $<HTMLCanvasElement>("resid");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr;
  const h = 150 * dpr;
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (g === null) return;
  g.fillStyle = "#10141a";
  g.fillRect(0, 0, w, h);
  const res = state.residual;
  if (res === null) {
    g.fillStyle = "#5a6472";
    g.font = `${12 * dpr}px system-ui`;
    g.fillText("处理后显示残余尾音(输入 − 输出)", 12 * dpr, h / 2);
    return;
  }
  // residual waveform (top half)
  g.strokeStyle = "rgba(255,150,60,0.9)";
  g.lineWidth = dpr;
  g.beginPath();
  const n = res.length;
  const halfH = h * 0.45;
  for (let x = 0; x < w; x++) {
    const i0 = Math.floor((x / w) * n);
    const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * n));
    let mn = 0;
    let mx = 0;
    for (let i = i0; i < i1; i++) {
      const v = res[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    g.moveTo(x, halfH * 0.5 - mx * halfH * 0.45);
    g.lineTo(x, halfH * 0.5 - mn * halfH * 0.45);
  }
  g.stroke();
  // residual spectrogram (bottom half): simple STFT magnitude heat map
  drawSpectrogram(g, res, 0, halfH + 4 * dpr, w, h - halfH - 4 * dpr);
}

function drawSpectrogram(
  g: CanvasRenderingContext2D,
  data: Float32Array,
  x0: number,
  y0: number,
  w: number,
  h: number,
): void {
  const frame = 512;
  const hop = Math.max(1, Math.floor(data.length / w));
  const win = new Float32Array(frame);
  for (let i = 0; i < frame; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / frame));
  }
  const re = new Float64Array(frame);
  const im = new Float64Array(frame);
  const bins = frame / 2;
  for (let x = 0; x < w; x++) {
    const off = Math.floor(x * hop);
    re.fill(0);
    im.fill(0);
    const end = Math.min(frame, data.length - off);
    for (let i = 0; i < end; i++) re[i] = data[off + i] * win[i];
    fft(re, im, false);
    for (let y = 0; y < h; y++) {
      const k = Math.floor(((h - 1 - y) / h) * bins * 0.5); // show lower half
      const mag = Math.hypot(re[k], im[k]);
      const db = 20 * Math.log10(mag + 1e-6);
      const t = Math.min(1, Math.max(0, (db + 60) / 55));
      g.fillStyle = `rgb(${Math.floor(255 * t)},${Math.floor(120 * t)},${Math.floor(40 * t)})`;
      g.fillRect(x0 + x, y0 + y, 1, 1);
    }
  }
}


// ---------- per-sentence controls ----------

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

function renderSegments(): void {
  const box = $("segments");
  box.innerHTML = "";
  state.segments.forEach((seg, idx) => {
    const row = document.createElement("div");
    row.className = "seg" + (seg.bypass ? " bypassed" : "");
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = `${fmtTime(seg.startSec)} – ${fmtTime(seg.endSec)}`;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(Math.round(seg.strength * 100));
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = `${slider.value}%`;
    const byp = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = seg.bypass;
    byp.appendChild(cb);
    byp.appendChild(document.createTextNode("旁路"));
    slider.oninput = () => {
      seg.strength = Number(slider.value) / 100;
      val.textContent = `${slider.value}%`;
      scheduleReprocess();
    };
    cb.onchange = () => {
      seg.bypass = cb.checked;
      row.classList.toggle("bypassed", seg.bypass);
      scheduleReprocess();
    };
    row.append(time, slider, val, byp);
    box.appendChild(row);
    void idx;
  });
}

let reprocessTimer = 0;
function scheduleReprocess(): void {
  if (state.output === null) return; // only live-update after first run
  window.clearTimeout(reprocessTimer);
  reprocessTimer = window.setTimeout(runProcess, 350);
}

// ---------- export: WAV download + Opus/WebM via WebCodecs & MediaSource ----------

function prepareExport(): void {
  const out = activeOutput();
  const wav = encodeWav(out, state.sampleRate);
  const blob = new Blob([wav], { type: "audio/wav" });
  const a = $<HTMLAnchorElement>("dlWav");
  if (a.dataset.url) URL.revokeObjectURL(a.dataset.url);
  a.href = URL.createObjectURL(blob);
  a.dataset.url = a.href;
  $("exportPanel").hidden = false;
  $("mseBox").hidden = typeof AudioEncoder === "undefined";
}

async function streamOpus(): Promise<void> {
  const out = activeOutput();
  setStatus("Opus 编码中(WebCodecs)…");
  const packets: OpusPacket[] = [];
  let description: Uint8Array | null = null;
  const encoder = new AudioEncoder({
    output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ data, timestampMs: chunk.timestamp / 1000 });
      if (description === null && meta?.decoderConfig?.description) {
        const d = meta.decoderConfig.description;
        description = new Uint8Array(d as ArrayBuffer);
      }
    },
    error: (e: Error) => setStatus(`编码失败:${e.message}`),
  });
  encoder.configure({
    codec: "opus",
    sampleRate: state.sampleRate,
    numberOfChannels: 1,
    bitrate: 96000,
  });
  const frameSamples = 960; // 20 ms @ 48k
  for (let off = 0; off < out.length; off += frameSamples) {
    const n = Math.min(frameSamples, out.length - off);
    const buf = new Float32Array(n);
    buf.set(out.subarray(off, off + n));
    const data = new AudioData({
      format: "f32",
      sampleRate: state.sampleRate,
      numberOfFrames: n,
      numberOfChannels: 1,
      timestamp: (off / state.sampleRate) * 1e6,
      data: buf,
    });
    encoder.encode(data);
    data.close();
  }
  await encoder.flush();
  encoder.close();
  if (description === null) {
    // OpusHead fallback if the encoder did not supply one
    const head = new Uint8Array(19);
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1]);
    new DataView(head.buffer).setUint16(9, 312, true);
    new DataView(head.buffer).setUint32(11, state.sampleRate, true);
    description = head;
  }
  const webm = muxOpusWebm(packets, state.sampleRate, 1, description);
  const blob = new Blob([webm.buffer as ArrayBuffer], { type: "audio/webm" });
  // stream into <audio> through MediaSource
  const audio = $<HTMLAudioElement>("mseAudio");
  const ms = new MediaSource();
  audio.src = URL.createObjectURL(ms);
  audio.hidden = false;
  ms.addEventListener("sourceopen", () => {
    const sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
    sb.addEventListener("updateend", () => {
      if (!sb.updating) ms.endOfStream();
    });
    sb.appendBuffer(webm.buffer as ArrayBuffer);
  }, { once: true });
  const dl = $<HTMLAnchorElement>("dlWebm");
  dl.href = URL.createObjectURL(blob);
  dl.hidden = false;
  setStatus("Opus 流式播放就绪(MediaSource)。");
}

// ---------- wiring ----------

function wire(): void {
  const drop = $("drop");
  const file = $<HTMLInputElement>("file");
  drop.onclick = () => file.click();
  file.onchange = () => {
    if (file.files && file.files.length > 0) void loadFile(file.files[0]);
  };
  drop.ondragover = (e: DragEvent) => {
    e.preventDefault();
    drop.classList.add("hover");
  };
  drop.ondragleave = () => drop.classList.remove("hover");
  drop.ondrop = (e: DragEvent) => {
    e.preventDefault();
    drop.classList.remove("hover");
    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
      void loadFile(e.dataTransfer.files[0]);
    }
  };
  $("process").onclick = runProcess;
  $("loadDemo").onclick = async () => {
    const res = await fetch("../demo-interview.wav");
    const buf = await res.arrayBuffer();
    const w = decodeWav(buf);
    setInput(w.samples, w.sampleRate, "已载入示例");
  };
  $("t60").oninput = () => {
    $("t60val").textContent = `${(Number($<HTMLInputElement>("t60").value) / 100).toFixed(2)}s`;
  };
  $("strength").oninput = () => {
    const v = Number($<HTMLInputElement>("strength").value) / 100;
    for (const s of state.segments) s.strength = v;
    renderSegments();
    scheduleReprocess();
  };
  $("bypass").onchange = () => {
    drawWave();
    prepareExport();
  };
  $("playOrig").onclick = () => play(state.input);
  $("playProc").onclick = () => play(activeOutput());
  $("playResid").onclick = () => {
    if (state.residual !== null) play(state.residual);
  };
  $("stop").onclick = stopPlayback;
  $("streamOpus").onclick = () => void streamOpus();
  $("wave").onclick = (e: MouseEvent) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * state.duration;
    play(activeOutput(), t);
  };
}

wire();
