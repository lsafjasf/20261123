import { DEFAULT_SETTINGS } from "./core/interpolation.js";
import { buildFrameSchedule } from "./core/timeline.js";
import type {
  FrameScheduleEntry,
  InterpolationSettings
} from "./core/types.js";
import { PreviewClock } from "./browser/clock.js";
import {
  exportInterpolatedVideo,
  exportSupported,
  playWithMediaSource
} from "./browser/exporter.js";
import { PreviewInterpolator, type PreparedPreview } from "./browser/interpolator.js";
import {
  PreviewRenderer,
  TimelineView,
  type CompareMode
} from "./browser/renderer.js";
import {
  createVideoFrameProvider,
  SyntheticFrameProvider,
  type FrameProvider
} from "./browser/sources.js";
import { runValidation } from "./browser/validation.js";

const TARGET_FPS = 60;
const SYNTHETIC_START_SECONDS = 1.2;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const canvas = element<HTMLCanvasElement>("previewCanvas");
const timelineCanvas = element<HTMLCanvasElement>("timelineCanvas");
const previewRenderer = new PreviewRenderer(canvas);
const timelineView = new TimelineView(timelineCanvas);
const rendererClock = new PreviewClock(element<HTMLAudioElement>("sourceAudio"));
const fileInput = element<HTMLInputElement>("fileInput");
const playButton = element<HTMLButtonElement>("playButton");
const playIcon = element<HTMLElement>("playIcon");
const importButton = element<HTMLButtonElement>("importButton");
const exportButton = element<HTMLButtonElement>("exportButton");
const resetButton = element<HTMLButtonElement>("resetSynthetic");
const processingBadge = element<HTMLElement>("processingBadge");
const toastElement = element<HTMLElement>("toast");
const mediaModal = element<HTMLElement>("mediaModal");
const exportVideo = element<HTMLVideoElement>("exportVideo");
const downloadLink = element<HTMLAnchorElement>("downloadLink");
const modal = {
  close: element<HTMLButtonElement>("closeModal"),
  meta: element<HTMLElement>("exportMeta")
};

let provider: FrameProvider = new SyntheticFrameProvider();
let schedule = buildSchedule(provider);
let settings: InterpolationSettings = cloneSettings(DEFAULT_SETTINGS);
let interpolator = new PreviewInterpolator(provider, settings);
let compareMode: CompareMode = "wipe";
let split = 0.5;
let currentIndex = secondsToIndex(SYNTHETIC_START_SECONDS);
let lastPrepared: PreparedPreview | null = null;
let showOcclusion = true;
let playbackRate = 1;
let rendering = false;
let renderQueued = false;
let renderBusy = false;
let settingsTimer = 0;
let dragMode: "split" | "roi" | null = null;
let dragOrigin = { x: 0, y: 0, regionX: 0, regionY: 0, regionW: 0, regionH: 0 };
let timelineDragging = false;
let exportUrl: string | null = null;
let exportCleanup: (() => void) | null = null;
let toastTimer = 0;

function cloneSettings(source: InterpolationSettings): InterpolationSettings {
  return {
    ...source,
    region: { ...source.region }
  };
}

function buildSchedule(source: FrameProvider) {
  return buildFrameSchedule({
    sourceFps: source.info.fps,
    targetFps: TARGET_FPS,
    sourceFrameCount: source.info.frameCount
  });
}

function secondsToIndex(seconds: number): number {
  return Math.max(0, Math.min(schedule.length - 1, Math.floor(seconds * TARGET_FPS + 1e-7)));
}

