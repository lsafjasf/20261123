import { parseSubtitle } from "../shared/cues.js";
import { layoutSubtitle } from "../shared/layout.js";
import { DEFAULT_STYLE, DEMO_SUBJECTS, PRESETS } from "../shared/presets.js";
import type {
  Aspect,
  LayoutStyle,
  PlacementPreference,
  SubjectBox,
  SubtitleCue,
  SubtitleDocument,
  VideoPreset
} from "../shared/types.js";
import { renderLayoutCheck } from "./checks.js";
import { exportBurnedVideo } from "./export.js";
import { parseMp4, type Mp4File } from "./mp4/reader.js";
import { SourcePreview, mediaSourceMime } from "./preview.js";
import { createCanvas, createMeasure, drawComposite, renderSubtitleLayer } from "./renderer.js";

const DEMO_SRT = `1
00:00:00,600 --> 00:00:04,500
先找出真正影响结果的变量。

2
00:00:04,600 --> 00:00:08,400
再逐项排除干扰。保留可复核的证据链。

3
00:00:08,800 --> 00:00:12,600
逐帧对齐，让字幕与原始音轨同步落位。`;

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element ${selector}`);
  return element;
};

interface SourceState {
  name: string;
  bytes: Uint8Array;
  mp4: Mp4File;
  mime: string;
  fps: number;
  durationUs: number;
}

const video = $<HTMLVideoElement>("#sourceVideo");
const preview = new SourcePreview(video);
const landscapeCanvas = $<HTMLCanvasElement>("#previewLandscape");
const portraitCanvas = $<HTMLCanvasElement>("#previewPortrait");
const subtitleEditor = $<HTMLTextAreaElement>("#subtitleEditor");
const timeline = $<HTMLInputElement>("#timeline");
const playButton = $<HTMLButtonElement>("#playButton");

let source: SourceState | null = null;
let subtitleDoc: SubtitleDocument = parseSubtitle(DEMO_SRT, "demo.srt");
let style: LayoutStyle = { ...DEFAULT_STYLE };
let placement: PlacementPreference = "auto";
let subjectMode = "presenter";
let debug = false;
let timeUs = 4_600_000;
let durationUs = 14_000_000;
let playing = false;
let lastTick = performance.now();
let rendering = false;
let exporting = false;
let toastTimer: number | undefined;

const demoFrame = createDemoFrame();

function createDemoFrame(): OffscreenCanvas {
  const canvas = createCanvas(1280, 720);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const gradient = ctx.createLinearGradient(0, 0, 1280, 720);
  gradient.addColorStop(0, "#0c1c28");
  gradient.addColorStop(0.55, "#0a1721");
  gradient.addColorStop(1, "#142a34");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1280, 720);
  const bloom = ctx.createRadialGradient(870, 240, 10, 870, 240, 680);
  bloom.addColorStop(0, "rgba(45, 122, 142, 0.32)");
  bloom.addColorStop(1, "rgba(8, 18, 26, 0)");
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, 1280, 720);

  ctx.strokeStyle = "rgba(145, 189, 199, 0.07)";
  ctx.lineWidth = 1;
  for (let x = 0; x < 1280; x += 80) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 720); ctx.stroke();
  }
  for (let y = 0; y < 720; y += 60) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1280, y); ctx.stroke();
  }

  ctx.fillStyle = "rgba(13, 31, 43, 0.62)";
  ctx.strokeStyle = "rgba(142, 190, 201, 0.16)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(475, 118, 690, 402, 20);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#e8b65f";
  ctx.font = '500 20px "Noto Sans Mono", monospace';
  ctx.fillText("SECTION 04  /  EVIDENCE", 535, 174);
  ctx.fillStyle = "#f4f1e7";
  ctx.font = '700 48px "Noto Sans CJK SC", "Droid Sans Fallback", sans-serif';
  ctx.fillText("把复杂问题拆成", 535, 255);
  ctx.fillText("可验证的步骤", 535, 322);
  ctx.strokeStyle = "rgba(194, 211, 213, 0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(535, 356); ctx.lineTo(1100, 356); ctx.stroke();
  ctx.fillStyle = "#849ba3";
  ctx.font = '500 16px "Noto Sans CJK SC", sans-serif';
  ctx.fillText("01  找出关键变量", 535, 397);
  ctx.fillText("03  保留证据链", 535, 446);
  ctx.fillText("02  排除干扰项", 835, 397);
  ctx.fillText("04  反向验证", 835, 446);
  ctx.fillStyle = "rgba(225, 169, 65, 0.22)";
  ctx.beginPath();
  ctx.moveTo(590, 472);
  ctx.lineTo(730, 450); ctx.lineTo(840, 465); ctx.lineTo(950, 430); ctx.lineTo(1090, 414);
  ctx.lineTo(1090, 475); ctx.lineTo(590, 475); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#d9a744"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(590, 472); ctx.lineTo(730, 450); ctx.lineTo(840, 465); ctx.lineTo(950, 430); ctx.lineTo(1090, 414); ctx.stroke();

  ctx.fillStyle = "#1c303c";
  ctx.beginPath(); ctx.ellipse(290, 590, 126, 158, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#d19a67";
  ctx.beginPath(); ctx.arc(290, 410, 63, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#243946";
  ctx.beginPath(); ctx.arc(282, 364, 58, Math.PI, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#182b36";
  ctx.beginPath(); ctx.arc(267, 407, 4, 0, Math.PI * 2); ctx.arc(312, 407, 4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#8e5e3f"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(290, 422, 18, 0.2, Math.PI - 0.2); ctx.stroke();
  ctx.strokeStyle = "#d4a040"; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(222, 570); ctx.lineTo(358, 570); ctx.stroke();

  ctx.fillStyle = "rgba(6, 14, 20, 0.42)";
  ctx.fillRect(0, 0, 1280, 720);
  return canvas;
}

function toast(message: string, error = false): void {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element.classList.remove("show"), 4200);
}

function timeLabel(microseconds: number, hours = false): string {
  const totalMs = Math.max(0, Math.round(microseconds / 1_000));
  const ms = totalMs % 1_000;
  const totalSeconds = Math.floor(totalMs / 1_000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3_600);
  const stem = hours ? `${String(hh).padStart(2, "0")}:` : "";
  return `${stem}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function scaledPreset(preset: VideoPreset, width: number): VideoPreset {
  const scale = width / preset.width;
  return {
    ...preset,
    width,
    height: Math.round(preset.height * scale),
    safe: {
      x: preset.safe.x * scale,
      y: preset.safe.y * scale,
      width: preset.safe.width * scale,
      height: preset.safe.height * scale
    },
    fontSize: preset.fontSize * scale,
    minFontSize: preset.minFontSize * scale,
    bottomInset: preset.bottomInset * scale,
    horizontalPadding: preset.horizontalPadding * scale,
    verticalPadding: preset.verticalPadding * scale
  };
}

