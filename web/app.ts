import { summarize } from "../src/core/analyzer.ts";
import {
  buildReport,
  framesToCsv,
  reportToJson,
  summaryToCsv,
  type ReportMeta,
} from "../src/core/export.ts";
import type { FrameAnalysis, FrameClass } from "../src/core/types.ts";
import { generateDemo } from "./demo.ts";
import { ingestVideo } from "./ingest.ts";
import {
  CLASS_DETAILS,
  TAG_LABELS,
  byId,
  downloadText,
  fixed,
  formatDuration,
  formatTimecode,
  getEngineStatus,
  percent,
  showToast,
} from "./ui.ts";

interface Session {
  sourceName: string;
  sourceKind: "video" | "demo";
  frames: FrameAnalysis[];
  thumbnails: string[];
  images: string[];
  waveform: Float32Array;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
}

type Filter = FrameClass | "all";

const state = {
  session: null as Session | null,
  selected: 0,
  filter: "all" as Filter,
  zoom: 1,
  panX: 0,
  panY: 0,
  playing: false,
  manual: new Map<number, FrameClass>(),
  frameToken: 0,
};

const imageCache = new Map<number, HTMLImageElement>();
const filmNodes: HTMLButtonElement[] = [];
let currentImage: HTMLImageElement | null = null;
let playTimer = 0;
let dragOrigin: { x: number; y: number; panX: number; panY: number } | null = null;
let loupePoint: { x: number; y: number } | null = null;

const dom = {
  sourceName: byId<HTMLElement>("sourceName"),
  sourceMeta: byId<HTMLElement>("sourceMeta"),
  noticeBar: byId<HTMLElement>("noticeBar"),
  noticeText: byId<HTMLElement>("noticeText"),
  progressBar: byId<HTMLElement>("progressBar"),
  noticeClose: byId<HTMLButtonElement>("noticeClose"),
  frameCanvas: byId<HTMLCanvasElement>("frameCanvas"),
  canvasStack: byId<HTMLElement>("canvasStack"),
  viewport: byId<HTMLElement>("viewport"),
  seamTag: byId<HTMLElement>("seamTag"),
  loupe: byId<HTMLElement>("loupe"),
  loupeCanvas: byId<HTMLCanvasElement>("loupeCanvas"),
  loupeCoord: byId<HTMLElement>("loupeCoord"),
  frameIndexLabel: byId<HTMLElement>("frameIndexLabel"),
  timecodeLabel: byId<HTMLElement>("timecodeLabel"),
  stageVerdict: byId<HTMLElement>("stageVerdict"),
  verdictPill: byId<HTMLElement>("verdictPill"),
  verdictTitle: byId<HTMLElement>("verdictTitle"),
  verdictSub: byId<HTMLElement>("verdictSub"),
  verdictNote: byId<HTMLElement>("verdictNote"),
  verdictEmblem: byId<HTMLElement>("verdictEmblem"),
  confidenceDial: byId<HTMLElement>("confidenceDial"),
  confidenceValue: byId<HTMLElement>("confidenceValue"),
  evidenceTags: byId<HTMLElement>("evidenceTags"),
  tearScore: byId<HTMLElement>("tearScore"),
  blockScore: byId<HTMLElement>("blockScore"),
  vfxScore: byId<HTMLElement>("vfxScore"),
  tearMeter: byId<HTMLElement>("tearMeter"),
  blockMeter: byId<HTMLElement>("blockMeter"),
  vfxMeter: byId<HTMLElement>("vfxMeter"),
  metricShift: byId<HTMLElement>("metricShift"),
  metricSupport: byId<HTMLElement>("metricSupport"),
  metricSkew: byId<HTMLElement>("metricSkew"),
  metricLines: byId<HTMLElement>("metricLines"),
  metricBlock: byId<HTMLElement>("metricBlock"),
  metricGain: byId<HTMLElement>("metricGain"),
  metricLinesSub: byId<HTMLElement>("metricLinesSub"),
  ruleList: byId<HTMLElement>("ruleList"),
  reviewSelect: byId<HTMLSelectElement>("reviewSelect"),
  reviewState: byId<HTMLElement>("reviewState"),
  filmstrip: byId<HTMLElement>("filmstrip"),
  filmstripScroller: byId<HTMLElement>("filmstripScroller"),
  audioCanvas: byId<HTMLCanvasElement>("audioCanvas"),
  frameScrubber: byId<HTMLInputElement>("frameScrubber"),
  scrubTime: byId<HTMLElement>("scrubTime"),
  scrubDuration: byId<HTMLElement>("scrubDuration"),
  prevFrameBtn: byId<HTMLButtonElement>("prevFrameBtn"),
  nextFrameBtn: byId<HTMLButtonElement>("nextFrameBtn"),
  playBtn: byId<HTMLButtonElement>("playBtn"),
  totalFrames: byId<HTMLElement>("totalFrames"),
  durationLabel: byId<HTMLElement>("durationLabel"),
  exportSummary: byId<HTMLElement>("exportSummary"),
  engineLabel: byId<HTMLElement>("engineLabel"),
  sourceDialog: byId<HTMLDialogElement>("sourceDialog"),
  fileInput: byId<HTMLInputElement>("fileInput"),
  dropZone: byId<HTMLElement>("dropZone"),
  fastIngest: byId<HTMLInputElement>("fastIngest"),
  maxFrames: byId<HTMLSelectElement>("maxFrames"),
  codecStatus: byId<HTMLElement>("codecStatus"),
  exportMenu: byId<HTMLElement>("exportMenu"),
  exportBtn: byId<HTMLButtonElement>("exportBtn"),
  openSourceBtn: byId<HTMLButtonElement>("openSourceBtn"),
  exportWideBtn: byId<HTMLButtonElement>("exportWideBtn"),
  toast: byId<HTMLElement>("toast"),
};