function currentEntry(): FrameScheduleEntry {
  return schedule[Math.max(0, Math.min(schedule.length - 1, currentIndex))];
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function formatUs(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)} µs`;
}

function showToast(message: string, duration = 2800): void {
  toastElement.textContent = message;
  toastElement.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastElement.classList.remove("visible"), duration);
}

function setProcessing(visible: boolean, label = "ANALYZING FRAME"): void {
  processingBadge.innerHTML = `<i></i>${label}`;
  processingBadge.classList.toggle("visible", visible);
}

function updateSliderFill(input: HTMLInputElement): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value);
  const percentage = max === min ? 0 : (value - min) / (max - min) * 100;
  input.style.setProperty("--fill", `${percentage}%`);
}

function refreshAllSliders(): void {
  document.querySelectorAll<HTMLInputElement>(".slider").forEach(updateSliderFill);
}

function setPlayingState(playing: boolean): void {
  playIcon.textContent = playing ? "❚❚" : "▶";
  playButton.classList.toggle("playing", playing);
  playButton.setAttribute("aria-label", playing ? "暂停" : "播放");
}

function setRegionMeta(): void {
  const region = settings.region;
  element("regionMeta").textContent =
    `X ${Math.round(region.x * 100)}% · Y ${Math.round(region.y * 100)}% · ` +
    `W ${Math.round(region.width * 100)}% · H ${Math.round(region.height * 100)}%`;
}

function updateGuardStatus(): void {
  const label =
    settings.maxDisplacement <= 24
      ? "CONSERVATIVE"
      : settings.maxDisplacement >= 66
        ? "WIDE SEARCH"
        : "BALANCED";
  element("guardStatus").textContent = label;
}

function drawPrepared(prepared: PreparedPreview): void {
  previewRenderer.draw({
    before: prepared.displayBefore,
    output: prepared.result.frame,
    occlusionEdgeMask: prepared.result.occlusionEdgeMask,
    entry: prepared.entry,
    stats: prepared.result.stats,
    mode: compareMode,
    split,
    showOcclusion,
    region: settings.region,
    sourceLabel: provider.info.name,
    targetFps: TARGET_FPS
  });
  updateReadout(prepared);
}

function updateReadout(prepared: PreparedPreview): void {
  const entry = prepared.entry;
  const previous = schedule[Math.max(0, entry.index - 1)];
  const intervalUs = entry.index === 0
    ? 1_000_000 / TARGET_FPS
    : entry.timestampUs - previous.timestampUs;
  const idealUs = 1_000_000 / TARGET_FPS;
  const errorUs = intervalUs - idealUs;
  element("sourcePair").textContent =
    `#${String(entry.sourceIndex).padStart(3, "0")} → #${String(entry.nextSourceIndex).padStart(3, "0")}`;
  element("sourceTimes").textContent =
    `${(entry.sourceIndex / provider.info.fps).toFixed(3)}s → ${(entry.nextSourceIndex / provider.info.fps).toFixed(3)}s`;
  element("outputFrame").textContent = `#${String(entry.index).padStart(4, "0")}`;
  element("outputTime").textContent = `${entry.timeSec.toFixed(4)}s`;
  element("phaseValue").textContent = entry.sourcePhase.toFixed(3);
  element("phasePercent").textContent = `${Math.round(entry.sourcePhase * 100)}%`;
  element("phaseBar").style.width = `${entry.sourcePhase * 100}%`;
  element("intervalValue").textContent = `${(intervalUs / 1000).toFixed(3)} ms`;
  element("intervalError").textContent = `误差 ${formatUs(errorUs)} · 顺序 ✓`;
  const stats = prepared.result.stats;
  element("confidenceValue").textContent = `${Math.round(stats.averageConfidence * 100)}%`;
  element("guardedValue").textContent =
    `${(stats.occludedPixels / (prepared.result.frame.width * prepared.result.frame.height) * 100).toFixed(1)}%`;
  element("computeValue").textContent = `${prepared.computeMs.toFixed(0)} ms`;
}

function updateClockUi(): void {
  const entry = currentEntry();
  element("timecode").textContent = formatTime(entry.timeSec);
  element("durationLabel").textContent = `/ ${formatTime(provider.info.durationSec)}`;
  element("sourceName").textContent = provider.info.name;
  timelineView.draw({
    info: provider.info,
    schedule,
    index: currentIndex,
    region: settings.region
  });
}

