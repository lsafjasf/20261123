import { detectPauses } from "./core/detection.ts";
import { generateDemoAudio } from "./core/demo.ts";
import { masterAudio } from "./core/loudness.ts";
import { renderProject } from "./core/render.ts";
import type {
  AudioSource,
  DetectedPause,
  DetectionSettings,
  RenderResult,
} from "./core/types.ts";
import { decodeWav, encodeWav24, pairTracks } from "./core/wav.ts";
import { AudioEngine } from "./ui/audio-engine.ts";
import {
  PeakData,
  TimelineCanvas,
  type WaveProject,
  type WaveSegmentView,
} from "./ui/waveform.ts";

interface HistorySnapshot {
  selectedId: string | null;
  settings: DetectionSettings;
  segments: Array<{ id: string; state: DetectedPause["state"]; targetMs: number }>;
}

interface AppState {
  source: AudioSource | null;
  sourcePeaks: PeakData | null;
  renderPeaks: PeakData | null;
  segments: DetectedPause[];
  render: RenderResult | null;
  selectedId: string | null;
  settings: DetectionSettings;
  speed: number;
  loudnessTarget: number;
  view: "edited" | "source";
  viewStart: number;
  viewDuration: number;
  fit: boolean;
  playhead: number;
  muted: [boolean, boolean];
  renderStale: boolean;
  history: HistorySnapshot[];
  auditSource: string;
  exportUrl: string | null;
  exportName: string;
  exportMeta: string;
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const dom = {
  welcome: element<HTMLElement>("welcome"),
  workspace: element<HTMLElement>("workspace"),
  fileInput: element<HTMLInputElement>("fileInput"),
  importButton: element<HTMLButtonElement>("importButton"),
  welcomeImportButton: element<HTMLButtonElement>("welcomeImportButton"),
  dropCard: element<HTMLButtonElement>("dropCard"),
  demoButton: element<HTMLButtonElement>("demoButton"),
  exportButton: element<HTMLButtonElement>("exportButton"),
  projectName: element<HTMLElement>("projectName"),
  projectMeta: element<HTMLElement>("projectMeta"),
  demoBadge: element<HTMLElement>("demoBadge"),
  sourceStamp: element<HTMLElement>("sourceStamp"),
  trackAMeta: element<HTMLElement>("trackAMeta"),
  trackBMeta: element<HTMLElement>("trackBMeta"),
  playButton: element<HTMLButtonElement>("playButton"),
  toStartButton: element<HTMLButtonElement>("toStartButton"),
  toEndButton: element<HTMLButtonElement>("toEndButton"),
  currentTime: element<HTMLElement>("currentTime"),
  durationTime: element<HTMLElement>("durationTime"),
  speedControl: element<HTMLElement>("speedControl"),
  thresholdRange: element<HTMLInputElement>("thresholdRange"),
  thresholdValue: element<HTMLElement>("thresholdValue"),
  targetRange: element<HTMLInputElement>("targetRange"),
  targetValue: element<HTMLElement>("targetValue"),
  smartProtection: element<HTMLInputElement>("smartProtection"),
  reanalyzeButton: element<HTMLButtonElement>("reanalyzeButton"),
  detectedCount: element<HTMLElement>("detectedCount"),
  removedDuration: element<HTMLElement>("removedDuration"),
  segmentTabCount: element<HTMLElement>("segmentTabCount"),
  segmentListCount: element<HTMLElement>("segmentListCount"),
  segmentList: element<HTMLElement>("segmentList"),
  segmentListEmpty: element<HTMLElement>("segmentListEmpty"),
  resetAllButton: element<HTMLButtonElement>("resetAllButton"),
  selectionEmpty: element<HTMLElement>("selectionEmpty"),
  selectionContent: element<HTMLElement>("selectionContent"),
  selectionKicker: element<HTMLElement>("selectionKicker"),
  selectionTime: element<HTMLElement>("selectionTime"),
  selectionStatus: element<HTMLElement>("selectionStatus"),
  selectionConfidence: element<HTMLElement>("selectionConfidence"),
  selectionOriginal: element<HTMLElement>("selectionOriginal"),
  selectionOutput: element<HTMLElement>("selectionOutput"),
  selectionLevel: element<HTMLElement>("selectionLevel"),
  selectionTarget: element<HTMLInputElement>("selectionTarget"),
  selectionTargetValue: element<HTMLElement>("selectionTargetValue"),
  previewOriginalButton: element<HTMLButtonElement>("previewOriginalButton"),
  previewProcessedButton: element<HTMLButtonElement>("previewProcessedButton"),
  bypassButton: element<HTMLButtonElement>("bypassButton"),
  undoSegmentButton: element<HTMLButtonElement>("undoSegmentButton"),
  zoomInButton: element<HTMLButtonElement>("zoomInButton"),
  zoomOutButton: element<HTMLButtonElement>("zoomOutButton"),
  zoomFitButton: element<HTMLButtonElement>("zoomFitButton"),
  timelineCanvas: element<HTMLCanvasElement>("timelineCanvas"),
  dragOverlay: element<HTMLElement>("dragOverlay"),
  processingOverlay: element<HTMLElement>("processingOverlay"),
  processingTitle: element<HTMLElement>("processingTitle"),
  processingText: element<HTMLElement>("processingText"),
  processingProgress: element<HTMLElement>("processingProgress"),
  toastHost: element<HTMLElement>("toastHost"),
  exportSheet: element<HTMLElement>("exportSheet"),
  sheetBackdrop: element<HTMLElement>("sheetBackdrop"),
  sheetClose: element<HTMLButtonElement>("sheetClose"),
  keepEditingButton: element<HTMLButtonElement>("keepEditingButton"),
  downloadButton: element<HTMLButtonElement>("downloadButton"),
  exportLufs: element<HTMLElement>("exportLufs"),
  exportPeak: element<HTMLElement>("exportPeak"),
  exportDuration: element<HTMLElement>("exportDuration"),
  exportSaved: element<HTMLElement>("exportSaved"),
  exportFileName: element<HTMLElement>("exportFileName"),
  exportSafeName: element<HTMLElement>("exportSafeName"),
  loudnessTarget: element<HTMLSelectElement>("loudnessTarget"),
  publishSampleRate: element<HTMLElement>("publishSampleRate"),
  publishDuration: element<HTMLElement>("publishDuration"),
  estimateLufs: element<HTMLElement>("estimateLufs"),
  publishExportButton: element<HTMLButtonElement>("publishExportButton"),
  meterLeft: element<HTMLElement>("meterLeft"),
  meterRight: element<HTMLElement>("meterRight"),
  canvasEmpty: element<HTMLElement>("canvasEmpty"),
};

const state: AppState = {
  source: null,
  sourcePeaks: null,
  renderPeaks: null,
  segments: [],
  render: null,
  selectedId: null,
  settings: { minSilenceMs: 800, targetMs: 250, smartProtection: true },
  speed: 1,
  loudnessTarget: -14,
  view: "edited",
  viewStart: 0,
  viewDuration: 1,
  fit: true,
  playhead: 0,
  muted: [false, false],
  renderStale: false,
  history: [],
  auditSource: "",
  exportUrl: null,
  exportName: "",
  exportMeta: "",
};

const engine = new AudioEngine();
let renderTimer = 0;
let animationFrame = 0;
let lastCanvasPaint = 0;
let dragDepth = 0;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(2).padStart(5, "0")}`;
}

function formatShortTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(1).padStart(4, "0")}`;
}