void initialize();

async function initialize(): Promise<void> {
  bindEvents();
  dom.codecStatus.textContent = getEngineStatus();
  dom.engineLabel.textContent = `${getEngineStatus()} · 零第三方依赖`;
  drawWaveform();
  await loadDemo();
}

async function loadDemo(): Promise<void> {
  stopPlayback();
  showNotice("正在生成本地合成样例，并逐帧校准横线基线…", 0);
  try {
    const result = await generateDemo(({ ratio, label }) => {
      showNotice(label, ratio);
    });
    acceptSession(
      {
        ...result,
        sourceName: "night_run_capture_demo.mp4",
        sourceKind: "demo",
      },
      "本地合成样例 · 含真实撕裂 / 块错误 / 特效",
    );
  } catch (error) {
    console.error(error);
    showNotice("样例生成失败，可导入本地录像继续。", 0);
    showToast(error instanceof Error ? error.message : "样例生成失败", true);
  }
}

function acceptSession(session: Session, notice: string): void {
  state.session = session;
  state.selected = chooseInitialFrame(session.frames);
  state.filter = "all";
  state.manual.clear();
  imageCache.clear();
  currentImage = null;
  loupePoint = null;
  resetViewer();
  dom.sourceName.textContent = session.sourceName;
  dom.sourceMeta.textContent = `${session.sourceKind === "demo" ? "DEMO" : "LOCAL"} / ${Math.round(session.fps)} FPS / ${session.width}×${session.height}`;
  dom.sourceMeta.title = session.sourceName;
  buildFilmstrip();
  renderSummary();
  void renderFrame();
  showNotice(notice, 1);
  window.setTimeout(() => {
    if (dom.noticeBar.isConnected) hideNotice();
  }, 6200);
}

function chooseInitialFrame(frames: FrameAnalysis[]): number {
  const tear = frames.findIndex((frame) => frame.classification === "tear");
  if (tear >= 0) return tear;
  const anomaly = frames.findIndex((frame) => frame.classification !== "normal");
  return anomaly >= 0 ? anomaly : 0;
}

function effectiveFrames(): FrameAnalysis[] {
  const session = state.session;
  if (!session) return [];
  return session.frames.map((frame, index) => {
    const manual = state.manual.get(index);
    return manual ? { ...frame, classification: manual } : frame;
  });
}