function subjectFor(aspect: Aspect): SubjectBox | null {
  if (subjectMode === "none") return null;
  if (subjectMode === "lower") {
    return aspect === "16:9"
      ? { x: 0.12, y: 0.37, width: 0.7, height: 0.56 }
      : { x: 0.06, y: 0.41, width: 0.88, height: 0.51 };
  }
  return aspect === "16:9"
    ? { x: 0.08, y: 0.22, width: 0.36, height: 0.67 }
    : DEMO_SUBJECTS["9:16"];
}

function estimateFps(mp4: Mp4File): number {
  const sorted = [...new Set(mp4.video.samples.map((sample) => sample.cts))].sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let index = 1; index < Math.min(60, sorted.length); index += 1) {
    const delta = sorted[index] - sorted[index - 1];
    if (delta > 0) deltas.push(delta);
  }
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)] ?? mp4.video.timescale / 30;
  return mp4.video.timescale / median;
}

async function loadSourceBytes(bytes: Uint8Array, name: string): Promise<void> {
  playing = false;
  playButton.classList.remove("playing");
  const mp4 = parseMp4(bytes);
  const mime = mediaSourceMime(mp4);
  const attach = await preview.attach(bytes, mime);
  const fps = estimateFps(mp4);
  const videoDuration = mp4.video.displayDurationSeconds;
  const audioDuration = mp4.audio?.displayDurationSeconds ?? 0;
  const dur = Math.max(videoDuration, audioDuration);
  source = {
    name,
    bytes,
    mp4,
    mime,
    fps,
    durationUs: Math.round(dur * 1_000_000)
  };
  durationUs = source.durationUs;
  timeline.max = String(durationUs);
  timeline.step = String(Math.max(1_000, Math.round(1_000_000 / Math.max(1, fps))));
  $("#metaName").textContent = name;
  $("#metaFrame").textContent = `${mp4.video.width} × ${mp4.video.height}`;
  $("#metaFps").textContent = fps.toFixed(3);
  $("#metaDuration").textContent = timeLabel(durationUs);
  $("#metaVideo").textContent = mp4.video.codec.toUpperCase();
  $("#metaAudio").textContent = mp4.audio ? `${mp4.audio.codec.toUpperCase()} / PASS-THROUGH` : "NO AUDIO";
  $("#durationCode").textContent = timeLabel(durationUs);
  $("#supportStatus").textContent = `${attach.mode.toUpperCase()} PREVIEW · ${mp4.video.width}×${mp4.video.height} · ${mp4.video.samples.length} FRAMES`;
  const warnings = [...mp4.warnings, ...attach.warnings];
  if (warnings.length) toast(warnings.join(" · "), true);
  else toast(`素材已载入：${mp4.video.samples.length} 帧，音轨待直通`);
  timeUs = Math.min(4_600_000, Math.max(0, durationUs - 100_000));
  preview.seek(timeUs / 1_000_000);
  rebuildCueList();
  rebuildCueTrack();
  updateStaticFrame();
}

