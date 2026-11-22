import { analyzeSegment, buildPlaylist, runSeekTrials } from "./analyzer.ts";
import { decodeFile, probeMediaSource } from "./decoder.ts";
import { mixToMono } from "./dsp.ts";
import type {
  FixtureManifest,
  PcmAudio,
  Playlist,
  SeekTrial,
  SegmentAnalysis,
  SegmentDescriptor
} from "./types.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

const dom = {
  session: $("session-label"),
  decodePath: $("decode-path"),
  scoreRing: $("score-ring"),
  scoreNumber: $("score-number"),
  confirmedCount: $("confirmed-count"),
  unconfirmedCount: $("unconfirmed-count"),
  totalDuration: $("total-duration"),
  trimmedSamples: $("trimmed-samples"),
  timeline: $<HTMLCanvasElement>("timeline"),
  timelineEmpty: $("timeline-empty"),
  playButton: $<HTMLButtonElement>("play-button"),
  playIcon: $("play-icon"),
  backButton: $<HTMLButtonElement>("back-button"),
  forwardButton: $<HTMLButtonElement>("forward-button"),
  currentTime: $("current-time"),
  durationTime: $("duration-time"),
  segmentClock: $("segment-clock"),
  nextSeam: $<HTMLButtonElement>("next-seam"),
  meterFill: $("meter-fill"),
  playState: $("play-state"),
  segmentList: $("segment-list"),
  segmentSummary: $("segment-summary"),
  seamStatus: $("seam-status"),
  seamList: $("seam-list"),
  seekTest: $<HTMLButtonElement>("seek-test"),
  trialCount: $("trial-count"),
  trialPass: $("trial-pass"),
  trialLog: $("trial-log"),
  unconfirmedSection: $("unconfirmed-section"),
  holdSummary: $("hold-summary"),
  holdList: $("hold-list"),
  systemRuntime: $("system-runtime"),
  systemMse: $("system-mse")
};

const state: {
  manifest: FixtureManifest | null;
  analyses: SegmentAnalysis[];
  playlist: Playlist | null;
  mono: Float32Array | null;
  decodePaths: Set<string>;
  activeSegment: number;
  busy: boolean;
  flash: { seam: number; until: number } | null;
} = {
  manifest: null,
  analyses: [],
  playlist: null,
  mono: null,
  decodePaths: new Set(),
  activeSegment: -1,
  busy: false,
  flash: null
};

function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

function timecode(seconds: number, decimals = 3): string {
  const clamped = Math.max(0, seconds);
  const minutes = Math.floor(clamped / 60);
  const rest = clamped - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0")}`;
}