function currentFrame(): FrameAnalysis | null {
  return effectiveFrames()[state.selected] ?? null;
}

function renderSummary(): void {
  const session = state.session;
  if (!session) return;
  const frames = effectiveFrames();
  const summary = summarize(frames);
  setText("countTear", String(summary.counts.tear));
  setText("countBlock", String(summary.counts["encode-block"]));
  setText("countVfx", String(summary.counts["vfx-glitch"]));
  setText("countUncertain", String(summary.counts.uncertain));
  setText("ratioTear", percent(summary.ratios.tear, 1));
  setText("ratioBlock", percent(summary.ratios["encode-block"], 1));
  setText("ratioVfx", percent(summary.ratios["vfx-glitch"], 1));
  setText("ratioUncertain", percent(summary.ratios.uncertain, 1));
  dom.totalFrames.textContent = String(summary.frames);
  dom.durationLabel.textContent = `${summary.counts.normal} 正常 · ${formatDuration(session.durationMs)}`;
  dom.exportSummary.textContent = `${summary.frames} 帧 · ${summary.flaggedFrames} 条异常记录`;
  for (const card of document.querySelectorAll<HTMLElement>("[data-filter]")) {
    card.classList.toggle("is-active", card.dataset.filter === state.filter);
  }
  updateFilmFilter();
}

function showNotice(message: string, ratio: number): void {
  dom.noticeBar.hidden = false;
  dom.noticeText.textContent = message;
  dom.progressBar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
}

function hideNotice(): void {
  dom.noticeBar.hidden = true;
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

async function renderFrame(): Promise<void> {
  const session = state.session;
  const frame = currentFrame();
  if (!session || !frame) return;
  const token = ++state.frameToken;
  loupePoint = null;
  dom.frameIndexLabel.textContent = `FRAME ${String(frame.index).padStart(3, "0")}`;
  dom.timecodeLabel.textContent = formatTimecode(frame.timestampMs);
  dom.scrubTime.textContent = formatTimecode(frame.timestampMs);
  dom.scrubDuration.textContent = formatTimecode(session.durationMs);
  dom.frameScrubber.max = String(Math.max(0, session.frames.length - 1));
  dom.frameScrubber.value = String(state.selected);
  dom.frameScrubber.style.setProperty(
    "--fill",
    `${(state.selected / Math.max(1, session.frames.length - 1)) * 100}%`,
  );
  renderInspector(frame);
  updateFilmSelection();
  const image = await loadImage(state.selected);
  if (token !== state.frameToken) return;
  currentImage = image;
  drawMainFrame();
  updateLoupe();
}

function loadImage(index: number): Promise<HTMLImageElement | null> {
  const session = state.session;
  if (!session) return Promise.resolve(null);
  const cached = imageCache.get(index);
  if (cached) return Promise.resolve(cached.complete ? cached : null);
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      imageCache.set(index, image);
      resolve(image);
    };
    image.onerror = () => resolve(null);
    image.src = session.images[index] ?? session.thumbnails[index];
  });
}

