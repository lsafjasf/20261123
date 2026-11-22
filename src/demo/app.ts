import type {
  ConcealmentInterval,
  GapClassification,
  RepairReport
} from "../core/types.ts";
import type { RenderedAudio } from "../core/render.ts";
import type { EncodedAudioFrame } from "../media/webm.ts";
import { repairPackets } from "../core/repair.ts";
import { encodeWavPcm16, renderReport } from "../core/render.ts";
import { muxOpusWebM } from "../media/webm.ts";
import { createDemoStream, type DemoScenario } from "./scenario.ts";

type ElementWithValue = HTMLInputElement | HTMLSelectElement;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
};

const classificationLabel: Record<GapClassification, string> = {
  "true-pause": "真实停顿",
  "speech-loss": "语音丢失",
  "music-boundary": "音乐边界",
  "onset-boundary": "声音起点",
  "offset-boundary": "声音终点",
  "rate-boundary": "采样率边界",
  unrepairable: "无法补齐"
};

const methodLabel: Record<string, string> = {
  silence: "精确静音",
  "pitch-continuation": "基频双向延续",
  "equal-power-crossfade": "等功率交叉淡化",
  "edge-fade": "双端短过渡",
  none: "不补齐"
};

const scenarioSelect = byId<HTMLSelectElement>("scenario");
const statusLine = byId<HTMLParagraphElement>("status");
const waveform = byId<HTMLCanvasElement>("waveform");
const intervalRows = byId<HTMLTableSectionElement>("intervalRows");
const intervalDetail = byId<HTMLPreElement>("intervalDetail");
const stateGrid = byId<HTMLDivElement>("stateGrid");
const eventList = byId<HTMLOListElement>("eventList");
const mediaStatus = byId<HTMLSpanElement>("mediaStatus");
const preview = byId<HTMLVideoElement>("preview");

let scenario: DemoScenario = "mixed";
let demo = createDemoStream(scenario);
let report: RepairReport = repairPackets(demo.packets);
let repaired: RenderedAudio = renderReport(report, 48000, false);
let dropped: RenderedAudio = renderReport(report, 48000, true);
let selectedInterval = report.intervals.length > 0 ? 0 : -1;
let audioContext: AudioContext | null = null;
let activeSource: AudioBufferSourceNode | null = null;
let playheadSec = -1;
let animationFrame = 0;
let mediaObjectUrl: string | null = null;

function intervalClass(classification: GapClassification): string {
  if (classification === "true-pause" || classification === "unrepairable") return "pause";
  if (classification === "rate-boundary") return "rate";
  return "speech";
}

function formatMs(seconds: number): string {
  return (seconds * 1000).toFixed(1);
}

function totalConcealedMs(source: RepairReport): number {
  return source.intervals.reduce(
    (sum, interval) => sum + interval.frames / interval.sampleRate * 1000,
    0
  );
}

function totalMutedMs(source: RepairReport): number {
  return source.intervals.reduce(
    (sum, interval) => sum + interval.transitions.mutedFrames / interval.sampleRate * 1000,
    0
  );
}

function updateMetrics(): void {
  byId("metricGaps").textContent = String(report.stats.gaps);
  byId("metricMissing").textContent = `${report.stats.missingPackets} 个丢失包`;
  byId("metricMs").textContent = totalConcealedMs(report).toFixed(0);
  byId("metricMuted").textContent = totalMutedMs(report).toFixed(0);
  byId("metricRates").textContent = String(report.stats.rateTransitions);
  byId("metricCorrupt").textContent = `${report.stats.corruptChannels} 个损坏声道`;
  byId("intervalCount").textContent = String(report.intervals.length);
}

function selectInterval(index: number): void {
  selectedInterval = index;
  for (const row of intervalRows.querySelectorAll("tr")) {
    row.classList.toggle("selected", Number(row.getAttribute("data-index")) === index);
  }
  const interval = report.intervals[index];
  intervalDetail.textContent = interval
    ? JSON.stringify(interval, null, 2)
    : "本场景没有需要补齐的区间。";
  drawWaveform();
}