function secondsLabel(seconds: number): string {
  return `${seconds.toFixed(2)} s`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

class WebAudioPlayer {
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meter = new Uint8Array(128);
  private startedAt = 0;
  private offset = 0;
  private token = 0;
  private playlist: Playlist | null = null;
  playing = false;

  setPlaylist(playlist: Playlist): void {
    this.playlist = playlist;
    this.buffer = null;
    this.offset = 0;
    this.playing = false;
  }

  private async ensureContext(): Promise<AudioContext> {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: this.playlist?.sampleRate });
      this.gain = this.context.createGain();
      this.gain.gain.value = 0.78;
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      this.gain.connect(this.analyser);
      this.analyser.connect(this.context.destination);
    }
    if (this.context.state === "suspended") await this.context.resume();
    return this.context;
  }

  private ensureBuffer(context: AudioContext): AudioBuffer {
    if (this.buffer) return this.buffer;
    const playlist = this.playlist;
    if (!playlist) throw new Error("No playlist loaded");
    const buffer = context.createBuffer(playlist.channelCount, playlist.totalSamples, playlist.sampleRate);
    for (let channel = 0; channel < playlist.channelCount; channel++) {
      buffer.getChannelData(channel).set(playlist.pcm[channel]);
    }
    this.buffer = buffer;
    return buffer;
  }

  stopSource(): void {
    this.token++;
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // The source may already have finished.
      }
      this.source.disconnect();
      this.source = null;
    }
    this.playing = false;
  }

  async play(from = this.offset): Promise<void> {
    if (!this.playlist) return;
    const context = await this.ensureContext();
    const buffer = this.ensureBuffer(context);
    this.stopSource();
    const start = Math.max(0, Math.min(from, Math.max(0, buffer.duration - 0.0001)));
    const source = context.createBufferSource();
    const token = ++this.token;
    source.buffer = buffer;
    source.connect(this.gain as GainNode);
    source.onended = () => {
      if (token !== this.token) return;
      this.playing = false;
      this.offset = buffer.duration;
      this.source = null;
    };
    source.start(0, start);
    this.source = source;
    this.startedAt = context.currentTime - start;
    this.offset = start;
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.currentTime();
    this.stopSource();
  }

  async toggle(): Promise<void> {
    if (this.playing) this.pause();
    else {
      const duration = this.playlist?.totalSeconds || 0;
      await this.play(this.offset >= duration - 0.01 ? 0 : this.offset);
    }
  }

  async seek(seconds: number): Promise<void> {
    const duration = this.playlist?.totalSeconds || 0;
    const target = Math.max(0, Math.min(seconds, duration));
    if (this.playing) await this.play(target);
    else this.offset = target;
  }

  currentTime(): number {
    if (!this.playing || !this.context) return this.offset;
    return Math.max(0, Math.min(this.context.currentTime - this.startedAt, this.playlist?.totalSeconds || 0));
  }

  level(): number {
    if (!this.analyser || !this.playing) return 0;
    this.analyser.getByteTimeDomainData(this.meter);
    let sum = 0;
    for (const value of this.meter) {
      const normalized = (value - 128) / 128;
      sum += normalized * normalized;
    }
    return Math.min(1, Math.sqrt(sum / this.meter.length) * 3);
  }
}

const player = new WebAudioPlayer();

function renderOverview(): void {
  const playlist = state.playlist;
  if (!playlist) return;
  const confirmed = playlist.segments.length;
  const held = playlist.unconfirmed.length;
  const trimmed = playlist.segments.reduce(
    (sum, segment) => sum + (segment.primingSamples || 0) + (segment.paddingSamples || 0),
    0
  );
  const passed = playlist.seams.filter((seam) => seam.status === "pass").length;
  const total = playlist.seams.length;
  const ratio = total ? passed / total : 1;

  dom.confirmedCount.textContent = String(confirmed).padStart(2, "0");
  dom.unconfirmedCount.textContent = String(held).padStart(2, "0");
  dom.totalDuration.textContent = secondsLabel(playlist.totalSeconds);
  dom.trimmedSamples.textContent = `${formatInt(trimmed)} smp`;
  dom.scoreNumber.textContent = `${passed}/${total}`;
  dom.scoreRing.style.setProperty("--score", `${ratio * 360}deg`);
  dom.durationTime.textContent = timecode(playlist.totalSeconds);
  dom.segmentSummary.textContent = `${confirmed} CONFIRMED · ${confirmed + held} TOTAL`;
  dom.decodePath.textContent = state.decodePaths.has("WebCodecs")
    ? "DECODE · WEBCODECS"
    : "DECODE · WEBAUDIO FALLBACK";
  dom.systemRuntime.textContent = state.decodePaths.has("WebCodecs")
    ? "WebCodecs raw AAC + WebAudio"
    : "WebAudio decodeAudioData fallback";
  dom.timelineEmpty.hidden = true;
  dom.playButton.disabled = playlist.totalSamples === 0;
  dom.nextSeam.disabled = playlist.seams.length === 0;
}