function drawMainFrame(): void {
  const session = state.session;
  if (!session) return;
  const canvas = dom.frameCanvas;
  canvas.width = session.width;
  canvas.height = session.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (currentImage) {
    context.drawImage(currentImage, 0, 0, canvas.width, canvas.height);
  } else {
    context.fillStyle = "#0b1218";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  const frame = currentFrame();
  const seam = frame?.seam;
  const visible =
    !!seam &&
    Math.abs(seam.shift) >= 2 &&
    (frame.classification === "tear" || frame.classification === "uncertain" || seam.confidence > 0.48);
  dom.canvasStack.classList.toggle("has-seam", visible);
  dom.canvasStack.classList.toggle("is-tear", frame?.classification === "tear");
  if (seam && visible) {
    const position = `${Math.max(0, Math.min(100, seam.yRatio * 100))}%`;
    dom.canvasStack.style.setProperty("--seam", position);
    dom.canvasStack.style.setProperty("--seam-tag-y", position);
    dom.seamTag.textContent = `SEAM ${seam.shift > 0 ? "+" : ""}${seam.shift}px · ${percent(seam.support)}`;
    dom.loupe.classList.add("is-visible");
  } else {
    dom.seamTag.textContent = "NO SEAM";
    dom.loupe.classList.remove("is-visible");
  }
}

function updateLoupe(): void {
  const session = state.session;
  const frame = currentFrame();
  if (!session || !frame || !currentImage) return;
  const canvas = dom.loupeCanvas;
  const context = canvas.getContext("2d");
  if (!context) return;
  const sourceWidth = 47;
  const sourceHeight = (sourceWidth * canvas.height) / canvas.width;
  const seamY = frame.seam ? frame.seam.y : session.height / 2;
  const centerX = loupePoint?.x ?? session.width / 2;
  const x = Math.max(0, Math.min(session.width - sourceWidth, centerX - sourceWidth / 2));
  const y = Math.max(0, Math.min(session.height - sourceHeight, seamY - sourceHeight / 2));
  context.fillStyle = "#070c11";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(
    currentImage,
    x,
    y,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  dom.loupeCoord.textContent = `x ${Math.round(x + sourceWidth / 2)} · y ${Math.round(y + sourceHeight / 2)}`;
}

function buildFilmstrip(): void {
  const session = state.session;
  if (!session) return;
  filmNodes.length = 0;
  const fragment = document.createDocumentFragment();
  session.frames.forEach((frame, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "film-frame";
    button.dataset.index = String(index);
    button.dataset.kind = frame.classification;
    button.title = `#${index} · ${CLASS_DETAILS[frame.classification].short} · ${formatTimecode(frame.timestampMs)}`;
    const image = document.createElement("img");
    image.src = session.thumbnails[index];
    image.alt = "";
    image.loading = "lazy";
    const flag = document.createElement("span");
    flag.className = "frame-flag";
    const number = document.createElement("span");
    number.className = "frame-num";
    number.textContent = String(index).padStart(3, "0");
    button.append(image, flag, number);
    fragment.append(button);
    filmNodes.push(button);
  });
  dom.filmstrip.replaceChildren(fragment);
  updateFilmSelection();
}

function updateFilmSelection(): void {
  for (const node of filmNodes) {
    const index = Number(node.dataset.index);
    node.classList.toggle("is-selected", index === state.selected);
  }
  updateFilmFilter();
  const selected = filmNodes[state.selected];
  if (selected) {
    const scroller = dom.filmstripScroller;
    const left = selected.offsetLeft;
    const right = left + selected.offsetWidth;
    if (left < scroller.scrollLeft + 24 || right > scroller.scrollLeft + scroller.clientWidth - 24) {
      scroller.scrollTo({ left: left - scroller.clientWidth / 2 + selected.offsetWidth / 2, behavior: "smooth" });
    }
  }
}

function updateFilmFilter(): void {
  for (const node of filmNodes) {
    const frame = state.session?.frames[Number(node.dataset.index)];
    if (!frame) continue;
    const manual = state.manual.get(frame.index);
    const kind = manual ?? frame.classification;
    node.dataset.kind = kind;
    node.classList.toggle("is-filtered", state.filter !== "all" && kind !== state.filter);
  }
}

function renderInspector(frame: FrameAnalysis): void {
  const details = CLASS_DETAILS[frame.classification];
  dom.stageVerdict.textContent = details.title;
  dom.verdictPill.textContent = `${details.short} · ${details.tag ?? frame.classification.toUpperCase()}`;
  dom.verdictPill.dataset.kind = frame.classification;
  dom.verdictTitle.textContent = details.short;
  dom.verdictSub.textContent = `#${String(frame.index).padStart(3, "0")} · ${formatTimecode(frame.timestampMs)} · ${details.short}`;
  dom.verdictNote.textContent = frame.note;
  dom.verdictEmblem.dataset.kind = frame.classification;
  dom.confidenceValue.textContent = String(Math.round(frame.confidence * 100));
  dom.confidenceDial.style.setProperty("--dial-fill", `${frame.confidence * 100}%`);
  dom.confidenceDial.style.setProperty("--dial", details.color);
  dom.reviewState.textContent = state.manual.has(frame.index) ? "人工复核" : "自动";
  dom.reviewSelect.value = state.manual.get(frame.index) ?? "";

  dom.tearScore.textContent = fixed(frame.tearScore);
  dom.blockScore.textContent = fixed(frame.encodeScore);
  dom.vfxScore.textContent = fixed(frame.vfxScore);
  dom.tearMeter.style.width = `${frame.tearScore * 100}%`;
  dom.blockMeter.style.width = `${frame.encodeScore * 100}%`;
  dom.vfxMeter.style.width = `${frame.vfxScore * 100}%`;

  const seam = frame.seam;
  dom.metricShift.textContent = seam ? `${seam.shift > 0 ? "+" : ""}${seam.shift} px` : "—";
  dom.metricSupport.textContent = seam ? percent(seam.support) : "—";
  dom.metricSkew.textContent = percent(frame.metrics.crossFrameSkew);
  dom.metricLines.textContent = percent(frame.metrics.lineDensity, 1);
  dom.metricLinesSub.textContent = `爆发 +${percent(frame.metrics.lineBurst)}`;
  dom.metricBlock.textContent = percent(Math.max(frame.metrics.blockGrid, frame.metrics.blockAnomaly));
  dom.metricGain.textContent = seam ? percent(seam.seamGain) : "—";
  highlightMetric(dom.metricShift, frame.classification === "tear" ? "is-hot" : "");
  highlightMetric(dom.metricSupport, seam && seam.support >= 0.42 ? "is-cool" : "");
  highlightMetric(dom.metricSkew, frame.metrics.crossFrameSkew > 0.34 ? "is-warm" : "");
  highlightMetric(dom.metricLines, frame.metrics.lineBurst > 0.34 ? "is-warm" : "");
  highlightMetric(dom.metricBlock, frame.classification === "encode-block" ? "is-warm" : "");
  highlightMetric(dom.metricGain, seam && seam.seamGain > 0.22 ? "is-hot" : "");

  renderTags(frame);
  renderRules(frame);
}

function highlightMetric(element: HTMLElement, className: string): void {
  element.classList.remove("is-hot", "is-warm", "is-cool");
  if (className) element.classList.add(className);
}

function renderTags(frame: FrameAnalysis): void {
  const fragment = document.createDocumentFragment();
  if (frame.tags.length === 0) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "证据稳定";
    fragment.append(tag);
  }
  for (const tag of frame.tags) {
    const element = document.createElement("span");
    element.className = "tag";
    const hot =
      tag === "seam-shift" || tag === "cross-time-skew" || tag === "line-burst" || tag === "localized-block";
    if (hot) element.classList.add("hot");
    element.textContent = TAG_LABELS[tag];
    fragment.append(element);
  }
  dom.evidenceTags.replaceChildren(fragment);
}

function renderRules(frame: FrameAnalysis): void {
  const seam = frame.seam;
  const shiftPass = !!seam && Math.abs(seam.shift) >= 2 && seam.support >= 0.42;
  const residualPass = !!seam && seam.seamGain >= 0.22;
  const temporalPass = frame.metrics.crossFrameSkew >= 0.34;
  const linePass = frame.metrics.lineBurst < 0.22;
  const blockPass = Math.max(frame.metrics.blockGrid, frame.metrics.blockAnomaly) < 0.55;
  const vfxPass = frame.vfxScore < 0.46;
  const rules: Array<[string, string, "pass" | "fail" | "warn"]> = [
    [
      "整幅水平位移",
      seam ? `${seam.shift > 0 ? "+" : ""}${seam.shift}px / ${percent(seam.support)}` : "未形成",
      shiftPass ? "pass" : "fail",
    ],
    [
      "缝隙残差被位移消除",
      seam ? percent(seam.seamGain) : "—",
      residualPass ? "pass" : "fail",
    ],
    [
      "上下半幅跨帧时差",
      percent(frame.metrics.crossFrameSkew),
      temporalPass ? "pass" : "warn",
    ],
    [
      "高频横线相对基线",
      `+${percent(frame.metrics.lineBurst)}`,
      linePass ? "pass" : "warn",
    ],
    [
      "编码块/局部网格证据",
      percent(Math.max(frame.metrics.blockGrid, frame.metrics.blockAnomaly)),
      blockPass ? "pass" : "warn",
    ],
    [
      "游戏特效复现证据",
      percent(frame.vfxScore),
      vfxPass ? "pass" : "warn",
    ],
  ];
  const fragment = document.createDocumentFragment();
  for (const [label, value, status] of rules) {
    const item = document.createElement("li");
    item.className = status;
    const marker = document.createElement("i");
    const text = document.createElement("span");
    text.textContent = label;
    const result = document.createElement("em");
    result.textContent = value;
    item.append(marker, text, result);
    fragment.append(item);
  }
  dom.ruleList.replaceChildren(fragment);
}

function selectFrame(index: number, stop = false): void {
  const session = state.session;
  if (!session) return;
  if (stop) stopPlayback();
  state.selected = Math.max(0, Math.min(session.frames.length - 1, index));
  void renderFrame();
  drawWaveform();
}

function navigateFrame(delta: number): void {
  const session = state.session;
  if (!session) return;
  stopPlayback();
  const next = state.selected + delta;
  selectFrame((next + session.frames.length) % session.frames.length);
}

function togglePlayback(): void {
  if (state.playing) {
    stopPlayback();
    return;
  }
  const session = state.session;
  if (!session || session.frames.length < 2) return;
  state.playing = true;
  dom.playBtn.classList.add("is-playing");
  const interval = Math.max(24, 1000 / Math.max(1, session.fps));
  playTimer = window.setInterval(() => {
    if (!state.session || state.selected >= state.session.frames.length - 1) {
      stopPlayback();
      return;
    }
    selectFrame(state.selected + 1);
  }, interval);
}

function stopPlayback(): void {
  state.playing = false;
  window.clearInterval(playTimer);
  playTimer = 0;
  dom.playBtn.classList.remove("is-playing");
}

function setZoom(value: number): void {
  state.zoom = Math.max(1, Math.min(10, value));
  if (state.zoom === 1) {
    state.panX = 0;
    state.panY = 0;
  }
  applyZoom();
}

function resetViewer(): void {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  applyZoom();
}

function applyZoom(): void {
  dom.canvasStack.style.transform = `translate3d(${state.panX}px, ${state.panY}px, 0) scale(${state.zoom})`;
  dom.viewport.classList.toggle("is-zoomed", state.zoom > 1);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-zoom]")) {
    button.classList.toggle("is-active", Number(button.dataset.zoom) === state.zoom);
  }
}