function drawCurrentStateOnly(): void {
  if (lastPrepared && lastPrepared.entry.index === currentIndex) {
    previewRenderer.draw({
      before: lastPrepared.displayBefore,
      output: lastPrepared.result.frame,
      occlusionEdgeMask: lastPrepared.result.occlusionEdgeMask,
      entry: lastPrepared.entry,
      stats: lastPrepared.result.stats,
      mode: compareMode,
      split,
      showOcclusion,
      region: settings.region,
      sourceLabel: provider.info.name,
      targetFps: TARGET_FPS
    });
  }
  updateClockUi();
}

function requestRender(busy = false): void {
  renderQueued = true;
  renderBusy = renderBusy || busy;
  if (!rendering) void drainRenderQueue();
}

async function drainRenderQueue(): Promise<void> {
  if (rendering) return;
  rendering = true;
  try {
    while (renderQueued) {
      renderQueued = false;
      const wantBusy = renderBusy;
      renderBusy = false;
      const index = currentIndex;
      const entry = schedule[index];
      if (!entry) continue;
      if (wantBusy) setProcessing(true);
      try {
        const prepared = await interpolator.prepare(entry);
        if (index !== currentIndex) {
          renderQueued = true;
          continue;
        }
        lastPrepared = prepared;
        drawPrepared(prepared);
        updateClockUi();
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "stale-preview") {
          showToast(error instanceof Error ? error.message : "帧处理失败");
        }
      } finally {
        if (wantBusy) setProcessing(false);
      }
    }
  } finally {
    rendering = false;
  }
}

function readSettingsFromControls(): void {
  const roiToggle = element<HTMLInputElement>("roiToggle");
  settings = {
    ...settings,
    blockSize: Number(element<HTMLInputElement>("blockSize").value),
    maxDisplacement: Number(element<HTMLInputElement>("maxDisplacement").value),
    occlusionThreshold: Number(element<HTMLInputElement>("occlusionThreshold").value),
    region: {
      ...settings.region,
      enabled: roiToggle.checked,
      strength: Number(element<HTMLInputElement>("roiStrength").value) / 100,
      feather: Number(element<HTMLInputElement>("roiFeather").value) / 100
    }
  };
  interpolator.updateSettings(settings);
  element("maxDisplacementValue").textContent = `${settings.maxDisplacement} px`;
  element("occlusionThresholdValue").textContent = `${settings.occlusionThreshold.toFixed(1)} px`;
  element("blockSizeValue").textContent = `${settings.blockSize} px`;
  element("roiStrengthValue").textContent = `${Math.round(settings.region.strength * 100)}%`;
  element("roiFeatherValue").textContent = `${(settings.region.feather * 100).toFixed(1)}%`;
  refreshAllSliders();
  setRegionMeta();
  updateGuardStatus();
  updateClockUi();
}

function queueSettingsRender(): void {
  window.clearTimeout(settingsTimer);
  settingsTimer = window.setTimeout(() => requestRender(true), 75);
}

function applyProvider(nextProvider: FrameProvider, startSeconds = 0): void {
  rendererClock.pause(0);
  rendererClock.setMedia(null);
  provider.dispose();
  provider = nextProvider;
  rendererClock.setMedia(provider.info.mediaUrl);
  schedule = buildSchedule(provider);
  currentIndex = Math.min(
    schedule.length - 1,
    Math.max(0, Math.floor(startSeconds * TARGET_FPS))
  );
  interpolator.updateProvider(provider);
  interpolator.updateSettings(settings);
  lastPrepared = null;
  setPlayingState(false);
  element("sourceKind").textContent =
    provider.info.kind === "synthetic" ? "SYNTHETIC TEST SEQUENCE" : "LOCAL VIDEO · 24P SAMPLE";
  element("sequenceTag").textContent =
    provider.info.kind === "synthetic" ? "TRANSLATE + ROTATE" : "LOCAL 24P SOURCE";
  element("stageTitle").innerHTML =
    provider.info.kind === "synthetic"
      ? "平移 × 旋转 <span>插值预览</span>"
      : "本地素材 <span>插值预览</span>";
  element("viewerHint").textContent =
    settings.region.enabled
      ? "拖动画框选择局部 · 靠近中线可拖动对比"
      : "拖动中线对比 · 开启局部后可在画面框选";
  updateClockUi();
  requestRender(true);
}