function renderSegments(): void {
  dom.segmentList.innerHTML = state.analyses
    .map((segment) => {
      const confirmed = segment.status === "confirmed";
      const status = confirmed ? "已确认" : "待核验";
      const pill = confirmed ? "pass" : "hold";
      const keep = segment.retainedSamples;
      const keepSeconds = keep !== null ? keep / segment.sampleRate : null;
      const tags = segment.evidence
        .slice(0, 4)
        .map((item) => `<span class="evidence-tag${item.kind === "validation" && item.detail !== "通过" ? " bad" : ""}">${escapeHtml(item.label)} · ${escapeHtml(item.detail)}</span>`)
        .join("");
      return `
        <article class="segment-card${confirmed ? "" : " is-unconfirmed"}" style="--segment-color:${segment.descriptor.color}" data-segment="${segment.descriptor.ordinal}">
          <div class="segment-main">
            <div class="segment-topline">
              <span class="segment-number">${String(segment.descriptor.ordinal).padStart(2, "0")}</span>
              <span class="segment-code">${escapeHtml(segment.codec)} · ${(segment.sampleRate / 1000).toFixed(1)} kHz · ${segment.channelCount} ch</span>
              <span class="status-pill ${pill}">${status}</span>
            </div>
            <h3>${escapeHtml(segment.descriptor.title)}</h3>
            <p class="segment-reason">${escapeHtml(segment.reason)}</p>
          </div>
          <div class="segment-side">
            <canvas class="mini-wave" data-mini="${segment.descriptor.ordinal}" aria-label="${escapeHtml(segment.descriptor.title)} 波形"></canvas>
            <div class="trim-stats">
              <div><span>PRE</span><strong>${formatInt(segment.primingSamples)}</strong></div>
              <div><span>KEEP</span><strong>${formatInt(keep)}</strong><span>${keepSeconds === null ? "—" : `${keepSeconds.toFixed(2)} s`}</span></div>
              <div><span>PAD</span><strong>${formatInt(segment.paddingSamples)}</strong></div>
              <div><span>DEC</span><strong>${formatInt(segment.decodedSamples)}</strong></div>
              <div><span>CONF</span><strong>${confirmed ? `${(segment.confidence * 100).toFixed(1)}%` : "—"}</strong></div>
            </div>
          </div>
          <div class="evidence-row">${tags}</div>
        </article>`;
    })
    .join("");
  drawMiniWaves();
}

function renderSeams(): void {
  const playlist = state.playlist;
  if (!playlist) return;
  const passed = playlist.seams.filter((seam) => seam.status === "pass").length;
  dom.seamStatus.textContent = `${passed} / ${playlist.seams.length} PASS`;
  dom.seamStatus.className = `status-pill ${passed === playlist.seams.length ? "pass" : "fail"}`;
  dom.seekTest.disabled = playlist.seams.length === 0;
  if (playlist.seams.length === 0) {
    dom.seamList.innerHTML = `<div class="empty-panel">没有可验证的连续接缝</div>`;
    return;
  }
  dom.seamList.innerHTML = playlist.seams
    .map((seam) => {
      const left = playlist.segments[seam.index - 1];
      const right = playlist.segments[seam.index];
      const ok = seam.status === "pass";
      return `
        <button class="seam-row" type="button" data-seam="${seam.index}">
          <span class="seam-index">S${seam.index}</span>
          <span>
            <span class="seam-title">${escapeHtml(left.descriptor.title)} → ${escapeHtml(right.descriptor.title)}</span>
            <span class="seam-time">${timecode(seam.atSeconds)} · sample ${formatInt(seam.atSample)}</span>
          </span>
          <span class="seam-delta">Δ ${seam.step.toFixed(4)}<small>${seam.stepRatio.toFixed(2)}× local</small></span>
          <span class="seam-check ${ok ? "" : "review"}">${ok ? "✓" : "!"}</span>
        </button>`;
    })
    .join("");
}

function renderHolds(): void {
  const playlist = state.playlist;
  if (!playlist) return;
  dom.unconfirmedSection.hidden = playlist.unconfirmed.length === 0;
  dom.holdSummary.textContent = `${playlist.unconfirmed.length} SEGMENTS · NOT SCHEDULED`;
  dom.holdList.innerHTML = playlist.unconfirmed
    .map((segment) => `
      <article class="hold-card">
        <span class="segment-number" style="color:${segment.descriptor.color}">${String(segment.descriptor.ordinal).padStart(2, "0")} / HOLD</span>
        <h3>${escapeHtml(segment.descriptor.title)}</h3>
        <p>${escapeHtml(segment.reason)}</p>
        <div class="hold-meta">
          <span>${formatInt(segment.decodedSamples)} decoded smp</span>
          <span>${(segment.sampleRate / 1000).toFixed(1)} kHz</span>
          <span>${segment.mp4.warnings[0] ? escapeHtml(segment.mp4.warnings[0]) : "no trusted trim"}</span>
        </div>
      </article>`)
    .join("");
}