function formatSeconds(seconds: number): string {
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setRangeFill(input: HTMLInputElement): void {
  const minimum = Number(input.min);
  const maximum = Number(input.max);
  const value = Number(input.value);
  const percentage = ((value - minimum) / (maximum - minimum)) * 100;
  input.style.setProperty("--range-progress", `${percentage}%`);
}

function showProcessing(title: string, text: string, progress = 8): void {
  dom.processingTitle.textContent = title;
  dom.processingText.textContent = text;
  dom.processingProgress.style.width = `${progress}%`;
  dom.processingOverlay.classList.remove("is-hidden");
}

function updateProcessing(text: string, progress: number): void {
  dom.processingText.textContent = text;
  dom.processingProgress.style.width = `${progress}%`;
}

function hideProcessing(): void {
  dom.processingOverlay.classList.add("is-hidden");
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function toast(message: string, tone: "normal" | "warn" | "error" = "normal"): void {
  const node = document.createElement("div");
  node.className = `toast${tone === "normal" ? "" : ` is-${tone}`}`;
  node.textContent = message;
  dom.toastHost.append(node);
  window.setTimeout(() => {
    node.classList.add("is-leaving");
    window.setTimeout(() => node.remove(), 220);
  }, 3200);
}

const timeline = new TimelineCanvas(dom.timelineCanvas, {
  onSeek: (seconds) => seekFromView(seconds),
  onSelect: (id) => selectSegment(id),
  onViewChange: (start, duration) => {
    state.viewStart = start;
    state.viewDuration = duration;
    state.fit = duration >= activeDuration() - 0.002;
    refreshCanvas();
  },
  onZoomAt: (seconds, factor) => zoomAt(seconds, factor),
});

function activeDuration(): number {
  if (!state.source) return 0;
  if (state.view === "source") return state.source.channels[0].length / state.source.sampleRate;
  return state.render?.duration || state.source.channels[0].length / state.source.sampleRate;
}

function selectedSegment(): DetectedPause | null {
  return state.segments.find((segment) => segment.id === state.selectedId) || null;
}

function selectSegment(id: string | null): void {
  state.selectedId = id && state.segments.some((segment) => segment.id === id) ? id : null;
  updateSelection();
  renderSegmentList();
  refreshCanvas();
}

function outputToSource(seconds: number): number {
  if (!state.render || !state.source) return seconds;
  let sourceCursor = 0;
  let outputCursor = 0;
  for (const item of state.render.timeline) {
    if (seconds < item.outputStart) return sourceCursor + (seconds - outputCursor);
    if (seconds <= item.outputEnd) {
      const span = Math.max(1e-6, item.outputEnd - item.outputStart);
      const ratio = clamp((seconds - item.outputStart) / span, 0, 1);
      return item.segment.sourceStart + item.segment.duration * ratio;
    }
    sourceCursor = item.segment.sourceEnd;
    outputCursor = item.outputEnd;
  }
  return sourceCursor + (seconds - outputCursor);
}

function sourceToOutput(seconds: number): number {
  if (!state.render || !state.source) return seconds;
  let sourceCursor = 0;
  let outputCursor = 0;
  for (const item of state.render.timeline) {
    if (seconds < item.segment.sourceStart) return outputCursor + (seconds - sourceCursor);
    if (seconds <= item.segment.sourceEnd) {
      const span = Math.max(1e-6, item.segment.duration);
      const ratio = clamp((seconds - item.segment.sourceStart) / span, 0, 1);
      return item.outputStart + (item.outputEnd - item.outputStart) * ratio;
    }
    sourceCursor = item.segment.sourceEnd;
    outputCursor = item.outputEnd;
  }
  return outputCursor + (seconds - sourceCursor);
}

function buildWaveProject(): WaveProject | null {
  if (!state.source) return null;
  const useSource = state.view === "source";
  const peaks = useSource ? state.sourcePeaks : state.renderPeaks;
  if (!peaks) return null;
  const duration = activeDuration();
  const segments: WaveSegmentView[] = state.segments.map((segment) => {
    let start = segment.sourceStart;
    let end = segment.sourceEnd;
    if (!useSource) {
      const item = state.render?.timeline.find((entry) => entry.segment.id === segment.id);
      if (item) {
        start = item.outputStart;
        end = item.outputEnd;
      } else {
        start = sourceToOutput(segment.sourceStart);
        end = sourceToOutput(segment.sourceEnd);
      }
    }
    return {
      id: segment.id,
      start,
      end,
      sourceStart: segment.sourceStart,
      sourceEnd: segment.sourceEnd,
      originalDuration: segment.duration,
      targetMs: segment.targetMs,
      state: segment.state,
      kind: segment.kind,
    };
  });
  return {
    peaks,
    duration,
    segments,
    playhead: useSource ? outputToSource(state.playhead) : state.playhead,
    selectedId: state.selectedId,
    muted: state.muted,
    view: state.view,
  };
}

function refreshCanvas(): void {
  const project = buildWaveProject();
  if (!project) return;
  dom.canvasEmpty.classList.add("is-hidden");
  timeline.setProject(project, state.viewStart, state.viewDuration);
}

function fitTimeline(): void {
  const duration = Math.max(0.1, activeDuration());
  state.viewStart = 0;
  state.viewDuration = duration;
  state.fit = true;
  refreshCanvas();
}

function zoomAt(seconds: number, factor: number): void {
  if (!state.source) return;
  const total = Math.max(0.1, activeDuration());
  const oldSpan = Math.max(0.05, state.viewDuration);
  const newSpan = clamp(oldSpan / factor, Math.min(0.18, total), total);
  const anchor = clamp(seconds, state.viewStart, state.viewStart + oldSpan);
  const ratio = clamp((anchor - state.viewStart) / oldSpan, 0, 1);
  state.viewStart = clamp(anchor - ratio * newSpan, 0, Math.max(0, total - newSpan));
  state.viewDuration = newSpan;
  state.fit = newSpan >= total - 0.002;
  refreshCanvas();
}

function seekFromView(seconds: number): void {
  if (!state.source) return;
  const sourceTime = clamp(seconds, 0, activeDuration());
  const outputTime = state.view === "source" ? sourceToOutput(sourceTime) : sourceTime;
  state.playhead = clamp(outputTime, 0, state.render?.duration || 0);
  if (
    sourceTime < state.viewStart ||
    sourceTime > state.viewStart + state.viewDuration
  ) {
    state.viewStart = clamp(
      sourceTime - state.viewDuration / 2,
      0,
      Math.max(0, activeDuration() - state.viewDuration),
    );
  }
  updateTransport();
  refreshCanvas();
  if (engine.isPlaying()) {
    engine.pause();
    void engine.play(state.playhead).then(() => startAnimation());
  }
}

function scheduleRender(delay = 80): void {
  state.renderStale = true;
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    renderTimer = 0;
    renderNow();
  }, delay);
}