function loadSynthetic(): void {
  const synthetic = new SyntheticFrameProvider();
  settings.region.enabled = false;
  element<HTMLInputElement>("roiToggle").checked = false;
  applyProvider(synthetic, SYNTHETIC_START_SECONDS);
  setProcessing(true, "GENERATING SEQUENCE");
  showToast("已载入程序生成的平移 + 旋转序列");
}

async function loadVideo(file: File): Promise<void> {
  if (!file.type.startsWith("video/")) {
    showToast("请选择本地视频文件");
    return;
  }
  importButton.disabled = true;
  exportButton.disabled = true;
  setProcessing(true, "DECODE 0 / 0");
  try {
    const videoProvider = await createVideoFrameProvider(file, ({ frame, total }) => {
      setProcessing(true, `DECODE ${frame} / ${total}`);
    });
    applyProvider(videoProvider, 0);
    showToast(`已本地抽取 ${videoProvider.info.frameCount} 帧 · 前 ${videoProvider.info.durationSec.toFixed(1)} 秒`);
  } catch (error) {
    setProcessing(false);
    showToast(error instanceof Error ? error.message : "视频读取失败");
  } finally {
    importButton.disabled = false;
    exportButton.disabled = !exportSupported();
    fileInput.value = "";
  }
}

function updateCapabilities(): void {
  const hasCodec = typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
  const hasMse = typeof MediaSource !== "undefined";
  const hasAudio = typeof AudioContext !== "undefined";
  const setCapability = (id: string, available: boolean): void => {
    const target = element(id);
    target.classList.toggle("ok", available);
    target.classList.toggle("no", !available);
  };
  setCapability("codecCap", hasCodec);
  setCapability("mseCap", hasMse);
  setCapability("audioCap", hasAudio);
  element("capabilityStatus").textContent =
    hasCodec && hasMse ? "READY" : hasCodec ? "MSE OFF" : "LIMITED";
  exportButton.disabled = !exportSupported();
}

async function refreshValidation(): Promise<void> {
  const status = element("validationStatus");
  status.textContent = "RUNNING";
  status.classList.remove("failed");
  try {
    const report = await runValidation();
    const steady = report.steady;
    const fast = report.fast;
    element("avgInterval").textContent = `${steady.timing.averageIntervalMs.toFixed(3)} ms`;
    element("timestampError").textContent = `${steady.timing.maxTimestampErrorUs.toFixed(2)} µs`;
    element("orderStatus").textContent =
      steady.timing.ordered && steady.timing.duplicateTimestamps === 0 ? "✓ / 0" : "FAIL";
    element("motionError").textContent =
      `${steady.panelMeanAbsoluteError.toFixed(2)} → ${steady.panelNearestFrameError.toFixed(2)}`;
    const ratio = steady.nearestFrameError > 0
      ? steady.meanAbsoluteError / steady.nearestFrameError
      : 1;
    element<HTMLElement>("nearestBar").style.width = "100%";
    element<HTMLElement>("interpBar").style.width = `${Math.max(5, ratio * 100)}%`;
    element("improvementText").textContent =
      `全画面 MAE 降低 ${(steady.errorImprovement * 100).toFixed(1)}% · 遮挡边 ${Math.round(steady.occlusionEdgeCoverage * 100)}% 帧`;
    const fastOk = fast.meanAbsoluteError < 8 && fast.guardedPixelRatio < 0.15;
    element("fastCheck").textContent =
      `${fastOk ? "PASS" : "CHECK"} · MAE ${fast.meanAbsoluteError.toFixed(2)} · 回退 ${(fast.guardedPixelRatio * 100).toFixed(1)}%`;
    const pass =
      steady.timing.ordered &&
      steady.timing.duplicateTimestamps === 0 &&
      steady.timing.maxTimestampErrorUs <= 0.5 &&
      steady.meanAbsoluteError < steady.nearestFrameError &&
      fastOk;
    status.textContent = pass ? "PASS" : "CHECK";
    status.classList.toggle("failed", !pass);
  } catch (error) {
    status.textContent = "ERROR";
    status.classList.add("failed");
    showToast(error instanceof Error ? error.message : "验证失败");
  }
}