function drawMiniWaves(): void {
  for (const segment of state.analyses) {
    const canvas = document.querySelector<HTMLCanvasElement>(`[data-mini="${segment.descriptor.ordinal}"]`);
    if (!canvas) continue;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const context = canvas.getContext("2d");
    if (!context) continue;
    context.scale(dpr, dpr);
    const width = rect.width;
    const height = rect.height;
    const middle = height / 2;
    const mono = mixToMono(segment.pcm);
    const start = segment.retainedStart ?? 0;
    const end = segment.retainedEnd ?? mono.length;
    if (segment.primingSamples) {
      const x = (segment.primingSamples / mono.length) * width;
      context.fillStyle = "#f2b45f16";
      context.fillRect(0, 0, x, height);
    }
    if (segment.paddingSamples) {
      const x = (end / mono.length) * width;
      context.fillStyle = "#f2b45f16";
      context.fillRect(x, 0, width - x, height);
    }
    context.fillStyle = "#ffffff0b";
    context.fillRect(0, middle, width, 1);
    const columns = Math.max(1, Math.floor(width));
    for (let x = 0; x < columns; x++) {
      const from = Math.floor((x / columns) * mono.length);
      const to = Math.max(from + 1, Math.floor(((x + 1) / columns) * mono.length));
      let min = 0;
      let max = 0;
      const stride = Math.max(1, Math.floor((to - from) / 16));
      for (let i = from; i < to; i += stride) {
        min = Math.min(min, mono[i]);
        max = Math.max(max, mono[i]);
      }
      const active = x >= (start / mono.length) * width && x <= (end / mono.length) * width;
      context.fillStyle = active ? `${segment.descriptor.color}d9` : "#65706660";
      context.fillRect(x, middle + min * height * 0.44, 1, Math.max(1, (max - min) * height * 0.44));
    }
    if (segment.primingSamples || segment.paddingSamples) {
      context.strokeStyle = "#f2b45f66";
      context.lineWidth = 1;
      const left = ((segment.retainedStart || 0) / mono.length) * width;
      const right = ((segment.retainedEnd || mono.length) / mono.length) * width;
      context.beginPath();
      context.moveTo(left + 0.5, 0);
      context.lineTo(left + 0.5, height);
      context.moveTo(right - 0.5, 0);
      context.lineTo(right - 0.5, height);
      context.stroke();
    }
  }
}

function renderAll(): void {
  renderOverview();
  renderSegments();
  renderSeams();
  renderHolds();
  rebuildTimelineBase();
}

let timelineBase: HTMLCanvasElement | null = null;
let plot = { x: 24, y: 36, w: 1, h: 120 };
let lastPaintTime = -1;

function timelineSize(): { width: number; height: number; dpr: number } {
  const rect = dom.timeline.getBoundingClientRect();
  return {
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
    dpr: Math.min(2, window.devicePixelRatio || 1)
  };
}