function renderNow(): void {
  if (!state.source) return;
  window.clearTimeout(renderTimer);
  renderTimer = 0;
  state.renderStale = false;
  const wasPlaying = engine.isPlaying();
  if (wasPlaying) {
    engine.pause();
    stopAnimation();
  }
  const rendered = renderProject(state.source, {
    targetMs: state.settings.targetMs,
    speed: state.speed,
    segments: state.segments,
  });
  state.render = rendered;
  state.renderPeaks = new PeakData(rendered.channels, rendered.sampleRate);
  engine.setRender(rendered);
  state.playhead = clamp(state.playhead, 0, rendered.duration);
  if (state.fit) {
    state.viewStart = 0;
    state.viewDuration =
      state.view === "source"
        ? state.source.channels[0].length / state.source.sampleRate
        : rendered.duration;
  } else {
    const total =
      state.view === "source"
        ? state.source.channels[0].length / state.source.sampleRate
        : rendered.duration;
    state.viewDuration = Math.min(state.viewDuration, total);
    state.viewStart = clamp(state.viewStart, 0, Math.max(0, total - state.viewDuration));
  }
  updateAllUI();
  refreshCanvas();
  if (wasPlaying) {
    void engine.play(state.playhead).then(() => startAnimation());
  }
}

function ensureRender(): void {
  if (state.renderStale || !state.render) renderNow();
}

const ACTION_ICONS = {
  play: '<svg viewBox="0 0 16 16"><path d="m5 3 8 5-8 5V3Z"/></svg>',
  bypass:
    '<svg viewBox="0 0 16 16"><path d="M4 3v10M12 3v10M6 8h4"/></svg>',
  undo: '<svg viewBox="0 0 16 16"><path d="M6 4 3 7l3 3M3 7h6.5A3.5 3.5 0 0 1 13 10.5V12"/></svg>',
};

function updateTransport(): void {
  dom.currentTime.textContent = formatTime(state.playhead);
  dom.durationTime.textContent = formatTime(state.render?.duration || 0);
  const playing = engine.isPlaying();
  dom.playButton.classList.toggle("is-playing", playing);
  dom.playButton.setAttribute("aria-label", playing ? "暂停" : "播放");
  dom.playButton.title = playing ? "暂停" : "播放";
}

function updateMeters(): void {
  if (!state.render || !engine.isPlaying()) {
    dom.meterLeft.style.width = "0%";
    dom.meterRight.style.width = "0%";
    return;
  }
  const sampleRate = state.render.sampleRate;
  const start = Math.max(0, Math.floor(state.playhead * sampleRate));
  const end = Math.min(state.render.channels[0].length, start + Math.round(sampleRate * 0.035));
  for (let channel = 0; channel < 2; channel += 1) {
    const samples = state.render.channels[Math.min(channel, state.render.channels.length - 1)];
    let energy = 0;
    for (let index = start; index < end; index += 2) energy += samples[index] * samples[index];
    const rms = Math.sqrt(energy / Math.max(1, (end - start) / 2));
    const db = rms > 0 ? 20 * Math.log10(rms) : -90;
    const width = clamp(((db + 60) / 58) * 100, 0, 100);
    (channel === 0 ? dom.meterLeft : dom.meterRight).style.width = `${width}%`;
  }
}