function drawWaveform(): void {
  const canvas = dom.audioCanvas;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(200, canvas.clientWidth);
  const height = 42;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#0a1118";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#1a2a33";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, height / 2 + 0.5);
  context.lineTo(width, height / 2 + 0.5);
  context.stroke();
  const session = state.session;
  if (!session) return;
  const frames = effectiveFrames();
  const waveform = session.waveform;
  const bins = Math.max(waveform.length, frames.length, 1);
  for (let x = 0; x < width; x += 1) {
    const bin = Math.min(bins - 1, Math.floor((x / width) * bins));
    const amplitude = waveform.length
      ? waveform[Math.floor((x / width) * waveform.length)] ?? 0
      : 0.12 + Math.sin(bin * 0.4) * 0.04;
    const h = Math.max(0.5, amplitude * (height - 14));
    context.strokeStyle = "rgba(98, 227, 211, 0.34)";
    context.beginPath();
    context.moveTo(x + 0.5, height / 2 - h / 2);
    context.lineTo(x + 0.5, height / 2 + h / 2);
    context.stroke();
  }
  for (let index = 0; index < frames.length; index += 1) {
    const tone = classificationColor(frames[index].classification);
    if (!tone) continue;
    const x0 = (index / frames.length) * width;
    const x1 = Math.max(x0 + 1, ((index + 1) / frames.length) * width);
    context.fillStyle = tone;
    context.globalAlpha = 0.72;
    context.fillRect(x0, height - 3, x1 - x0, 2);
  }
  context.globalAlpha = 1;
  const playheadX = (state.selected / Math.max(1, frames.length - 1)) * width;
  context.fillStyle = "#eef5f6";
  context.fillRect(playheadX, 2, 1, height - 6);
  context.fillStyle = "#ff7965";
  context.fillRect(playheadX - 2, 0, 5, 2);
}