function drawTimelineBase(): void {
  const playlist = state.playlist;
  if (!playlist || !state.mono) return;
  const { width, height, dpr } = timelineSize();
  const base = document.createElement("canvas");
  base.width = Math.round(width * dpr);
  base.height = Math.round(height * dpr);
  const context = base.getContext("2d");
  if (!context) return;
  context.scale(dpr, dpr);
  plot = { x: 24, y: 38, w: width - 48, h: height - 84 };
  const middle = plot.y + plot.h * 0.5;
  const cursorBySegment = new Map<number, { start: number; end: number }>();
  let cursor = 0;

  context.lineWidth = 1;
  for (const segment of playlist.segments) {
    const length = segment.retainedSamples || 0;
    const xStart = plot.x + (cursor / playlist.totalSamples) * plot.w;
    const xEnd = plot.x + ((cursor + length) / playlist.totalSamples) * plot.w;
    cursorBySegment.set(segment.descriptor.ordinal, { start: xStart, end: xEnd });
    context.fillStyle = `${segment.descriptor.color}0b`;
    context.fillRect(xStart, plot.y, xEnd - xStart, plot.h);
    context.fillStyle = `${segment.descriptor.color}20`;
    context.fillRect(xStart, height - 30, xEnd - xStart, 20);
    context.fillStyle = `${segment.descriptor.color}e8`;
    context.fillRect(xStart, height - 30, Math.max(1, xEnd - xStart - 1), 2);

    const columns = Math.max(1, Math.floor(xEnd - xStart));
    for (let column = 0; column < columns; column++) {
      const from = cursor + Math.floor((column / columns) * length);
      const to = cursor + Math.max(1, Math.floor(((column + 1) / columns) * length));
      let min = 0;
      let max = 0;
      const stride = Math.max(1, Math.floor((to - from) / 24));
      for (let sample = from; sample < to; sample += stride) {
        const value = state.mono[sample] || 0;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      const x = xStart + column;
      const top = middle + min * plot.h * 0.47;
      const bottom = middle + max * plot.h * 0.47;
      context.fillStyle = `${segment.descriptor.color}c4`;
      context.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
    if (xEnd - xStart > 54) {
      context.fillStyle = "#e9ede5b8";
      context.font = "9px SFMono-Regular, monospace";
      context.fillText(String(segment.descriptor.ordinal).padStart(2, "0"), xStart + 7, height - 16);
    }
    cursor += length;
  }
  context.strokeStyle = "#ffffff0c";
  context.beginPath();
  context.moveTo(plot.x, middle + 0.5);
  context.lineTo(plot.x + plot.w, middle + 0.5);
  context.stroke();

  for (const seam of playlist.seams) {
    const x = plot.x + (seam.atSample / playlist.totalSamples) * plot.w;
    context.strokeStyle = "#f2b45f80";
    context.setLineDash([2, 4]);
    context.beginPath();
    context.moveTo(x + 0.5, plot.y);
    context.lineTo(x + 0.5, plot.y + plot.h);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = "#f2b45f";
    context.beginPath();
    context.moveTo(x - 3.5, plot.y - 7);
    context.lineTo(x + 3.5, plot.y - 7);
    context.lineTo(x, plot.y - 1);
    context.closePath();
    context.fill();
    context.font = "8px SFMono-Regular, monospace";
    context.fillStyle = "#f2b45fb8";
    context.fillText(`S${seam.index}`, x + 5, 18);
  }

  if (playlist.unconfirmed.length) {
    context.font = "8px SFMono-Regular, monospace";
    context.fillStyle = "#f2b45f99";
    context.textAlign = "right";
    context.fillText(`+${playlist.unconfirmed.length} HOLD`, width - 20, 18);
    context.textAlign = "left";
  }
  timelineBase = base;
}

function rebuildTimelineBase(): void {
  const { width, height, dpr } = timelineSize();
  dom.timeline.width = Math.round(width * dpr);
  dom.timeline.height = Math.round(height * dpr);
  dom.timeline.style.width = `${width}px`;
  dom.timeline.style.height = `${height}px`;
  drawTimelineBase();
  drawTimeline(true);
}

function drawTimeline(force = false): void {
  const playlist = state.playlist;
  if (!playlist || !timelineBase) return;
  const { width, height, dpr } = timelineSize();
  if (dom.timeline.width !== Math.round(width * dpr) || dom.timeline.height !== Math.round(height * dpr)) {
    rebuildTimelineBase();
    return;
  }
  const context = dom.timeline.getContext("2d");
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, dom.timeline.width, dom.timeline.height);
  context.drawImage(timelineBase, 0, 0);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);

  const current = player.currentTime();
  const x = plot.x + (Math.min(current, playlist.totalSeconds) / playlist.totalSeconds) * plot.w;
  context.fillStyle = "#f6f1e5";
  context.fillRect(x, plot.y - 10, 1.5, plot.h + 10);
  context.fillStyle = "#f6f1e5";
  context.beginPath();
  context.moveTo(x - 4, plot.y - 13);
  context.lineTo(x + 5.5, plot.y - 13);
  context.lineTo(x + 1, plot.y - 6);
  context.closePath();
  context.fill();
  context.shadowColor = "#f2b45f";
  context.shadowBlur = 12;
  context.fillStyle = "#f2b45f";
  context.fillRect(x, plot.y - 2, 1, 3);
  context.shadowBlur = 0;

  if (state.flash) {
    const seam = playlist.seams.find((item) => item.index === state.flash?.seam);
    if (seam && performance.now() < state.flash.until) {
      const seamX = plot.x + (seam.atSample / playlist.totalSamples) * plot.w;
      context.strokeStyle = "#f2b45f";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(seamX, plot.y + 10, 9, 0, Math.PI * 2);
      context.stroke();
    } else {
      state.flash = null;
    }
  }
  lastPaintTime = current;
  void force;
}