async function loadVideoFile(file: File): Promise<void> {
  try {
    const buffer = await file.arrayBuffer();
    await loadSourceBytes(new Uint8Array(buffer), file.name);
  } catch (error) {
    toast(`素材载入失败：${error instanceof Error ? error.message : String(error)}`, true);
  }
}

function applySubtitleText(text: string, sourceName = "captions.srt"): void {
  subtitleDoc = parseSubtitle(text, sourceName);
  const cues = subtitleDoc.cues;
  $("#parseStatus").textContent = `${subtitleDoc.sourceType.toUpperCase()} · ${cues.length} CUES`;
  if (subtitleDoc.warnings.length) toast(subtitleDoc.warnings.join(" · "), true);
  rebuildCueList();
  rebuildCueTrack();
  updateStaticFrame();
}

function rebuildCueList(): void {
  const list = $("#cueList");
  list.innerHTML = "";
  for (let index = 0; index < subtitleDoc.cues.length; index += 1) {
    const cue = subtitleDoc.cues[index];
    const row = document.createElement("button");
    row.className = "cue-row";
    row.dataset.cueId = cue.id;
    row.innerHTML = `<b>${String(index + 1).padStart(2, "0")}</b><span></span><em>${timeLabel(cue.startUs).slice(0, 6)}</em>`;
    row.querySelector("span")!.textContent = cue.text;
    row.addEventListener("click", () => {
      pause();
      setTime(cue.startUs + 10_000);
    });
    list.appendChild(row);
  }
  syncCueSelection();
}

function rebuildCueTrack(): void {
  const track = $("#cueTrack");
  track.innerHTML = "";
  for (const cue of subtitleDoc.cues) {
    const tick = document.createElement("i");
    tick.className = "cue-tick";
    tick.dataset.cueId = cue.id;
    tick.style.left = `${(cue.startUs / Math.max(1, durationUs)) * 100}%`;
    tick.style.width = `${Math.max(0.45, ((cue.endUs - cue.startUs) / Math.max(1, durationUs)) * 100)}%`;
    track.appendChild(tick);
  }
}

function activeCue(time: number): SubtitleCue | null {
  for (const cue of subtitleDoc.cues) {
    if (time >= cue.startUs && time < cue.endUs) return cue;
  }
  return null;
}