function classificationColor(kind: FrameClass): string | null {
  if (kind === "normal") return null;
  return CLASS_DETAILS[kind].color;
}

function bindEvents(): void {
  dom.prevFrameBtn.addEventListener("click", () => navigateFrame(-1));
  dom.nextFrameBtn.addEventListener("click", () => navigateFrame(1));
  dom.playBtn.addEventListener("click", togglePlayback);
  dom.frameScrubber.addEventListener("input", () => {
    stopPlayback();
    selectFrame(Number(dom.frameScrubber.value));
  });
  dom.noticeClose.addEventListener("click", hideNotice);

  for (const card of document.querySelectorAll<HTMLButtonElement>("[data-filter]")) {
    card.addEventListener("click", () => {
      const kind = card.dataset.filter as FrameClass;
      state.filter = state.filter === kind ? "all" : kind;
      renderSummary();
      if (state.filter !== "all") {
        const match = effectiveFrames().findIndex((frame) => frame.classification === state.filter);
        if (match >= 0) selectFrame(match, true);
      }
    });
  }

  dom.filmstrip.addEventListener("click", (event) => {
    const target = (event.target as Element).closest<HTMLButtonElement>(".film-frame");
    if (!target) return;
    selectFrame(Number(target.dataset.index), true);
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-zoom]")) {
    button.addEventListener("click", () => setZoom(Number(button.dataset.zoom)));
  }
  dom.viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.22 : 0.82;
      setZoom(state.zoom * factor);
    },
    { passive: false },
  );
  dom.viewport.addEventListener("pointerdown", (event) => {
    if (state.zoom <= 1 || event.button !== 0) return;
    dragOrigin = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
    dom.viewport.classList.add("is-dragging");
    dom.viewport.setPointerCapture(event.pointerId);
  });
  dom.viewport.addEventListener("pointermove", (event) => {
    if (dragOrigin) {
      state.panX = dragOrigin.panX + event.clientX - dragOrigin.x;
      state.panY = dragOrigin.panY + event.clientY - dragOrigin.y;
      applyZoom();
      return;
    }
    updateLoupePoint(event);
  });
  const endDrag = (): void => {
    dragOrigin = null;
    dom.viewport.classList.remove("is-dragging");
  };
  dom.viewport.addEventListener("pointerup", endDrag);
  dom.viewport.addEventListener("pointercancel", endDrag);
  dom.viewport.addEventListener("pointerleave", () => {
    loupePoint = null;
    updateLoupe();
  });
  dom.viewport.addEventListener("dblclick", () => setZoom(1));

  dom.reviewSelect.addEventListener("change", () => {
    const value = dom.reviewSelect.value as FrameClass | "";
    const original = state.session?.frames[state.selected];
    if (!original) return;
    if (!value || value === original.classification) state.manual.delete(state.selected);
    else state.manual.set(state.selected, value);
    renderSummary();
    const frame = currentFrame();
    if (frame) renderInspector(frame);
    drawMainFrame();
    drawWaveform();
    showToast(value ? "已记录人工复核分类" : "已恢复自动判定");
  });

  dom.openSourceBtn.addEventListener("click", () => {
    dom.codecStatus.textContent = getEngineStatus();
    dom.sourceDialog.showModal();
  });
  dom.fileInput.addEventListener("change", () => {
    const file = dom.fileInput.files?.[0];
    dom.fileInput.value = "";
    if (file) void startIngest(file);
  });
  dom.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dom.dropZone.classList.add("is-over");
  });
  dom.dropZone.addEventListener("dragleave", () => dom.dropZone.classList.remove("is-over"));
  dom.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dom.dropZone.classList.remove("is-over");
    const file = event.dataTransfer?.files[0];
    if (file) void startIngest(file);
  });

  dom.exportBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = dom.exportMenu.hidden;
    dom.exportMenu.hidden = !open;
    dom.exportBtn.setAttribute("aria-expanded", String(open));
  });
  for (const button of dom.exportMenu.querySelectorAll<HTMLButtonElement>("[data-export]")) {
    button.addEventListener("click", () => {
      exportData(button.dataset.export as "csv" | "json" | "stats");
    });
  }
  dom.exportWideBtn.addEventListener("click", () => exportData("csv"));
  document.addEventListener("click", (event) => {
    if (!(event.target as Element).closest(".export-menu")) {
      dom.exportMenu.hidden = true;
      dom.exportBtn.setAttribute("aria-expanded", "false");
    }
  });

  window.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement ||
      dom.sourceDialog.open
    ) {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      navigateFrame(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      navigateFrame(1);
    } else if (event.key === " ") {
      event.preventDefault();
      togglePlayback();
    } else if (event.key === "Escape") {
      setZoom(1);
    }
  });
  window.addEventListener("resize", drawWaveform);
}