function renderIntervals(): void {
  intervalRows.replaceChildren();
  report.intervals.forEach((interval, index) => {
    const row = document.createElement("tr");
    row.dataset.index = String(index);
    row.innerHTML = `
      <td>${interval.startSequence}–${interval.endSequence}</td>
      <td><span class="tag ${intervalClass(interval.classification)}">${classificationLabel[interval.classification]}</span></td>
      <td>${methodLabel[interval.method] || interval.method}</td>
      <td>${interval.frames.toLocaleString()}</td>
      <td>${(interval.frames / interval.sampleRate * 1000).toFixed(1)} ms</td>
      <td>${interval.transitions.mutedFrames > 0 ? "已封顶" : "完整"}</td>
    `;
    row.addEventListener("click", () => selectInterval(index));
    intervalRows.append(row);
  });
  if (report.intervals.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="6">本次接收未检测到缺口。</td>`;
    intervalRows.append(row);
  }
  selectInterval(selectedInterval);
}

function renderState(): void {
  const state = report.state;
  const items: Array<[string, string]> = [
    ["状态", state.status],
    ["修订号", String(state.revision)],
    ["已接收包", String(state.packetsAccepted)],
    ["已拒绝包", String(state.packetsRejected)],
    ["补齐区间", String(state.gapsRepaired)],
    ["补齐帧", state.framesConcealed.toLocaleString()],
    ["静音帧", state.framesMuted.toLocaleString()],
    ["损坏声道", String(state.corruptChannelsRepaired)],
    ["采样率切换", String(state.rateTransitions)],
    ["末包序号", String(state.lastSequence)],
    ["末包采样率", state.lastSampleRate ? `${state.lastSampleRate} Hz` : "—"],
    ["最后分类", state.lastClassification || "—"]
  ];
  stateGrid.replaceChildren();
  for (const [label, value] of items) {
    const item = document.createElement("div");
    item.className = "state-item";
    const name = document.createElement("span");
    name.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value;
    item.append(name, content);
    stateGrid.append(item);
  }
}

function renderEvents(): void {
  eventList.replaceChildren();
  for (const event of report.events.slice(-24).reverse()) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = `${event.atSec.toFixed(3)}s`;
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = `[${event.kind}]`;
    item.append(time, kind, document.createTextNode(event.message));
    eventList.append(item);
  }
}

function analyze(): void {
  stopPlayback();
  const started = performance.now();
  demo = createDemoStream(scenario);
  report = repairPackets(demo.packets);
  repaired = renderReport(report, 48000, false);
  dropped = renderReport(report, 48000, true);
  selectedInterval = report.intervals.length > 0 ? 0 : -1;
  updateMetrics();
  renderIntervals();
  renderState();
  renderEvents();
  drawWaveform();
  mediaStatus.textContent = "尚未编码";
  preview.removeAttribute("src");
  const elapsed = performance.now() - started;
  statusLine.textContent =
    `${demo.scenario} · ${demo.packets.length} 个接收包 / ${demo.droppedPackets} 个丢包 / ` +
    `${demo.corruptedPackets} 个损坏包 · 分析耗时 ${elapsed.toFixed(1)} ms`;
}

function monoEnvelope(audio: RenderedAudio): Float32Array {
  const envelope = new Float32Array(audio.channels[0].length);
  for (const channel of audio.channels) {
    for (let index = 0; index < envelope.length; index += 1) {
      envelope[index] += Math.abs(channel[index]) / audio.channels.length;
    }
  }
  return envelope;
}

function drawLane(
  context: CanvasRenderingContext2D,
  envelope: Float32Array,
  left: number,
  top: number,
  width: number,
  height: number,
  color: string
): void {
  const middle = top + height / 2;
  const pixels = Math.max(1, Math.floor(width));
  const framesPerPixel = envelope.length / pixels;
  context.strokeStyle = color;
  context.lineWidth = 1.4;
  context.beginPath();
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const start = Math.floor(pixel * framesPerPixel);
    const end = Math.min(envelope.length, Math.floor((pixel + 1) * framesPerPixel));
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      peak = Math.max(peak, envelope[index]);
    }
    const amplitude = Math.min(height / 2 - 3, peak * height * 2.6);
    const x = left + pixel;
    context.moveTo(x, middle - amplitude);
    context.lineTo(x, middle + amplitude + 1);
  }
  context.stroke();
  context.strokeStyle = "rgba(139, 154, 171, 0.16)";
  context.beginPath();
  context.moveTo(left, middle);
  context.lineTo(left + width, middle);
  context.stroke();
}

function drawWaveform(): void {
  const rect = waveform.getBoundingClientRect();
  if (rect.width < 1) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(rect.width * dpr);
  const pixelHeight = Math.round(rect.height * dpr);
  if (waveform.width !== pixelWidth) waveform.width = pixelWidth;
  if (waveform.height !== pixelHeight) waveform.height = pixelHeight;
  const context = waveform.getContext("2d");
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = rect.width;
  const height = rect.height;
  const left = 92;
  const plotWidth = width - left - 14;
  const laneHeight = (height - 34) / 2;
  const duration = Math.max(0.001, repaired.durationSec);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#070b10";
  context.fillRect(0, 0, width, height);

  for (let tick = 0; tick <= duration; tick += 0.5) {
    const x = left + tick / duration * plotWidth;
    context.strokeStyle = "rgba(110, 168, 255, 0.08)";
    context.beginPath();
    context.moveTo(x, 8);
    context.lineTo(x, height - 22);
    context.stroke();
    context.fillStyle = "#66798d";
    context.font = "10px Consolas, monospace";
    context.fillText(`${tick.toFixed(1)}s`, x + 3, height - 7);
  }

  report.intervals.forEach((interval, index) => {
    const start = interval.startTimeSec / duration;
    const end = interval.endTimeSec / duration;
    const fill = interval.classification === "true-pause"
      ? "rgba(101, 118, 138, 0.16)"
      : interval.classification === "music-boundary"
        ? "rgba(255, 189, 92, 0.16)"
        : "rgba(72, 215, 193, 0.14)";
    context.fillStyle = fill;
    context.fillRect(left + start * plotWidth, 8, Math.max(2, (end - start) * plotWidth), height - 30);
    if (index === selectedInterval) {
      context.strokeStyle = interval.classification === "music-boundary" ? "#ffbd5c" : "#48d7c1";
      context.lineWidth = 1.5;
      context.strokeRect(
        left + start * plotWidth,
        8,
        Math.max(2, (end - start) * plotWidth),
        height - 30
      );
    }
  });

  context.font = "11px 'Segoe UI', sans-serif";
  context.fillStyle = "#8b9aab";
  context.fillText("接收流", 14, 28);
  context.fillText("修复流", 14, laneHeight + 30);
  drawLane(context, monoEnvelope(dropped), left, 10, plotWidth, laneHeight, "#556b80");
  drawLane(context, monoEnvelope(repaired), left, laneHeight + 10,
    plotWidth, laneHeight, "#48d7c1");
  context.strokeStyle = "rgba(38, 52, 68, 0.9)";
  context.beginPath();
  context.moveTo(left, laneHeight + 5);
  context.lineTo(left + plotWidth, laneHeight + 5);
  context.stroke();

  if (playheadSec >= 0) {
    const x = left + Math.min(1, playheadSec / duration) * plotWidth;
    context.strokeStyle = "#ffbd5c";
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(x, 6);
    context.lineTo(x, height - 18);
    context.stroke();
  }
}

function stopPlayback(): void {
  if (activeSource) {
    try {
      activeSource.stop();
    } catch {
      // Source already stopped.
    }
    activeSource.disconnect();
    activeSource = null;
  }
  cancelAnimationFrame(animationFrame);
  playheadSec = -1;
  drawWaveform();
}

function startAnimation(startedAt: number): void {
  const tick = (): void => {
    if (!activeSource || !audioContext) {
      playheadSec = -1;
      drawWaveform();
      return;
    }
    playheadSec = Math.max(0, audioContext.currentTime - startedAt);
    if (playheadSec >= repaired.durationSec) {
      playheadSec = -1;
      activeSource = null;
      drawWaveform();
      return;
    }
    drawWaveform();
    animationFrame = requestAnimationFrame(tick);
  };
  animationFrame = requestAnimationFrame(tick);
}

async function play(audio: RenderedAudio): Promise<void> {
  stopPlayback();
  audioContext ||= new AudioContext();
  await audioContext.resume();
  const buffer = audioContext.createBuffer(
    audio.channels.length,
    audio.channels[0].length,
    audio.sampleRate
  );
  audio.channels.forEach((channel, index) => buffer.copyToChannel(channel, index));
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.onended = () => {
    if (activeSource === source) {
      activeSource = null;
      playheadSec = -1;
      drawWaveform();
    }
  };
  activeSource = source;
  source.start();
  startAnimation(audioContext.currentTime);
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportWav(): void {
  const wav = encodeWavPcm16(repaired.channels, repaired.sampleRate);
  download(
    new Blob([wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength)],
      { type: "audio/wav" }),
    `repaired-${scenario}.wav`
  );
  statusLine.textContent = `已导出 WAV：${repaired.durationSec.toFixed(2)}s / ${repaired.sampleRate}Hz`;
}

function exportDiagnostics(): void {
  const payload = {
    schema: "car-voice-repair/v1",
    generatedAt: new Date().toISOString(),
    scenario,
    demo: {
      durationSec: demo.durationSec,
      packets: demo.packets.length,
      droppedPackets: demo.droppedPackets,
      corruptedPackets: demo.corruptedPackets,
      rateChangeAtSec: demo.rateChangeAtSec
    },
    stats: report.stats,
    state: report.state,
    intervals: report.intervals,
    events: report.events
  };
  download(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    `repair-diagnostics-${scenario}.json`
  );
  statusLine.textContent = "诊断 JSON 已导出，包含每段补齐区间与逐事件状态快照。";
}

function waitForSourceOpen(mediaSource: MediaSource): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("MediaSource 打开超时")), 5000);
    mediaSource.addEventListener("sourceopen", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function appendBuffer(
  sourceBuffer: SourceBuffer,
  data: ArrayBuffer
): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      sourceBuffer.removeEventListener("updateend", done);
      sourceBuffer.removeEventListener("error", failed);
      resolve();
    };
    const failed = (): void => {
      sourceBuffer.removeEventListener("updateend", done);
      sourceBuffer.removeEventListener("error", failed);
      reject(new Error("SourceBuffer 追加失败"));
    };
    sourceBuffer.addEventListener("updateend", done);
    sourceBuffer.addEventListener("error", failed);
    sourceBuffer.appendBuffer(data);
  });
}

async function encodeWebM(): Promise<{ data: Uint8Array; chunks: number; description: Uint8Array }> {
  if (!("AudioEncoder" in window) || !("AudioData" in window)) {
    throw new Error("当前浏览器不支持 WebCodecs AudioEncoder");
  }
  const sampleRate = 48000;
  const channels = 2;
  const sources = Array.from({ length: channels }, (_, channel) =>
    repaired.channels[Math.min(channel, repaired.channels.length - 1)]
  );
  const frames: EncodedAudioFrame[] = [];
  let description = new Uint8Array(0);
  let encoderError: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      frames.push({
        timestampUs: chunk.timestamp,
        data,
        keyframe: chunk.type === "key"
      });
      const configDescription = metadata.decoderConfig?.description;
      if (configDescription) {
        description = configDescription instanceof ArrayBuffer
          ? new Uint8Array(configDescription.slice(0))
          : new Uint8Array(
              configDescription.buffer.slice(
                configDescription.byteOffset,
                configDescription.byteOffset + configDescription.byteLength
              )
            );
      }
    },
    error: (error) => {
      encoderError = error;
    }
  });
  encoder.configure({
    codec: "opus",
    sampleRate,
    numberOfChannels: channels,
    bitrate: 96_000
  });

  const chunkFrames = 960;
  for (let offset = 0; offset < sources[0].length; offset += chunkFrames) {
    const count = Math.min(chunkFrames, sources[0].length - offset);
    const planar = new Float32Array(count * channels);
    for (let channel = 0; channel < channels; channel += 1) {
      planar.set(sources[channel].subarray(offset, offset + count), channel * count);
    }
    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: count,
      numberOfChannels: channels,
      timestamp: Math.round(offset / sampleRate * 1_000_000),
      data: planar
    });
    encoder.encode(audioData);
    audioData.close();
  }
  await encoder.flush();
  encoder.close();
  if (encoderError) throw encoderError;
  if (frames.length === 0) throw new Error("编码器没有输出音频帧");

  const data = muxOpusWebM(frames, {
    durationMs: repaired.durationSec * 1000,
    sampleRate,
    channels,
    description
  });
  return { data, chunks: frames.length, description };
}

async function mediaPreview(): Promise<void> {
  const button = byId<HTMLButtonElement>("encodePreview");
  button.disabled = true;
  stopPlayback();
  mediaStatus.textContent = "WebCodecs 编码中…";
  try {
    const encoded = await encodeWebM();
    const mimeCandidates = [
      "audio/webm; codecs=opus",
      "audio/webm;codecs=opus",
      "audio/webm"
    ];
    const mime = mimeCandidates.find((candidate) =>
      typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(candidate)
    );
    const buffer = encoded.data.buffer.slice(
      encoded.data.byteOffset,
      encoded.data.byteOffset + encoded.data.byteLength
    );

    if (mediaObjectUrl) URL.revokeObjectURL(mediaObjectUrl);
    if (mime && typeof MediaSource !== "undefined") {
      const mediaSource = new MediaSource();
      const opened = waitForSourceOpen(mediaSource);
      mediaObjectUrl = URL.createObjectURL(mediaSource);
      preview.src = mediaObjectUrl;
      await opened;
      const sourceBuffer = mediaSource.addSourceBuffer(mime);
      await appendBuffer(sourceBuffer, buffer);
      mediaSource.endOfStream();
      mediaStatus.textContent =
        `MSE 已载入 · ${encoded.chunks} 个 Opus 包 · ${(encoded.data.length / 1024).toFixed(1)} KB`;
    } else {
      const blob = new Blob([buffer], { type: "audio/webm" });
      mediaObjectUrl = URL.createObjectURL(blob);
      preview.src = mediaObjectUrl;
      mediaStatus.textContent =
        `MSE 不支持，已生成本地 WebM · ${(encoded.data.length / 1024).toFixed(1)} KB`;
    }
    statusLine.textContent =
      `WebCodecs 编码完成：${encoded.chunks} 包，OpusHead ${encoded.description.length} 字节。`;
  } catch (error) {
    mediaStatus.textContent = `预览不可用：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    button.disabled = false;
  }
}

scenarioSelect.addEventListener("change", () => {
  scenario = scenarioSelect.value as DemoScenario;
  analyze();
});
byId("reanalyze").addEventListener("click", analyze);
byId("playRepaired").addEventListener("click", () => void play(repaired));
byId("playDropped").addEventListener("click", () => void play(dropped));
byId("stopPlayback").addEventListener("click", stopPlayback);
byId("exportWav").addEventListener("click", exportWav);
byId("exportJson").addEventListener("click", exportDiagnostics);
byId("encodePreview").addEventListener("click", () => void mediaPreview());

waveform.addEventListener("click", (event) => {
  const rect = waveform.getBoundingClientRect();
  const plotLeft = 92;
  const plotWidth = rect.width - plotLeft - 14;
  const fraction = (event.clientX - rect.left - plotLeft) / plotWidth;
  if (fraction < 0 || fraction > 1) return;
  const time = fraction * repaired.durationSec;
  const index = report.intervals.findIndex(
    (interval) => time >= interval.startTimeSec && time <= interval.endTimeSec
  );
  if (index >= 0) selectInterval(index);
});

window.addEventListener("resize", drawWaveform);
new ResizeObserver(drawWaveform).observe(waveform);
analyze();