function syncCueSelection(): void {
  const cue = activeCue(timeUs);
  for (const row of document.querySelectorAll<HTMLElement>(".cue-row")) {
    row.classList.toggle("active", row.dataset.cueId === cue?.id);
  }
  for (const tick of document.querySelectorAll<HTMLElement>(".cue-tick")) {
    tick.classList.toggle("active", tick.dataset.cueId === cue?.id);
  }
  const sentenceId = cue?.sentences.find((sentence) => timeUs >= sentence.startUs && timeUs < sentence.endUs)?.id ?? -1;
  $("#activeCueLabel").textContent = cue
    ? `CUE ${cue.id.padStart(2, "0")} / SENTENCE ${String(sentenceId + 1).padStart(2, "0")}`
    : "NO ACTIVE CUE";
}

function sourceImage(): { image: CanvasImageSource; width: number; height: number } {
  if (preview.ready) return { image: video, width: video.videoWidth, height: video.videoHeight };
  return { image: demoFrame, width: 1280, height: 720 };
}

function debugOverlay(ctx: CanvasRenderingContext2D, preset: VideoPreset, layout: ReturnType<typeof layoutSubtitle>): void {
  if (!debug) return;
  ctx.save();
  ctx.setLineDash([7, 5]);
  ctx.strokeStyle = "rgba(103, 214, 173, 0.85)";
  ctx.lineWidth = 1;
  ctx.strokeRect(preset.safe.x, preset.safe.y, preset.safe.width, preset.safe.height);
  ctx.strokeStyle = "rgba(102, 200, 232, 0.9)";
  ctx.strokeRect(layout.backgroundBox.x, layout.backgroundBox.y, layout.backgroundBox.width, layout.backgroundBox.height);
  const subject = subjectFor(preset.aspect);
  if (subject) {
    ctx.strokeStyle = "rgba(242, 143, 64, 0.9)";
    ctx.strokeRect(subject.x * preset.width, subject.y * preset.height, subject.width * preset.width, subject.height * preset.height);
  }
  ctx.restore();
}

function drawPreview(canvas: HTMLCanvasElement, aspect: Aspect): ReturnType<typeof layoutSubtitle> {
  const fullPreset = PRESETS[aspect];
  const previewPreset = scaledPreset(fullPreset, canvas.width);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D 不可用");
  const measure = createMeasure(ctx, style);
  const cue = activeCue(timeUs);
  const layout = layoutSubtitle(
    { preset: previewPreset, style, subjectBox: subjectFor(aspect), placement, timeUs, cue },
    measure
  );
  const sourceFrame = sourceImage();
  const layer = renderSubtitleLayer(layout, style, previewPreset);
  drawComposite(ctx, sourceFrame.image, sourceFrame.width, sourceFrame.height, layer, previewPreset);
  debugOverlay(ctx, previewPreset, layout);
  return layout;
}

function updateStaticFrame(): void {
  if (rendering) return;
  rendering = true;
  try {
    const landscape = drawPreview(landscapeCanvas, "16:9");
    const portrait = drawPreview(portraitCanvas, "9:16");
    updateReadouts(landscape, portrait);
  } finally {
    rendering = false;
  }
}

function updateReadouts(landscape: ReturnType<typeof layoutSubtitle>, portrait: ReturnType<typeof layoutSubtitle>): void {
  const lsScale = landscapeCanvas.width / PRESETS["16:9"].width;
  const ptScale = portraitCanvas.width / PRESETS["9:16"].width;
  $("#lsFont").textContent = String(Math.round(landscape.fontSize / lsScale));
  $("#lsLines").textContent = String(landscape.lines.length);
  $("#lsPlacement").textContent = landscape.placement.toUpperCase();
  $("#ptFont").textContent = String(Math.round(portrait.fontSize / ptScale));
  $("#ptLines").textContent = String(portrait.lines.length);
  $("#ptPlacement").textContent = portrait.placement.toUpperCase();
  $("#timecode").textContent = timeLabel(timeUs);
  timeline.value = String(Math.round(timeUs));
  const progress = Math.min(100, (timeUs / Math.max(1, durationUs)) * 100);
  timeline.style.setProperty("--progress", `${progress}%`);
  const frame = Math.round((timeUs / 1_000_000) * (source?.fps ?? 30));
  $("#frameClock").textContent = `F ${String(frame).padStart(4, "0")} / ${timeLabel(timeUs)}`;
  syncCueSelection();
}