function stopPlayback(): void {
  if (!rendererClock.running) return;
  rendererClock.pause(currentEntry().timeSec);
  setPlayingState(false);
}

async function togglePlayback(): Promise<void> {
  if (rendererClock.running) {
    stopPlayback();
    requestRender(false);
    return;
  }
  if (currentIndex >= schedule.length - 1) currentIndex = 0;
  const start = schedule[currentIndex].timeSec;
  try {
    await rendererClock.play(start, playbackRate);
    setPlayingState(true);
    requestAnimationFrame(playbackTick);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "无法启动播放时钟");
  }
}

function playbackTick(): void {
  if (!rendererClock.running) return;
  const position = rendererClock.position();
  if (position >= provider.info.durationSec) {
    currentIndex = schedule.length - 1;
    rendererClock.pause(schedule[currentIndex].timeSec);
    setPlayingState(false);
    requestRender(false);
    updateClockUi();
    return;
  }
  const nextIndex = Math.min(
    schedule.length - 1,
    Math.max(0, Math.floor(position * TARGET_FPS + 1e-7))
  );
  if (nextIndex !== currentIndex) {
    currentIndex = nextIndex;
    updateClockUi();
    requestRender(false);
  }
  requestAnimationFrame(playbackTick);
}

function seekToTime(seconds: number): void {
  const clamped = Math.max(0, Math.min(provider.info.durationSec - 1 / TARGET_FPS, seconds));
  currentIndex = secondsToIndex(clamped);
  if (rendererClock.running) {
    rendererClock.seek(currentEntry().timeSec);
  }
  updateClockUi();
  requestRender(!rendererClock.running);
}

function stepFrame(delta: number): void {
  stopPlayback();
  currentIndex = Math.max(0, Math.min(schedule.length - 1, currentIndex + delta));
  updateClockUi();
  requestRender(true);
}

function updateRegionFromPointer(clientX: number, clientY: number): void {
  const rect = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  const left = Math.min(dragOrigin.regionX, x);
  const top = Math.min(dragOrigin.regionY, y);
  settings.region.x = left;
  settings.region.y = top;
  settings.region.width = Math.max(0.04, Math.abs(x - dragOrigin.regionX));
  settings.region.height = Math.max(0.04, Math.abs(y - dragOrigin.regionY));
  if (settings.region.x + settings.region.width > 1) {
    settings.region.width = 1 - settings.region.x;
  }
  if (settings.region.y + settings.region.height > 1) {
    settings.region.height = 1 - settings.region.y;
  }
  interpolator.updateSettings(settings);
  setRegionMeta();
  updateClockUi();
  drawCurrentStateOnly();
  queueSettingsRender();
}