function updateStats(): void {
  let removed = 0;
  let active = 0;
  for (const segment of state.segments) {
    if (segment.state !== "active") continue;
    active += 1;
    removed += Math.max(0, segment.duration - Math.min(segment.duration, segment.targetMs / 1000));
  }
  dom.detectedCount.textContent = String(state.segments.length);
  dom.removedDuration.textContent = formatSeconds(removed);
  dom.segmentTabCount.textContent = String(state.segments.length);
  dom.segmentListCount.textContent = String(state.segments.length);
  dom.thresholdValue.textContent = `≥ ${state.settings.minSilenceMs} ms`;
  dom.targetValue.textContent = `${state.settings.targetMs} ms`;
  dom.thresholdRange.value = String(state.settings.minSilenceMs);
  dom.targetRange.value = String(state.settings.targetMs);
  dom.thresholdRange.setAttribute("aria-valuetext", `${state.settings.minSilenceMs} 毫秒`);
  dom.targetRange.setAttribute("aria-valuetext", `压缩至 ${state.settings.targetMs} 毫秒`);
  setRangeFill(dom.thresholdRange);
  setRangeFill(dom.targetRange);
  dom.segmentListEmpty.classList.toggle("is-hidden", state.segments.length > 0);
  dom.resetAllButton.disabled = active === state.segments.length && state.segments.length > 0;
}

function updateSelection(): void {
  const segment = selectedSegment();
  if (!segment) {
    dom.selectionEmpty.classList.remove("is-hidden");
    dom.selectionContent.classList.add("is-hidden");
    return;
  }
  dom.selectionEmpty.classList.add("is-hidden");
  dom.selectionContent.classList.remove("is-hidden");
  const index = state.segments.findIndex((item) => item.id === segment.id);
  dom.selectionKicker.textContent = `自动停顿 ${String(index + 1).padStart(2, "0")}`;
  dom.selectionTime.textContent = `${formatShortTime(segment.sourceStart)} — ${formatShortTime(segment.sourceEnd)}`;
  dom.selectionConfidence.textContent = `置信度 ${segment.confidence}%`;
  dom.selectionStatus.className = `status-pill ${segment.state}`;
  dom.selectionStatus.textContent =
    segment.state === "active" ? "已压缩" : segment.state === "bypassed" ? "已旁路" : "已撤销";
  dom.selectionOriginal.textContent = `${Math.round(segment.duration * 1000)} ms`;
  dom.selectionOutput.textContent =
    segment.state === "active"
      ? `${Math.round(Math.min(segment.duration * 1000, segment.targetMs))} ms`
      : `${Math.round(segment.duration * 1000)} ms`;
  dom.selectionLevel.textContent = `${segment.levelDb.toFixed(1)} dBFS`;
  dom.selectionTarget.value = String(segment.targetMs);
  dom.selectionTargetValue.textContent = `${segment.targetMs} ms`;
  setRangeFill(dom.selectionTarget);
  dom.bypassButton.textContent =
    segment.state === "active" ? "旁路此段" : segment.state === "bypassed" ? "恢复处理" : "重新启用";
  dom.undoSegmentButton.textContent = segment.state === "undone" ? "恢复此段" : "撤销此段";
}

function renderSegmentList(): void {
  dom.segmentList.replaceChildren();
  for (let index = 0; index < state.segments.length; index += 1) {
    const segment = state.segments[index];
    const row = document.createElement("article");
    row.className = "segment-row";
    row.classList.toggle("is-selected", segment.id === state.selectedId);
    row.classList.toggle("is-bypassed", segment.state === "bypassed");
    row.classList.toggle("is-undone", segment.state === "undone");
    row.dataset.id = segment.id;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "segment-main";
    main.title = "检查此停顿";

    const indexLabel = document.createElement("span");
    indexLabel.className = "segment-index";
    indexLabel.textContent = String(index + 1).padStart(2, "0");

    const time = document.createElement("span");
    time.className = "segment-time";
    time.textContent = `${formatShortTime(segment.sourceStart)} — ${formatShortTime(segment.sourceEnd)}`;

    const meta = document.createElement("span");
    meta.className = "segment-meta";
    const target = segment.state === "active" ? Math.round(segment.targetMs) : Math.round(segment.duration * 1000);
    meta.innerHTML = `${Math.round(segment.duration * 1000)} ms → <b>${target} ms</b> · ${segment.kind === "long" ? "长留白" : segment.kind === "breath" ? "呼吸感" : "干净停顿"}`;
    main.append(indexLabel, time, meta);
    main.addEventListener("click", () => selectSegment(segment.id));

    const actions = document.createElement("div");
    actions.className = "segment-actions";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "segment-action";
    preview.title = "试听处理";
    preview.setAttribute("aria-label", "试听处理");
    preview.innerHTML = ACTION_ICONS.play;
    preview.addEventListener("click", (event) => {
      event.stopPropagation();
      void auditionSegment(segment.id, "processed");
    });

    const bypass = document.createElement("button");
    bypass.type = "button";
    bypass.className = `segment-action${segment.state === "bypassed" ? " is-on" : ""}`;
    bypass.title = segment.state === "bypassed" ? "恢复处理" : "旁路";
    bypass.setAttribute("aria-label", bypass.title);
    bypass.innerHTML = ACTION_ICONS.bypass;
    bypass.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleBypass(segment.id);
    });

    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "segment-action";
    undo.title = segment.state === "undone" ? "恢复此段" : "撤销此段";
    undo.setAttribute("aria-label", undo.title);
    undo.innerHTML = ACTION_ICONS.undo;
    undo.addEventListener("click", (event) => {
      event.stopPropagation();
      undoOneSegment(segment.id);
    });
    actions.append(preview, bypass, undo);
    row.append(main, actions);
    dom.segmentList.append(row);
  }
  updateStats();
}