function setTime(nextUs: number): void {
  timeUs = Math.max(0, Math.min(durationUs, Math.round(nextUs)));
  if (source && preview.ready) preview.seek(timeUs / 1_000_000);
  updateStaticFrame();
}

async function play(): Promise<void> {
  if (playing) return;
  try {
    if (source) {
      await preview.play();
      timeUs = Math.round(preview.currentTime * 1_000_000);
    }
    playing = true;
    lastTick = performance.now();
    playButton.classList.add("playing");
    playButton.setAttribute("aria-label", "暂停");
  } catch (error) {
    toast(`无法播放：${error instanceof Error ? error.message : String(error)}`, true);
  }
}

function pause(): void {
  if (source) preview.pause();
  playing = false;
  playButton.classList.remove("playing");
  playButton.setAttribute("aria-label", "播放");
  updateStaticFrame();
}

function tick(now: number): void {
  const delta = Math.min(120, now - lastTick);
  lastTick = now;
  if (playing) {
    if (source && preview.ready) {
      timeUs = Math.round(preview.currentTime * 1_000_000);
    } else {
      timeUs += delta * 1_000;
    }
    if (timeUs >= durationUs) {
      timeUs = durationUs;
      if (source) preview.pause();
      playing = false;
      playButton.classList.remove("playing");
    }
    updateStaticFrame();
  }
  requestAnimationFrame(tick);
}

function wireSegmented(selector: string, callback: (value: string) => void): void {
  const root = $(selector);
  for (const button of root.querySelectorAll<HTMLButtonElement>("button")) {
    button.addEventListener("click", () => {
      for (const peer of root.querySelectorAll<HTMLButtonElement>("button")) peer.classList.toggle("active", peer === button);
      callback(button.dataset.value ?? "");
      updateStaticFrame();
    });
  }
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 20_000);
}

function safeBaseName(): string {
  const stem = (source?.name ?? "course").replace(/\.[^.]+$/, "");
  return stem.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "course";
}

function addResultCard(
  title: string,
  subtitle: string,
  actions: Array<{ label: string; run: () => void }>
): void {
  const root = $("#exportResults");
  const card = document.createElement("div");
  card.className = "result-card";
  card.innerHTML = `<div class="result-card-head"><b>${title}</b><span>${subtitle}</span></div><p></p><div class="result-actions"></div>`;
  const paragraph = card.querySelector("p")!;
  paragraph.textContent = subtitle;
  const actionRoot = card.querySelector(".result-actions")!;
  for (const action of actions) {
    const button = document.createElement("button");
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    actionRoot.appendChild(button);
  }
  root.prepend(card);
}

function setProgress(visible: boolean, percent = 0, message = ""): void {
  $("#progressBox").classList.toggle("hidden", !visible);
  $("#progressFill").style.width = `${Math.max(0, Math.min(100, percent))}%`;
  $("#progressPercent").textContent = `${Math.round(Math.max(0, Math.min(100, percent)))}%`;
  if (message) $("#progressMessage").textContent = message;
}

function setExporting(value: boolean): void {
  exporting = value;
  for (const button of document.querySelectorAll<HTMLButtonElement>("#exportBoth, #exportLandscape, #exportPortrait, #exportChecks")) {
    button.disabled = value;
  }
}