function currentSegmentIndex(current: number): number {
  const playlist = state.playlist;
  if (!playlist) return -1;
  let cursor = 0;
  const samples = current * playlist.sampleRate;
  for (let i = 0; i < playlist.segments.length; i++) {
    const length = playlist.segments[i].retainedSamples || 0;
    if (samples < cursor + length || i === playlist.segments.length - 1) return i;
    cursor += length;
  }
  return -1;
}

function updateTransport(force = false): void {
  const playlist = state.playlist;
  if (!playlist) return;
  const current = player.currentTime();
  const changed = Math.abs(current - lastPaintTime) > 0.0005 || force;
  if (!changed && !state.flash) return;
  dom.currentTime.textContent = timecode(current);
  dom.playState.textContent = player.playing ? "PLAYING" : current > 0 ? "PAUSED" : "READY";
  dom.playIcon.textContent = player.playing ? "Ⅱ" : "▶";
  dom.playButton.classList.toggle("is-playing", player.playing);
  dom.meterFill.style.width = `${Math.round(player.level() * 100)}%`;
  const segmentIndex = currentSegmentIndex(current);
  dom.segmentClock.textContent = segmentIndex >= 0
    ? `SEG ${String(segmentIndex + 1).padStart(2, "0")} / ${String(playlist.segments.length).padStart(2, "0")}`
    : "SEG — / —";
  if (segmentIndex !== state.activeSegment) {
    state.activeSegment = segmentIndex;
    document.querySelectorAll(".segment-card.is-active").forEach((node) => node.classList.remove("is-active"));
    const ordinal = playlist.segments[segmentIndex]?.descriptor.ordinal;
    if (ordinal) document.querySelector(`[data-segment="${ordinal}"]`)?.classList.add("is-active");
  }
  drawTimeline(force);
}