function setupPlaybackControls(): void {
  playButton.addEventListener("click", () => void togglePlayback());
  element<HTMLButtonElement>("stepBack").addEventListener("click", () => stepFrame(-1));
  element<HTMLButtonElement>("stepForward").addEventListener("click", () => stepFrame(1));
  const rateButton = element<HTMLButtonElement>("rateButton");
  rateButton.addEventListener("click", () => {
    playbackRate = playbackRate === 1 ? 0.5 : playbackRate === 0.5 ? 1.5 : 1;
    rateButton.textContent = `${playbackRate.toFixed(1)}×`;
    if (rendererClock.running) rendererClock.setRate(playbackRate);
  });

  const timeline = timelineCanvas;
  timeline.addEventListener("pointerdown", (event) => {
    timelineDragging = true;
    timeline.setPointerCapture(event.pointerId);
    const time = timelineView.timeAt(event.clientX);
    if (time !== null) {
      stopPlayback();
      seekToTime(time);
    }
  });
  timeline.addEventListener("pointermove", (event) => {
    if (!timelineDragging) return;
    const time = timelineView.timeAt(event.clientX);
    if (time !== null) seekToTime(time);
  });
  timeline.addEventListener("pointerup", (event) => {
    timelineDragging = false;
    if (timeline.hasPointerCapture(event.pointerId)) {
      timeline.releasePointerCapture(event.pointerId);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement
    ) {
      return;
    }
    if (event.code === "Space") {
      event.preventDefault();
      void togglePlayback();
    } else if (event.code === "ArrowLeft") {
      event.preventDefault();
      stepFrame(event.shiftKey ? -6 : -1);
    } else if (event.code === "ArrowRight") {
      event.preventDefault();
      stepFrame(event.shiftKey ? 6 : 1);
    }
  });
}

function setupCanvasInteraction(): void {
  const canvasWrap = element<HTMLElement>("canvasWrap");
  canvas.addEventListener("pointerdown", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const nearSplit = Math.abs(x - split) * rect.width < 24;
    canvas.setPointerCapture(event.pointerId);
    if (settings.region.enabled && !nearSplit) {
      dragMode = "roi";
      stopPlayback();
      dragOrigin = {
        x,
        y,
        regionX: x,
        regionY: y,
        regionW: 0.04,
        regionH: 0.04
      };
      settings.region.x = x;
      settings.region.y = y;
      settings.region.width = 0.04;
      settings.region.height = 0.04;
      setRegionMeta();
      drawCurrentStateOnly();
    } else {
      dragMode = "split";
      split = x;
      drawCurrentStateOnly();
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    if (dragMode === "split") {
      split = x;
      drawCurrentStateOnly();
    } else if (dragMode === "roi") {
      updateRegionFromPointer(event.clientX, event.clientY);
    } else if (settings.region.enabled) {
      const nearSplit = Math.abs(x - split) * rect.width < 24;
      canvas.style.cursor = nearSplit ? "ew-resize" : "crosshair";
    }
  });
  const finishDrag = (event: PointerEvent): void => {
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    if (dragMode === "roi") {
      interpolator.updateSettings(settings);
      queueSettingsRender();
    }
    dragMode = null;
  };
  canvas.addEventListener("pointerup", finishDrag);
  canvas.addEventListener("pointercancel", finishDrag);

  canvasWrap.addEventListener("dragover", (event) => {
    event.preventDefault();
    canvasWrap.classList.add("dragging");
  });
  canvasWrap.addEventListener("dragleave", () => canvasWrap.classList.remove("dragging"));
  canvasWrap.addEventListener("drop", (event) => {
    event.preventDefault();
    canvasWrap.classList.remove("dragging");
    const file = event.dataTransfer?.files[0];
    if (file) void loadVideo(file);
  });
}

function setupInspector(): void {
  const sliderIds = ["blockSize", "maxDisplacement", "occlusionThreshold", "roiStrength", "roiFeather"];
  for (const id of sliderIds) {
    const input = element<HTMLInputElement>(id);
    input.addEventListener("input", () => {
      updateSliderFill(input);
      readSettingsFromControls();
      queueSettingsRender();
    });
  }

  const roiToggle = element<HTMLInputElement>("roiToggle");
  roiToggle.addEventListener("change", () => {
    settings.region.enabled = roiToggle.checked;
    element("viewerHint").textContent = roiToggle.checked
      ? "拖动画框选择局部 · 靠近中线可拖动对比"
      : "拖动中线对比 · 开启局部后可在画面框选";
    interpolator.updateSettings(settings);
    drawCurrentStateOnly();
    queueSettingsRender();
  });

  const occlusionToggle = element<HTMLInputElement>("occlusionToggle");
  occlusionToggle.addEventListener("change", () => {
    showOcclusion = occlusionToggle.checked;
    drawCurrentStateOnly();
  });

  const audioToggle = element<HTMLInputElement>("audioToggle");
  audioToggle.addEventListener("change", () => {
    rendererClock.setVolume(audioToggle.checked ? 0.8 : 0);
  });

  document.querySelectorAll<HTMLButtonElement>("#viewSwitch button").forEach((button) => {
    button.addEventListener("click", () => {
      compareMode = (button.dataset.mode ?? "wipe") as CompareMode;
      document
        .querySelectorAll("#viewSwitch button")
        .forEach((item) => item.classList.toggle("active", item === button));
      drawCurrentStateOnly();
    });
  });
}