async function exportAspects(aspects: Aspect[]): Promise<void> {
  if (exporting) return;
  if (!source) {
    toast("请先载入一个 MP4 课程视频", true);
    return;
  }
  const activeSource = source;
  pause();
  setExporting(true);
  setProgress(true, 0, "准备导出");
  try {
    for (let index = 0; index < aspects.length; index += 1) {
      const aspect = aspects[index];
      const basePercent = (index / aspects.length) * 100;
      const span = 100 / aspects.length;
      const result = await exportBurnedVideo({
        fileName: activeSource.name,
        bytes: activeSource.bytes,
        cues: subtitleDoc.cues,
        aspect,
        style,
        subjectBox: subjectFor(aspect),
        placement,
        onProgress: (progress) => {
          const ratio = progress.total > 0 ? progress.frame / progress.total : 0;
          setProgress(true, basePercent + ratio * span, `${aspect} · ${progress.message}`);
        }
      });
      const label = aspect === "16:9" ? "16:9" : "9:16";
      const fileName = `${safeBaseName()}_${aspect.replace(":", "x")}_burned.mp4`;
      const manifestName = `${safeBaseName()}_${aspect.replace(":", "x")}_frame-map.json`;
      addResultCard(
        `${label} BURNED`,
        `${result.manifest.frameCount} FRAMES · MAP ${result.manifest.frameMapping.exact ? "EXACT" : "CHECK"} · AAC ${result.manifest.audio.bytePreserved ? "VERIFIED" : "MISMATCH"}`,
        [
          { label: "下载 MP4", run: () => downloadBlob(result.blob, fileName) },
          { label: "下载帧映射", run: () => downloadBlob(result.manifestBlob, manifestName) }
        ]
      );
      toast(`${label} 导出完成：${result.manifest.frameCount} 帧，音轨字节校验通过`);
    }
    setProgress(true, 100, "全部导出完成");
    window.setTimeout(() => setProgress(false), 1800);
  } catch (error) {
    console.error(error);
    toast(`导出失败：${error instanceof Error ? error.message : String(error)}`, true);
    setProgress(false);
  } finally {
    setExporting(false);
  }
}