function animate(): void {
  updateTransport();
  window.requestAnimationFrame(animate);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function renderSeekTrial(seamIndex: number, round: number): Promise<SeekTrial> {
  const playlist = state.playlist;
  if (!playlist) throw new Error("No playlist");
  const seam = playlist.seams[seamIndex];
  const context = new OfflineAudioContext(1, 128, playlist.sampleRate);
  const buffer = context.createBuffer(1, playlist.totalSamples, playlist.sampleRate);
  buffer.getChannelData(0).set(playlist.pcm[0]);
  const source = context.createBufferSource();
  const preRoll = 48;
  const offset = Math.max(0, seam.atSample - preRoll) / playlist.sampleRate;
  source.buffer = buffer;
  source.connect(context.destination);
  source.start(0, offset);
  const rendered = await context.startRendering();
  const output = rendered.getChannelData(0);
  const spot = Math.min(preRoll, output.length - 1);
  const step = Math.abs(output[spot] - output[Math.max(0, spot - 1)]);
  const passed = Math.abs(step - seam.step) < 5e-5;
  return {
    round,
    seamIndex: seam.index,
    atSeconds: seam.atSeconds,
    renderedAt: offset,
    step,
    expectedStep: seam.step,
    passed
  };
}

async function runSeekTests(): Promise<void> {
  const playlist = state.playlist;
  if (!playlist || state.busy || playlist.seams.length === 0) return;
  state.busy = true;
  dom.seekTest.disabled = true;
  const label = dom.seekTest.querySelector("span");
  if (label) label.textContent = "正在渲染定位…";
  dom.trialLog.innerHTML = "";
  dom.trialCount.textContent = "0 / 10";
  dom.trialPass.textContent = "…";
  let passed = 0;

  try {
    for (let round = 1; round <= 10; round++) {
      const seamIndex = (round - 1) % playlist.seams.length;
      let trial: SeekTrial;
      if (typeof OfflineAudioContext === "undefined") {
        const [fallback] = runSeekTrials(playlist, 10).slice(round - 1, round);
        trial = fallback;
      } else {
        trial = await renderSeekTrial(seamIndex, round);
      }
      if (trial.passed) passed++;
      state.flash = { seam: playlist.seams[seamIndex].index, until: performance.now() + 260 };
      const line = document.createElement("div");
      line.className = "log-line";
      line.innerHTML = `<span>${String(round).padStart(2, "0")}</span><span><b>S${trial.seamIndex}</b> @ ${trial.atSeconds.toFixed(6)} s · Δ ${trial.step.toFixed(5)}</span><span class="${trial.passed ? "ok" : "bad"}">${trial.passed ? "PASS" : "FAIL"}</span>`;
      dom.trialLog.append(line);
      dom.trialLog.scrollTop = dom.trialLog.scrollHeight;
      dom.trialCount.textContent = `${round} / 10`;
      dom.trialPass.textContent = `${passed} / ${round}`;
      drawTimeline(true);
      await delay(45);
    }
    const labelDone = dom.seekTest.querySelector("span");
    if (labelDone) labelDone.textContent = passed === 10 ? "10 次跳接缝全部通过" : "重跑接缝验收";
    dom.trialPass.textContent = `${passed} / 10`;
    dom.seamStatus.textContent = passed === 10 ? "10/10 SEEK PASS" : `${passed}/10 SEEK`;
    dom.seamStatus.className = `status-pill ${passed === 10 ? "pass" : "fail"}`;
  } catch (error) {
    const line = document.createElement("div");
    line.className = "log-line";
    line.innerHTML = `<span>!!</span><span>${escapeHtml(String(error))}</span><span class="bad">ERROR</span>`;
    dom.trialLog.append(line);
  } finally {
    state.busy = false;
    dom.seekTest.disabled = false;
  }
}

async function jumpTo(seconds: number, startPlayback = false): Promise<void> {
  const playlist = state.playlist;
  if (!playlist) return;
  const target = Math.max(0, Math.min(seconds, playlist.totalSeconds));
  await player.seek(target);
  if (startPlayback && !player.playing) await player.play(target);
  updateTransport(true);
}

function installEvents(): void {
  dom.playButton.addEventListener("click", async () => {
    await player.toggle();
    updateTransport(true);
  });
  dom.backButton.addEventListener("click", async () => {
    await jumpTo(player.currentTime() - 2);
  });
  dom.forwardButton.addEventListener("click", async () => {
    await jumpTo(player.currentTime() + 2);
  });
  dom.nextSeam.addEventListener("click", async () => {
    const playlist = state.playlist;
    if (!playlist) return;
    const current = player.currentTime();
    const seam = playlist.seams.find((item) => item.atSeconds > current + 0.01) || playlist.seams[0];
    if (seam) await jumpTo(seam.atSeconds, player.playing);
  });
  dom.timeline.addEventListener("click", async (event) => {
    const playlist = state.playlist;
    if (!playlist) return;
    const rect = dom.timeline.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < plot.x || x > plot.x + plot.w) return;
    const seconds = ((x - plot.x) / plot.w) * playlist.totalSeconds;
    await jumpTo(seconds);
  });
  dom.seamList.addEventListener("click", async (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-seam]");
    if (!row) return;
    const playlist = state.playlist;
    if (!playlist) return;
    const index = Number(row.dataset.seam);
    const seam = playlist.seams.find((item) => item.index === index);
    if (!seam) return;
    state.flash = { seam: index, until: performance.now() + 620 };
    await jumpTo(seam.atSeconds, true);
  });
  dom.segmentList.addEventListener("click", async (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-segment]");
    const playlist = state.playlist;
    if (!card || !playlist) return;
    const ordinal = Number(card.dataset.segment);
    let cursor = 0;
    for (const segment of playlist.segments) {
      if (segment.descriptor.ordinal === ordinal) {
        await jumpTo(cursor / playlist.sampleRate);
        return;
      }
      cursor += segment.retainedSamples || 0;
    }
  });
  dom.seekTest.addEventListener("click", () => {
    void runSeekTests();
  });
  window.addEventListener("keydown", (event) => {
    if ((event.target as HTMLElement).matches("input, textarea, select")) return;
    if (event.code === "Space") {
      event.preventDefault();
      void player.toggle().then(() => updateTransport(true));
    } else if (event.code === "ArrowLeft") {
      event.preventDefault();
      void jumpTo(player.currentTime() - 1);
    } else if (event.code === "ArrowRight") {
      event.preventDefault();
      void jumpTo(player.currentTime() + 1);
    }
  });
  const observer = new ResizeObserver(() => {
    window.requestAnimationFrame(() => {
      rebuildTimelineBase();
      drawMiniWaves();
    });
  });
  observer.observe(dom.timeline.parentElement as HTMLElement);
}