function updatePublishPanel(): void {
  dom.publishSampleRate.textContent = state.source ? `${(state.source.sampleRate / 1000).toFixed(1)} kHz` : "—";
  dom.publishDuration.textContent = state.render ? formatTime(state.render.duration) : "—";
  dom.estimateLufs.textContent = state.loudnessTarget.toFixed(1).replace("-", "−");
  dom.loudnessTarget.value = String(state.loudnessTarget);
}

function updateHeader(): void {
  if (!state.source) return;
  const source = state.source;
  const channelLabel = source.channels.length === 2 ? "双轨立体声" : "单轨";
  const formatLabel = source.format === "float" ? "Float" : source.format === "demo" ? "Demo PCM" : "PCM";
  dom.projectName.textContent = source.name;
  dom.projectMeta.textContent = `${channelLabel} · ${(source.sampleRate / 1000).toFixed(1)} kHz · ${source.bitDepth}-bit ${formatLabel} · ${formatSeconds(source.channels[0].length / source.sampleRate)} · ${formatFileSize(source.originalBytes)}`;
  dom.demoBadge.classList.toggle("is-hidden", !source.isDemo);
  dom.sourceStamp.textContent = "ORIGINAL · READ ONLY";
  dom.trackAMeta.textContent = source.channels.length > 1 ? "CH 1" : "MONO";
  dom.trackBMeta.textContent = source.channels.length > 1 ? "CH 2" : "MIRROR";
  for (const tab of document.querySelectorAll<HTMLElement>(".timeline-tab")) {
    if (!(tab instanceof HTMLButtonElement)) continue;
    tab.classList.toggle("is-active", tab.dataset.view === state.view);
  }
}

function updateAllUI(): void {
  if (!state.source) return;
  updateHeader();
  updateTransport();
  renderSegmentList();
  updateSelection();
  updatePublishPanel();
  for (const button of dom.speedControl.querySelectorAll<HTMLButtonElement>("button")) {
    button.classList.toggle("is-active", Number(button.dataset.speed) === state.speed);
  }
  dom.exportButton.disabled = false;
  dom.publishExportButton.disabled = false;
}

function resetHistory(): void {
  state.history = [];
}

function snapshotState(): HistorySnapshot {
  return {
    selectedId: state.selectedId,
    settings: { ...state.settings },
    segments: state.segments.map((segment) => ({
      id: segment.id,
      state: segment.state,
      targetMs: segment.targetMs,
    })),
  };
}

function pushHistory(): void {
  state.history.push(snapshotState());
  if (state.history.length > 40) state.history.shift();
}

function restoreHistory(): void {
  const snapshot = state.history.pop();
  if (!snapshot) {
    toast("没有可撤销的编辑操作", "warn");
    return;
  }
  state.settings = { ...snapshot.settings };
  for (const segment of state.segments) {
    const previous = snapshot.segments.find((entry) => entry.id === segment.id);
    if (!previous) continue;
    segment.state = previous.state;
    segment.targetMs = previous.targetMs;
  }
  state.selectedId = snapshot.selectedId;
  renderNow();
  toast("已撤销上一次片段操作");
}

function toggleBypass(id: string): void {
  const segment = state.segments.find((item) => item.id === id);
  if (!segment) return;
  pushHistory();
  segment.state = segment.state === "active" ? "bypassed" : "active";
  state.selectedId = id;
  renderNow();
  toast(
    segment.state === "bypassed"
      ? `停顿 ${state.segments.indexOf(segment) + 1} 已旁路，原留白完整保留`
      : `停顿 ${state.segments.indexOf(segment) + 1} 已恢复压缩`,
    segment.state === "bypassed" ? "warn" : "normal",
  );
}

function undoOneSegment(id: string): void {
  const segment = state.segments.find((item) => item.id === id);
  if (!segment) return;
  pushHistory();
  segment.state = segment.state === "undone" ? "active" : "undone";
  state.selectedId = id;
  renderNow();
  toast(
    segment.state === "undone"
      ? `已撤销停顿 ${state.segments.indexOf(segment) + 1} 的自动判断`
      : `已恢复停顿 ${state.segments.indexOf(segment) + 1} 的自动压缩`,
    segment.state === "undone" ? "warn" : "normal",
  );
}

let detectTimer = 0;

function runDetection(resetStates = true, notify = false): void {
  if (!state.source) return;
  const detected = detectPauses(state.source, state.settings);
  if (resetStates) {
    state.segments = detected.map((segment) => ({
      ...segment,
      targetMs: state.settings.targetMs,
      state: "active",
    }));
    state.selectedId = state.segments[0]?.id || null;
    resetHistory();
  } else {
    const previous = new Map(state.segments.map((segment) => [segment.id, segment]));
    state.segments = detected.map((segment, index) => {
      const old = previous.get(segment.id);
      return {
        ...segment,
        id: old?.id || `pause-${index + 1}`,
        targetMs: old?.targetMs || state.settings.targetMs,
        state: old?.state || "active",
      };
    });
    state.selectedId = state.segments[0]?.id || null;
  }
  renderNow();
  if (notify) {
    toast(
      state.segments.length > 0
        ? `重新分析完成，找到 ${state.segments.length} 处长停顿`
        : "重新分析完成，没有发现超过阈值的停顿",
      state.segments.length > 0 ? "normal" : "warn",
    );
  }
}

function scheduleDetection(): void {
  window.clearTimeout(detectTimer);
  detectTimer = window.setTimeout(() => {
    detectTimer = 0;
    runDetection(true, false);
  }, 220);
}