async function exportLayoutChecks(): Promise<void> {
  if (exporting) return;
  setExporting(true);
  try {
    const frame = sourceImage();
    const baseName = safeBaseName();
    const metrics: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      source: source?.name ?? "synthetic-demo",
      frameTimeUs: timeUs,
      frameIndex: Math.round((timeUs / 1_000_000) * (source?.fps ?? 30))
    };
    for (const aspect of ["16:9", "9:16"] as const) {
      setProgress(true, aspect === "16:9" ? 34 : 76, `生成 ${aspect} 版面检查图`);
      const check = await renderLayoutCheck({
        preset: PRESETS[aspect],
        style,
        cues: subtitleDoc.cues,
        subjectBox: subjectFor(aspect),
        placement,
        timeUs,
        source: frame.image,
        sourceWidth: frame.width,
        sourceHeight: frame.height
      });
      downloadBlob(check.blob, `${baseName}_layout-check-${aspect.replace(":", "x")}.png`);
      metrics[aspect] = check.metrics;
    }
    const metricsBlob = new Blob([JSON.stringify(metrics, null, 2)], { type: "application/json" });
    downloadBlob(metricsBlob, `${baseName}_layout-metrics.json`);
    addResultCard("LAYOUT CHECKS", "16:9 + 9:16 PNG · METRICS JSON", [
      { label: "重导 PNG", run: () => void exportLayoutChecks() }
    ]);
    setProgress(true, 100, "版面检查图已导出");
    toast("两种画幅的版面检查图与指标已生成");
    window.setTimeout(() => setProgress(false), 1500);
  } catch (error) {
    toast(`版面检查失败：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    setExporting(false);
  }
}

function updateSubjectPreview(): void {
  const ls = document.querySelector<HTMLElement>(".subject-diagram.ls i");
  const pt = document.querySelector<HTMLElement>(".subject-diagram.pt i");
  if (!ls || !pt) return;
  if (subjectMode === "none") {
    ls.style.display = "none";
    pt.style.display = "none";
  } else if (subjectMode === "lower") {
    ls.style.display = "block";
    pt.style.display = "block";
    ls.style.cssText = "display:block;left:12%;top:37%;width:70%;height:56%";
    pt.style.cssText = "display:block;left:6%;top:41%;width:88%;height:51%";
  } else {
    ls.style.cssText = "display:block;left:8%;top:22%;width:36%;height:67%";
    pt.style.cssText = "display:block;left:8%;top:8%;width:84%;height:38%";
  }
}

function setupSupportStatus(): void {
  const checks = [
    ["WebCodecs", typeof VideoDecoder !== "undefined" && typeof VideoEncoder !== "undefined"],
    ["MediaSource", typeof MediaSource !== "undefined"],
    ["WebAudio", typeof AudioContext !== "undefined"],
    ["OffscreenCanvas", typeof OffscreenCanvas !== "undefined"]
  ] as const;
  const missing = checks.filter(([, available]) => !available).map(([name]) => name);
  $("#supportStatus").textContent = missing.length ? `缺失 ${missing.join(" / ")}` : "RUNTIME READY · LOCAL";
  if (missing.length) toast(`当前浏览器缺少 ${missing.join("、")}，部分功能不可用`, true);
}

function wireEvents(): void {
  const videoInput = $<HTMLInputElement>("#videoInput");
  $("#browseVideo").addEventListener("click", () => videoInput.click());
  videoInput.addEventListener("change", () => {
    const file = videoInput.files?.[0];
    if (file) void loadVideoFile(file);
  });
  const drop = $("#videoDrop");
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("dragging");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("dragging");
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadVideoFile(file);
  });

  const srtInput = $<HTMLInputElement>("#srtInput");
  $("#loadSrt").addEventListener("click", () => srtInput.click());
  srtInput.addEventListener("change", async () => {
    const file = srtInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    subtitleEditor.value = text;
    applySubtitleText(text, file.name);
  });

  let parseTimer: number | undefined;
  subtitleEditor.addEventListener("input", () => {
    window.clearTimeout(parseTimer);
    parseTimer = window.setTimeout(() => applySubtitleText(subtitleEditor.value), 320);
  });
  $("#applySubtitle").addEventListener("click", () => applySubtitleText(subtitleEditor.value));

  $("#loadSample").addEventListener("click", () => void loadSample());
  $("#debugToggle").addEventListener("change", (event) => {
    debug = (event.target as HTMLInputElement).checked;
    updateStaticFrame();
  });
  $("#subjectMode").addEventListener("change", (event) => {
    subjectMode = (event.target as HTMLSelectElement).value;
    updateSubjectPreview();
    updateStaticFrame();
  });
  $("#accentColor").addEventListener("input", (event) => {
    style.accent = (event.target as HTMLInputElement).value;
    const label = (event.target as HTMLInputElement).nextElementSibling;
    if (label) label.textContent = style.accent.toUpperCase();
    updateStaticFrame();
  });
  $("#fontScale").addEventListener("change", (event) => {
    style.fontScale = Number((event.target as HTMLSelectElement).value);
    updateStaticFrame();
  });
  wireSegmented("#backgroundStyles", (value) => {
    style.background = value as LayoutStyle["background"];
  });
  wireSegmented("#placementModes", (value) => {
    placement = value as PlacementPreference;
  });

  playButton.addEventListener("click", () => {
    if (playing) pause();
    else void play();
  });
  timeline.addEventListener("input", () => {
    pause();
    setTime(Number(timeline.value));
  });
  video.addEventListener("ended", () => {
    playing = false;
    playButton.classList.remove("playing");
  });
  $("#exportBoth").addEventListener("click", () => void exportAspects(["16:9", "9:16"]));
  $("#exportLandscape").addEventListener("click", () => void exportAspects(["16:9"]));
  $("#exportPortrait").addEventListener("click", () => void exportAspects(["9:16"]));
  $("#exportChecks").addEventListener("click", () => void exportLayoutChecks());
}

async function loadSample(): Promise<void> {
  try {
    const [videoResponse, srtResponse] = await Promise.all([
      fetch("/samples/demo-course.mp4"),
      fetch("/samples/demo-course.srt")
    ]);
    if (!videoResponse.ok) throw new Error("样例视频不可用");
    const bytes = new Uint8Array(await videoResponse.arrayBuffer());
    if (srtResponse.ok) {
      const srt = await srtResponse.text();
      subtitleEditor.value = srt;
      applySubtitleText(srt, "demo-course.srt");
    }
    await loadSourceBytes(bytes, "demo-course.mp4");
  } catch (error) {
    toast(`样例载入失败：${error instanceof Error ? error.message : String(error)}。可直接拖入本地 MP4。`, true);
  }
}

function init(): void {
  subtitleEditor.value = DEMO_SRT;
  applySubtitleText(DEMO_SRT, "demo.srt");
  setupSupportStatus();
  wireEvents();
  updateSubjectPreview();
  setTime(4_600_000);
  setInterval(() => {
    $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }, 1000);
  $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  requestAnimationFrame(tick);
  void loadSample();
}

init();