async function probeMse(): Promise<void> {
  const first = state.manifest?.segments[0];
  if (!first) return;
  dom.systemMse.textContent = "checking audio/mp4…";
  try {
    const result = await probeMediaSource(first);
    dom.systemMse.textContent = result.supported ? `AAC segment · ${result.detail}` : result.detail;
  } catch (error) {
    dom.systemMse.textContent = `MIME supported · append ${String(error).slice(0, 28)}`;
  }
}

async function boot(): Promise<void> {
  try {
    const response = await fetch("./fixtures/manifest.json");
    if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
    const manifest = (await response.json()) as FixtureManifest;
    state.manifest = manifest;
    dom.session.textContent = `${manifest.title.toUpperCase()} / ${manifest.generated}`;
    const analyses: SegmentAnalysis[] = [];

    for (const descriptor of manifest.segments) {
      dom.segmentSummary.textContent = `DECODING ${analyses.length + 1} / ${manifest.segments.length}`;
      dom.timelineEmpty.textContent = `解析 ${descriptor.title} · sample table + AAC`;
      const decoded = await decodeFile(descriptor);
      state.decodePaths.add(decoded.decodePath);
      const pcm: PcmAudio = decoded.pcm;
      const analysis = analyzeSegment(descriptor, pcm, decoded.info);
      analyses.push(analysis);
      dom.decodePath.textContent = decoded.decodePath === "WebCodecs" ? "DECODE · WEBCODECS" : "DECODE · WEBAUDIO";
    }

    state.analyses = analyses;
    const playlist = buildPlaylist(analyses);
    state.playlist = playlist;
    state.mono = mixToMono({ sampleRate: playlist.sampleRate, channels: playlist.pcm, decodeMode: "webcodecs-raw" });
    player.setPlaylist(playlist);
    renderAll();
    installEvents();
    updateTransport(true);
    animate();
    void probeMse();
    if (playlist.segments.length === 0) {
      dom.timelineEmpty.hidden = false;
      dom.timelineEmpty.textContent = "没有可通过验证的片段";
    }
  } catch (error) {
    dom.timelineEmpty.hidden = false;
    dom.timelineEmpty.textContent = "解码失败，请使用支持 WebCodecs 或 WebAudio AAC 的浏览器";
    dom.segmentList.innerHTML = `<div class="empty-panel">${escapeHtml(String(error))}</div>`;
    dom.seamStatus.textContent = "ERROR";
    dom.seamStatus.className = "status-pill fail";
    dom.systemMse.textContent = "unavailable";
    console.error(error);
  }
}

void boot();