function showWorkspace(): void {
  dom.welcome.classList.add("is-hidden");
  dom.workspace.classList.remove("is-hidden");
  dom.timelineCanvas.style.cursor = "crosshair";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function loadSource(source: AudioSource): void {
  engine.stop();
  window.clearTimeout(renderTimer);
  window.clearTimeout(detectTimer);
  renderTimer = 0;
  detectTimer = 0;
  if (state.exportUrl) URL.revokeObjectURL(state.exportUrl);
  state.exportUrl = null;
  closeExportSheet();
  dom.downloadButton.disabled = true;
  state.source = source;
  state.sourcePeaks = new PeakData(source.channels, source.sampleRate);
  state.render = null;
  state.renderPeaks = null;
  state.speed = 1;
  state.view = "edited";
  state.playhead = 0;
  state.fit = true;
  state.muted = [false, false];
  state.exportUrl = null;
  state.settings = { minSilenceMs: 800, targetMs: 250, smartProtection: true };
  state.segments = detectPauses(source, state.settings).map((segment) => ({
    ...segment,
    targetMs: state.settings.targetMs,
  }));
  state.selectedId = state.segments[0]?.id || null;
  resetHistory();
  for (const button of document.querySelectorAll<HTMLElement>(".track-mute")) {
    button.classList.remove("is-muted");
    if (button instanceof HTMLButtonElement) {
      button.title = `静音轨道 ${Number(button.dataset.track) === 0 ? "A" : "B"}`;
      button.setAttribute("aria-label", button.title);
    }
  }
  showWorkspace();
  renderNow();
  fitTimeline();
  dom.canvasEmpty.classList.add("is-hidden");
  toast(
    state.segments.length > 0
      ? `已识别 ${state.segments.length} 处低能量停顿 · 原文件保持只读`
      : "未发现超过 800 ms 的低能量停顿",
  );
}

function fileNameWithoutExtension(name: string): string {
  return name.replace(/\.wav$/i, "").replace(/[\\/:*?"<>|]+/g, "-");
}

async function handleFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  if (list.length === 0) return;
  if (list.length > 2) {
    toast("最多同时导入两个单轨 WAV，或一个双轨 WAV", "error");
    return;
  }
  for (const file of list) {
    if (!/\.wav$/i.test(file.name) && !/wav/i.test(file.type)) {
      toast(`“${file.name}” 不是 WAV 文件`, "error");
      return;
    }
  }

  showProcessing("正在读取 WAV", "文件只在本机内存中解码…", 13);
  await nextPaint();
  try {
    const buffers = await Promise.all(list.map((file) => file.arrayBuffer()));
    updateProcessing("校验 RIFF 与采样格式…", 36);
    await nextPaint();
    const decoded = buffers.map((buffer, index) => decodeWav(buffer, list[index].name));
    updateProcessing("配对轨道并分析环境底噪…", 62);
    await nextPaint();
    const displayName =
      decoded.length === 1
        ? decoded[0].name
        : `${fileNameWithoutExtension(decoded[0].name)} + ${fileNameWithoutExtension(decoded[1].name)}`;
    const paired = pairTracks(decoded, displayName);
    updateProcessing("建立时间线与波形峰值…", 82);
    await nextPaint();
    loadSource(paired);
    updateProcessing("完成", 100);
    await nextPaint();
    hideProcessing();
  } catch (error) {
    hideProcessing();
    const message = error instanceof Error ? error.message : "无法读取音频文件";
    toast(message, "error");
  }
}

async function loadDemo(): Promise<void> {
  showProcessing("正在展开演示工程", "合成一段带有笑声、语气词与长留白的双轨音频…", 38);
  await nextPaint();
  try {
    const demo = generateDemoAudio();
    updateProcessing("检测低能量停顿…", 72);
    await nextPaint();
    loadSource(demo);
    updateProcessing("完成", 100);
    await nextPaint();
    hideProcessing();
    toast("演示工程已载入 · 拖入自己的 WAV 即可替换");
  } catch (error) {
    hideProcessing();
    toast(error instanceof Error ? error.message : "演示工程载入失败", "error");
  }
}

function stopAnimation(): void {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
}

function startAnimation(): void {
  stopAnimation();
  let lastPaint = 0;
  const tick = (now: number): void => {
    if (!state.render) return;
    state.playhead = clamp(engine.getPosition(), 0, state.render.duration);
    updateTransport();
    updateMeters();
    if (now - lastPaint > 32) {
      refreshCanvas();
      lastPaint = now;
    }
    if (engine.isPlaying()) animationFrame = requestAnimationFrame(tick);
    else {
      animationFrame = 0;
      updateTransport();
      updateMeters();
      refreshCanvas();
    }
  };
  animationFrame = requestAnimationFrame(tick);
}

async function togglePlayback(): Promise<void> {
  if (!state.source) return;
  if (engine.isPlaying()) {
    state.playhead = engine.pause();
    stopAnimation();
    updateTransport();
    updateMeters();
    refreshCanvas();
    return;
  }
  ensureRender();
  if (!state.render) return;
  if (state.playhead >= state.render.duration - 0.015) state.playhead = 0;
  try {
    state.playhead = await engine.play(state.playhead);
    startAnimation();
    updateTransport();
  } catch {
    toast("浏览器未能启动 WebAudio 播放", "error");
  }
}

engine.onEnded = () => {
  if (state.render) state.playhead = state.render.duration;
  stopAnimation();
  updateTransport();
  updateMeters();
  refreshCanvas();
};

async function auditionSegment(
  id: string,
  mode: "original" | "processed",
): Promise<void> {
  const segment = state.segments.find((item) => item.id === id);
  if (!segment || !state.source) return;
  ensureRender();
  if (!state.render) return;
  engine.pause();
  stopAnimation();
  selectSegment(id);
  const contextLength = 0.42;
  let channels: Float32Array[];
  let sampleRate: number;
  let start: number;
  let end: number;

  if (mode === "original") {
    channels = state.source.channels;
    sampleRate = state.source.sampleRate;
    const duration = state.source.channels[0].length / sampleRate;
    start = Math.max(0, segment.sourceStart - contextLength);
    end = Math.min(duration, segment.sourceEnd + contextLength);
  } else {
    const item = state.render.timeline.find((entry) => entry.segment.id === id);
    if (!item) return;
    channels = state.render.channels;
    sampleRate = state.render.sampleRate;
    start = Math.max(0, item.outputStart - contextLength);
    end = Math.min(state.render.duration, item.outputEnd + contextLength);
  }
  if (end - start < 0.02) {
    toast("这个片段太短，无法试听", "warn");
    return;
  }
  try {
    await engine.playClip(channels, sampleRate, start, end - start);
    toast(mode === "original" ? "正在试听原始留白" : "正在试听处理后的留白");
  } catch {
    toast("试听播放失败", "error");
  }
}

async function setSpeed(speed: number): Promise<void> {
  if (!state.source || speed === state.speed) return;
  const sourcePosition = outputToSource(state.playhead);
  engine.pause();
  stopAnimation();
  showProcessing(
    "正在保持音高变速",
    `${speed.toFixed(2)}× · 相位声码器正在重排时间…`,
    24,
  );
  await nextPaint();
  try {
    state.speed = speed;
    state.renderStale = true;
    renderNow();
    state.playhead = clamp(sourceToOutput(sourcePosition), 0, state.render?.duration || 0);
    updateTransport();
    refreshCanvas();
    updateAllUI();
    updateProcessing("完成", 100);
    await nextPaint();
    hideProcessing();
    toast(`整段已切换为 ${speed}×，音高保持不变`);
  } catch (error) {
    hideProcessing();
    toast(error instanceof Error ? error.message : "变速处理失败", "error");
  }
}

function setTimelineView(view: "edited" | "source"): void {
  if (state.view === view) return;
  engine.pause();
  stopAnimation();
  state.view = view;
  state.fit = true;
  fitTimeline();
  updateHeader();
  updateTransport();
  refreshCanvas();
}

function toggleMute(channel: number): void {
  if (channel < 0 || channel > 1) return;
  state.muted[channel] = !state.muted[channel];
  engine.setMuted(channel, state.muted[channel]);
  for (const button of document.querySelectorAll<HTMLButtonElement>(".track-mute")) {
    if (Number(button.dataset.track) !== channel) continue;
    button.classList.toggle("is-muted", state.muted[channel]);
    button.title = `${state.muted[channel] ? "取消静音" : "静音"}轨道 ${channel === 0 ? "A" : "B"}`;
    button.setAttribute("aria-label", button.title);
  }
  refreshCanvas();
}

function closeExportSheet(): void {
  dom.exportSheet.classList.add("is-hidden");
}

function exportProduction(): void {
  if (!state.source) return;
  void (async () => {
    engine.pause();
    stopAnimation();
    closeExportSheet();
    showProcessing(
      "正在测量节目响度",
      `按 ITU-R BS.1770 门控积分，目标 ${state.loudnessTarget} LUFS…`,
      19,
    );
    await nextPaint();
    try {
      ensureRender();
      if (!state.render) throw new Error("成片尚未生成");
      if (state.muted[0] && (state.source.channels.length === 1 || state.muted[1])) {
        throw new Error("两个轨道都处于静音状态，没有可导出的内容");
      }
      updateProcessing("应用真峰值限制器与 24-bit 量化…", 55);
      await nextPaint();
      const deliveryChannels = state.render.channels.map((channel, index) =>
        state.muted[index] ? new Float32Array(channel.length) : channel,
      );
      const mastered = masterAudio(
        deliveryChannels,
        state.render.sampleRate,
        state.loudnessTarget,
        -1,
      );
      if (!Number.isFinite(mastered.integratedLufs)) {
        throw new Error("整段音频接近静音，无法测量响度");
      }
      const wav = encodeWav24(mastered.channels, state.render.sampleRate);
      const blob = new Blob([wav], { type: "audio/wav" });
      if (state.exportUrl) URL.revokeObjectURL(state.exportUrl);
      state.exportUrl = URL.createObjectURL(blob);
      const loudnessLabel = Math.abs(Math.round(state.loudnessTarget));
      const speedLabel = state.speed.toFixed(2).replace(".", "_");
      state.exportName = `${fileNameWithoutExtension(state.source.name)}.pausecut-${loudnessLabel}LUFS-${speedLabel}x.wav`;
      state.exportMeta = `${(wav.byteLength / (1024 * 1024)).toFixed(1)} MB · 24-bit PCM · ${
        state.source.sampleRate
      } Hz`;
      dom.exportLufs.textContent = mastered.integratedLufs.toFixed(1).replace("-", "−");
      dom.exportPeak.textContent = mastered.truePeakDb.toFixed(1).replace("-", "−");
      dom.exportDuration.textContent = formatTime(state.render.duration);
      dom.exportSaved.textContent = state.render.removedSeconds.toFixed(2);
      dom.exportFileName.textContent = state.exportMeta;
      dom.exportSafeName.textContent = state.exportName;
      dom.downloadButton.disabled = false;
      updateProcessing("WAV 已封装", 100);
      await nextPaint();
      hideProcessing();
      dom.exportSheet.classList.remove("is-hidden");
    } catch (error) {
      hideProcessing();
      toast(error instanceof Error ? error.message : "导出失败", "error");
    }
  })();
}

function downloadExport(): void {
  if (!state.exportUrl || !state.exportName) {
    toast("还没有可下载的成片", "warn");
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = state.exportUrl;
  anchor.download = state.exportName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  toast("WAV 已下载 · 原文件未被改动");
}

function openFilePicker(): void {
  dom.fileInput.value = "";
  dom.fileInput.click();
}

dom.importButton.addEventListener("click", openFilePicker);
dom.welcomeImportButton.addEventListener("click", openFilePicker);
dom.dropCard.addEventListener("click", openFilePicker);
dom.fileInput.addEventListener("change", () => {
  if (dom.fileInput.files) void handleFiles(dom.fileInput.files);
});
dom.demoButton.addEventListener("click", () => void loadDemo());
dom.exportButton.addEventListener("click", exportProduction);
dom.publishExportButton.addEventListener("click", exportProduction);

dom.playButton.addEventListener("click", () => void togglePlayback());
dom.toStartButton.addEventListener("click", () => {
  state.playhead = 0;
  if (engine.isPlaying()) {
    engine.pause();
    void engine.play(0).then(() => startAnimation());
  }
  updateTransport();
  refreshCanvas();
});
dom.toEndButton.addEventListener("click", () => {
  engine.pause();
  stopAnimation();
  state.playhead = state.render?.duration || 0;
  updateTransport();
  updateMeters();
  refreshCanvas();
});

for (const button of dom.speedControl.querySelectorAll<HTMLButtonElement>("button")) {
  button.addEventListener("click", () => {
    void setSpeed(Number(button.dataset.speed) || 1);
  });
}

for (const tab of document.querySelectorAll<HTMLButtonElement>(".side-tab")) {
  tab.addEventListener("click", () => {
    for (const item of document.querySelectorAll<HTMLButtonElement>(".side-tab")) {
      item.classList.toggle("is-active", item === tab);
    }
    document
      .getElementById("segmentsPanel")
      ?.classList.toggle("is-hidden", tab.dataset.tab !== "segments");
    document
      .getElementById("publishPanel")
      ?.classList.toggle("is-hidden", tab.dataset.tab !== "publish");
  });
}

for (const tab of document.querySelectorAll<HTMLButtonElement>(".timeline-tab")) {
  tab.addEventListener("click", () => {
    setTimelineView(tab.dataset.view === "source" ? "source" : "edited");
  });
}

dom.zoomInButton.addEventListener("click", () => {
  zoomAt(state.viewStart + state.viewDuration / 2, 1.6);
});
dom.zoomOutButton.addEventListener("click", () => {
  zoomAt(state.viewStart + state.viewDuration / 2, 1 / 1.6);
});
dom.zoomFitButton.addEventListener("click", fitTimeline);

for (const button of document.querySelectorAll<HTMLButtonElement>(".track-mute")) {
  button.addEventListener("click", () => toggleMute(Number(button.dataset.track)));
}

dom.thresholdRange.addEventListener("input", () => {
  state.settings.minSilenceMs = Number(dom.thresholdRange.value);
  updateStats();
  scheduleDetection();
});
dom.thresholdRange.addEventListener("change", () => {
  window.clearTimeout(detectTimer);
  detectTimer = 0;
  runDetection(true, true);
});

dom.targetRange.addEventListener("input", () => {
  state.settings.targetMs = Number(dom.targetRange.value);
  for (const segment of state.segments) segment.targetMs = state.settings.targetMs;
  updateStats();
  updateSelection();
  scheduleRender(110);
});
dom.targetRange.addEventListener("change", () => {
  window.clearTimeout(renderTimer);
  renderTimer = 0;
  renderNow();
});

dom.smartProtection.addEventListener("change", () => {
  state.settings.smartProtection = dom.smartProtection.checked;
  scheduleDetection();
});

dom.reanalyzeButton.addEventListener("click", () => {
  void (async () => {
    showProcessing("正在重新分析留白", "重新估计底噪、空穴与停顿边界…", 30);
    await nextPaint();
    runDetection(true, true);
    updateProcessing("完成", 100);
    await nextPaint();
    hideProcessing();
  })();
});

dom.selectionTarget.addEventListener("input", () => {
  const segment = selectedSegment();
  if (!segment) return;
  segment.targetMs = Number(dom.selectionTarget.value);
  dom.selectionTargetValue.textContent = `${segment.targetMs} ms`;
  setRangeFill(dom.selectionTarget);
  updateStats();
  scheduleRender(110);
});
dom.selectionTarget.addEventListener("change", () => {
  window.clearTimeout(renderTimer);
  renderTimer = 0;
  renderNow();
});

dom.previewOriginalButton.addEventListener("click", () => {
  if (state.selectedId) void auditionSegment(state.selectedId, "original");
});
dom.previewProcessedButton.addEventListener("click", () => {
  if (state.selectedId) void auditionSegment(state.selectedId, "processed");
});
dom.bypassButton.addEventListener("click", () => {
  if (state.selectedId) toggleBypass(state.selectedId);
});
dom.undoSegmentButton.addEventListener("click", () => {
  if (state.selectedId) undoOneSegment(state.selectedId);
});
dom.resetAllButton.addEventListener("click", () => {
  if (state.segments.length === 0) return;
  pushHistory();
  for (const segment of state.segments) segment.state = "active";
  renderNow();
  toast("全部自动停顿已恢复为压缩状态");
});

dom.loudnessTarget.addEventListener("change", () => {
  state.loudnessTarget = Number(dom.loudnessTarget.value);
  updatePublishPanel();
});
dom.downloadButton.addEventListener("click", downloadExport);
dom.sheetClose.addEventListener("click", closeExportSheet);
dom.keepEditingButton.addEventListener("click", closeExportSheet);
dom.sheetBackdrop.addEventListener("click", closeExportSheet);

document.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  dragDepth += 1;
  dom.dragOverlay.classList.remove("is-hidden");
});
document.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dom.dragOverlay.classList.add("is-hidden");
});
document.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  dragDepth = 0;
  dom.dragOverlay.classList.add("is-hidden");
  void handleFiles(event.dataTransfer.files);
});

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable ||
    target.closest("button") !== null
  );
}

document.addEventListener("keydown", (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === "o") {
    event.preventDefault();
    openFilePicker();
    return;
  }
  if (modifier && event.key.toLowerCase() === "z" && !isTextInput(event.target)) {
    event.preventDefault();
    restoreHistory();
    return;
  }
  if (event.key === "Escape") {
    closeExportSheet();
    return;
  }
  if (event.code === "Space" && !isTextInput(event.target) && !event.repeat) {
    event.preventDefault();
    void togglePlayback();
  }
});

setRangeFill(dom.thresholdRange);
setRangeFill(dom.targetRange);
setRangeFill(dom.selectionTarget);
updateTransport();
dom.downloadButton.disabled = true;

if (window.location.hash === "#demo") {
  void loadDemo();
}