function closeMediaModal(): void {
  exportVideo.pause();
  exportCleanup?.();
  exportCleanup = null;
  exportVideo.removeAttribute("src");
  exportVideo.load();
  mediaModal.hidden = true;
}

async function showExportResult(
  result: Awaited<ReturnType<typeof exportInterpolatedVideo>>
): Promise<void> {
  if (exportUrl) URL.revokeObjectURL(exportUrl);
  exportUrl = URL.createObjectURL(result.blob);
  downloadLink.href = exportUrl;
  downloadLink.download = provider.info.kind === "video"
    ? `${provider.info.name.replace(/\.[^.]+$/, "")}-60p.webm`
    : "frame-lens-synthetic-60p.webm";
  mediaModal.hidden = false;
  modal.meta.textContent =
    `VP8 · ${provider.info.width}×${provider.info.height} · ${result.durationSec.toFixed(2)}s · 静音`;
  exportVideo.removeAttribute("src");
  exportVideo.load();
  try {
    exportCleanup = await playWithMediaSource(exportVideo, result.buffer, result.mimeType);
  } catch {
    const fallbackUrl = URL.createObjectURL(result.blob);
    exportVideo.src = fallbackUrl;
    exportCleanup = () => URL.revokeObjectURL(fallbackUrl);
    await exportVideo.play().catch(() => undefined);
  }
}

async function runExport(): Promise<void> {
  if (!exportSupported()) {
    showToast("当前浏览器缺少 WebCodecs，无法导出");
    return;
  }
  stopPlayback();
  exportButton.disabled = true;
  importButton.disabled = true;
  setProcessing(true, "ENCODE 0 / 0");
  try {
    const result = await exportInterpolatedVideo(
      interpolator,
      schedule,
      provider.info,
      ({ frame, total, stage }) => {
        const stageLabel =
          stage === "interpolate" ? "FRAME" : stage === "encode" ? "FLUSH" : "MUX";
        setProcessing(true, `${stageLabel} ${Math.min(frame, total)} / ${total}`);
      }
    );
    setProcessing(false);
    await showExportResult(result);
    showToast("60P WebM 已在本地编码完成");
  } catch (error) {
    setProcessing(false);
    showToast(error instanceof Error ? error.message : "导出失败");
  } finally {
    exportButton.disabled = false;
    importButton.disabled = false;
  }
}

function setupImportAndExport(): void {
  importButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void loadVideo(file);
  });
  resetButton.addEventListener("click", loadSynthetic);
  exportButton.addEventListener("click", () => void runExport());
  modal.close.addEventListener("click", closeMediaModal);
  mediaModal.addEventListener("click", (event) => {
    if (event.target === mediaModal) closeMediaModal();
  });
  window.addEventListener("keydown", (event) => {
    if (event.code === "Escape" && !mediaModal.hidden) closeMediaModal();
  });
}

function initialize(): void {
  refreshAllSliders();
  readSettingsFromControls();
  updateCapabilities();
  setupPlaybackControls();
  setupCanvasInteraction();
  setupInspector();
  setupImportAndExport();
  element<HTMLInputElement>("roiToggle").checked = settings.region.enabled;
  element<HTMLInputElement>("occlusionToggle").checked = showOcclusion;
  applyProvider(provider, SYNTHETIC_START_SECONDS);
  updateClockUi();
  window.setTimeout(() => void refreshValidation(), 120);
}

initialize();