function updateLoupePoint(event: PointerEvent): void {
  const session = state.session;
  if (!session) return;
  const rect = dom.frameCanvas.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  ) {
    loupePoint = null;
  } else {
    loupePoint = {
      x: ((event.clientX - rect.left) / rect.width) * session.width,
      y: ((event.clientY - rect.top) / rect.height) * session.height,
    };
  }
  updateLoupe();
}

async function startIngest(file: File): Promise<void> {
  if (dom.sourceDialog.open) dom.sourceDialog.close();
  stopPlayback();
  showNotice(`正在本地解码 ${file.name}…`, 0);
  const fast = dom.fastIngest.checked;
  const maxFrames = Number(dom.maxFrames.value) || 480;
  try {
    const result = await ingestVideo({
      file,
      fast,
      maxFrames,
      onProgress: (ratio, label) => showNotice(label, ratio),
    });
    if (result.frames.length === 0) throw new Error("未能从录像中取样到画面。");
    acceptSession(
      {
        ...result,
        sourceName: file.name,
        sourceKind: "video",
      },
      `本地解码完成：${result.frames.length} 帧 · 所有数据保留在浏览器内`,
    );
  } catch (error) {
    console.error(error);
    showNotice("录像导入失败。请尝试 MP4(H.264) 或 WebM。", 0);
    showToast(error instanceof Error ? error.message : "录像导入失败", true);
  }
}

function exportData(kind: "csv" | "json" | "stats"): void {
  const session = state.session;
  if (!session) {
    showToast("暂无可导出的检测结果", true);
    return;
  }
  const frames = effectiveFrames();
  const meta: ReportMeta = {
    sourceName: session.sourceName,
    sourceKind: session.sourceKind,
    durationMs: session.durationMs,
    sampledFps: session.fps,
    analyzedAt: new Date().toISOString(),
    settings: {
      analysisWidth: 384,
      minShiftPx: 2,
      minSupport: 0.42,
    },
  };
  const report = buildReport(frames, meta);
  const base = session.sourceName.replace(/\.[^.]+$/, "").replace(/[^\w\u4e00-\u9fa5-]+/g, "_");
  if (kind === "csv") {
    downloadText(`${base}_frames.csv`, framesToCsv(frames), "text/csv");
    showToast(`已导出 ${frames.length} 帧 CSV`);
  } else if (kind === "json") {
    downloadText(`${base}_report.json`, reportToJson(report), "application/json");
    showToast("已导出完整 JSON 取证报告");
  } else {
    downloadText(`${base}_summary.csv`, summaryToCsv(report.summary), "text/csv");
    showToast("已导出五类分类统计");
  }
  dom.exportMenu.hidden = true;
  dom.exportBtn.setAttribute("aria-expanded", "false");
}
