import {
  chooseCellSize,
  embedWatermark
} from "./watermark.ts";
import { buildPayload, formatCreatorId, validateCreatorId } from "./payload.ts";
import {
  analyzeVideo,
  drawVideoFrame,
  exportMarkedVideo,
  openVideo,
  probeMediaCapabilities,
  type AnalysisFrame,
  type AnalysisResult,
  type ExportResult,
  type VideoMeta
} from "./video.ts";
import type { RgbaImage, Sensitivity } from "./types.ts";

type Strength = "subtle" | "balanced" | "resilient";

interface MarkState {
  file: File | null;
  meta: VideoMeta | null;
  sourceFrame: RgbaImage | null;
  exportUrl: string | null;
  exporting: boolean;
}

interface VerifyState {
  file: File | null;
  meta: VideoMeta | null;
  previewUrl: string | null;
  result: AnalysisResult | null;
  analyzing: boolean;
}

const STRENGTH_AMPLITUDE: Record<Strength, number> = {
  subtle: 3.1,
  balanced: 4.9,
  resilient: 7.6
};

const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  strict: "严格",
  balanced: "均衡",
  aggressive: "宽松"
};

const mark: MarkState = {
  file: null,
  meta: null,
  sourceFrame: null,
  exportUrl: null,
  exporting: false
};

const verify: VerifyState = {
  file: null,
  meta: null,
  previewUrl: null,
  result: null,
  analyzing: false
};

let strength: Strength = "balanced";
let sensitivity: Sensitivity = "balanced";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

function setText(id: string, value: string): void {
  byId(id).textContent = value;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "00:00";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function toast(message: string, isError = false): void {
  const element = byId("toast");
  element.textContent = message;
  element.classList.toggle("is-error", isError);
  element.classList.add("is-visible");
  window.clearTimeout(Number(element.dataset.timer ?? 0));
  const timer = window.setTimeout(() => element.classList.remove("is-visible"), 3400);
  element.dataset.timer = String(timer);
}

function parseCreatorId(): number {
  const input = byId<HTMLInputElement>("creator-id");
  const digits = input.value.replace(/[^\d]/g, "").slice(0, 10);
  input.value = digits;
  try {
    return validateCreatorId(Number(digits));
  } catch {
    return 0;
  }
}

function randomCreatorId(): void {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  const id = Math.max(1, values[0] >>> 0);
  byId<HTMLInputElement>("creator-id").value = String(id);
  refreshMarkPreview();
}

function updateMarkStats(): void {
  const stats = byId("mark-stats").querySelectorAll("strong");
  if (!mark.meta || !mark.sourceFrame) {
    stats.forEach((element) => (element.textContent = "—"));
    return;
  }
  const cell = chooseCellSize(mark.meta.width, mark.meta.height);
  stats[0].textContent = `${mark.meta.width} × ${mark.meta.height}`;
  stats[1].textContent = formatDuration(mark.meta.duration);
  stats[2].textContent = `${cell} px · ${cell * 12} × ${cell * 8}`;
  stats[3].textContent = "保留音轨";
}

function drawMarkPreview(): void {
  if (!mark.sourceFrame) return;
  const canvas = byId<HTMLCanvasElement>("mark-canvas");
  const creatorId = parseCreatorId();
  const image = creatorId
    ? embedWatermark(mark.sourceFrame, {
        creatorId,
        amplitude: STRENGTH_AMPLITUDE[strength]
      })
    : mark.sourceFrame;
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.putImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    0,
    0
  );
  setText("monitor-id", creatorId ? `CREATOR ${formatCreatorId(creatorId)}` : "CREATOR #——");
  setText(
    "monitor-geometry",
    `CELL ${chooseCellSize(image.width, image.height)} PX · 96 BIT`
  );
}

function refreshMarkPreview(): void {
  drawMarkPreview();
  const creatorId = parseCreatorId();
  byId<HTMLButtonElement>("mark-export").disabled =
    !mark.file || !creatorId || mark.exporting;
}

function resetMarkDrop(): void {
  byId("mark-drop").hidden = false;
  byId("mark-monitor").hidden = true;
  byId("mark-file-chip").textContent = "未载入";
  byId("mark-file-chip").className = "status-chip";
  mark.file = null;
  mark.meta = null;
  mark.sourceFrame = null;
  mark.exporting = false;
  byId<HTMLButtonElement>("mark-export").disabled = true;
  byId("mark-result").hidden = true;
  byId("mark-progress-wrap").hidden = true;
  byId("mark-progress-bar").style.width = "0%";
  updateMarkStats();
  if (mark.exportUrl) {
    URL.revokeObjectURL(mark.exportUrl);
    mark.exportUrl = null;
  }
}

async function loadMarkFile(file: File): Promise<void> {
  if (mark.exporting) {
    toast("请等待当前导出完成。", true);
    return;
  }
  try {
    const probe = await openVideo(file);
    try {
      mark.file = file;
      mark.meta = probe.meta;
      mark.sourceFrame = drawVideoFrame(probe.video, 1000);
    } finally {
      probe.close();
    }
    byId("mark-drop").hidden = true;
    byId("mark-monitor").hidden = false;
    byId("mark-file-chip").textContent = `${formatDuration(mark.meta.duration)} · ${mark.meta.width}×${mark.meta.height}`;
    byId("mark-file-chip").className = "status-chip live";
    setText("monitor-timecode", `00:00:00 / ${formatDuration(mark.meta.duration)}`);
    updateMarkStats();
    refreshMarkPreview();
    byId("mark-result").hidden = true;
  } catch (error) {
    toast((error as Error).message || "视频无法解码。", true);
  }
}

async function runMarkExport(): Promise<void> {
  if (!mark.file || mark.exporting) return;
  const creatorId = parseCreatorId();
  if (!creatorId) {
    toast("创建者编号需为 1 – 4,294,967,295 的整数。", true);
    return;
  }
  mark.exporting = true;
  byId<HTMLButtonElement>("mark-export").disabled = true;
  byId("mark-progress-wrap").hidden = false;
  byId("mark-result").hidden = true;
  const bar = byId("mark-progress-bar");
  const updateProgress = (ratio: number, label: string): void => {
    bar.style.width = `${Math.max(0, Math.min(100, ratio * 100)).toFixed(1)}%`;
    setText("mark-progress-label", label);
    setText("mark-progress-value", `${Math.round(ratio * 100)}%`);
  };
  updateProgress(0, "准备逐帧写入");

  try {
    const result: ExportResult = await exportMarkedVideo(
      mark.file,
      creatorId,
      STRENGTH_AMPLITUDE[strength],
      updateProgress
    );
    if (mark.exportUrl) URL.revokeObjectURL(mark.exportUrl);
    mark.exportUrl = result.url;
    const extension = result.mimeType.includes("mp4") ? "mp4" : "webm";
    const base = (mark.meta?.name ?? "video").replace(/\.[^.]+$/, "");
    const download = byId<HTMLAnchorElement>("mark-download");
    download.href = result.url;
    download.download = `frametrace-${creatorId}-${base}.${extension}`;
    setText("mark-result-name", download.download);
    setText("result-frames", String(result.frames));
    setText(
      "result-format",
      result.mimeType.includes("vp9") ? "WebM · VP9" : result.mimeType.includes("vp8") ? "WebM · VP8" : "WebM"
    );
    setText("result-size", formatBytes(result.blob.size));
    byId("mark-result").hidden = false;
    updateProgress(1, "来源副本已生成");
    toast(`来源码 ${formatCreatorId(creatorId)} 已写入每一帧。`);
  } catch (error) {
    updateProgress(0, "导出失败");
    toast((error as Error).message || "导出失败，请尝试较短的视频。", true);
  } finally {
    mark.exporting = false;
    byId<HTMLButtonElement>("mark-export").disabled = !mark.file || !parseCreatorId();
  }
}

async function loadVerifyFile(file: File): Promise<void> {
  if (verify.analyzing) {
    toast("请等待当前核验完成。", true);
    return;
  }
  try {
    const probe = await openVideo(file);
    verify.meta = probe.meta;
    probe.close();
    if (verify.previewUrl) URL.revokeObjectURL(verify.previewUrl);
    verify.previewUrl = URL.createObjectURL(file);
    verify.file = file;
    verify.result = null;

    const video = byId<HTMLVideoElement>("verify-video");
    video.src = verify.previewUrl;
    video.load();
    byId("verify-drop").hidden = true;
    byId("verify-clip").hidden = false;
    byId("verify-clip-name").textContent = file.name;
    byId("verify-clip-dims").textContent =
      `${verify.meta.width}×${verify.meta.height} · ${formatDuration(verify.meta.duration)} · ${formatBytes(file.size)}`;
    byId("verify-file-chip").textContent = "已载入";
    byId("verify-file-chip").className = "status-chip live";
    byId<HTMLButtonElement>("verify-run").disabled = false;
    resetVerdict();
    byId("verify-file").setAttribute("data-ready", "true");
  } catch (error) {
    toast((error as Error).message || "片段无法解码。", true);
  }
}

function resetVerdict(): void {
  byId("verdict-empty").hidden = false;
  byId("verdict-content").hidden = true;
  byId("verdict-status").textContent = verify.file ? "等待核验" : "等待片段";
  byId("verdict-status").className = "status-chip neutral";
  byId("verify-progress-wrap").hidden = true;
}

function resetVerifyDrop(): void {
  verify.file = null;
  verify.meta = null;
  verify.result = null;
  if (verify.previewUrl) URL.revokeObjectURL(verify.previewUrl);
  verify.previewUrl = null;
  byId("verify-drop").hidden = false;
  byId("verify-clip").hidden = true;
  byId("verify-file-chip").textContent = "未载入";
  byId("verify-file-chip").className = "status-chip";
  byId<HTMLButtonElement>("verify-run").disabled = true;
  resetVerdict();
}

async function runVerification(): Promise<void> {
  if (!verify.file || verify.analyzing) return;
  verify.analyzing = true;
  byId<HTMLButtonElement>("verify-run").disabled = true;
  byId("verify-progress-wrap").hidden = false;
  const bar = byId("verify-progress-bar");
  const updateProgress = (ratio: number, label: string): void => {
    bar.style.width = `${Math.max(0, Math.min(100, ratio * 100)).toFixed(1)}%`;
    setText("verify-progress-label", label);
    setText("verify-progress-value", `${Math.round(ratio * 100)}%`);
  };
  updateProgress(0, "准备扫描帧内几何");

  try {
    const result = await analyzeVideo(verify.file, sensitivity, updateProgress);
    verify.result = result;
    renderVerdict(result);
    updateProgress(1, "证据汇总完成");
    toast(
      result.result.found
        ? `命中来源 ${formatCreatorId(result.result.creatorId as number)}，置信度 ${result.result.confidence}%。`
        : "片段未达到来源命中阈值。"
    );
  } catch (error) {
    updateProgress(0, "核验失败");
    toast((error as Error).message || "核验过程失败。", true);
  } finally {
    verify.analyzing = false;
    byId<HTMLButtonElement>("verify-run").disabled = !verify.file;
  }
}

function bestAnalysisFrame(frames: AnalysisFrame[]): AnalysisFrame | null {
  return frames.reduce<AnalysisFrame | null>((best, frame) => {
    if (!best) return frame;
    const left =
      (frame.detection.found ? 1000 : 0) +
      frame.detection.confidence * 2 +
      frame.detection.syncMatches * 3 +
      frame.detection.signal;
    const right =
      (best.detection.found ? 1000 : 0) +
      best.detection.confidence * 2 +
      best.detection.syncMatches * 3 +
      best.detection.signal;
    return left > right ? frame : best;
  }, null);
}

function renderVerdict(result: AnalysisResult): void {
  const merged = result.result;
  const best = bestAnalysisFrame(result.frames);
  const detection = best?.detection ?? null;
  const found = merged.found && merged.creatorId !== null;
  const status = byId("verdict-status");
  status.textContent = found ? "来源命中" : "未达阈值";
  status.className = found ? "status-chip hit" : "status-chip miss";
  byId("verdict-empty").hidden = true;
  byId("verdict-content").hidden = false;

  const label = byId("verdict-label");
  label.textContent = found ? "VERIFIED SOURCE" : "NO VERIFIED SOURCE";
  label.classList.toggle("is-miss", !found);
  setText("verdict-id", found ? formatCreatorId(merged.creatorId as number) : "未命中");
  setText("verdict-summary", merged.reason);
  setText("confidence-value", String(merged.confidence));
  byId("confidence-ring").style.setProperty("--value", String(merged.confidence));

  setText("evidence-sync", detection ? `${detection.syncMatches} / 16` : "—");
  setText(
    "evidence-crc",
    found ? (detection && detection.correctedBits > 0 ? "通过 · 已纠错" : "CRC24 通过") : "未通过"
  );
  setText("evidence-hamming", detection ? `${detection.correctedBits} 组` : "—");
  setText("evidence-frames", `${merged.hits} / ${merged.frames}`);
  setText(
    "evidence-geometry",
    detection?.geometry
      ? `CELL ${detection.geometry.cellSize.toFixed(1)}PX · PHASE ${detection.geometry.phaseX},${detection.geometry.phaseY}`
      : "—"
  );

  if (best) {
    drawEvidenceFrame(best.image, detection, found);
    renderBitmap(detection);
  } else {
    clearCanvas("evidence-canvas");
    byId("bitmap").replaceChildren();
  }
  renderTimeline(result.frames);
  setText("timeline-caption", `${result.frames.length} 帧采样 · ${merged.frames} 帧参与`);

  const note = byId("evidence-note");
  note.textContent = found
    ? "同步位、汉明纠错与 CRC24 在同一条编号上闭合。置信度综合了逐帧相关强度与跨帧一致性，而不是画面相似度。"
    : "候选结构未通过完整性校验或跨帧一致性不足，因此不输出创建者编号。可尝试更完整的片段或放宽灵敏度。";
}

function clearCanvas(id: string): void {
  const canvas = byId<HTMLCanvasElement>(id);
  const context = canvas.getContext("2d");
  if (context) context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawEvidenceFrame(
  image: RgbaImage,
  detection: AnalysisResult["frames"][number]["detection"] | null,
  found: boolean
): void {
  const canvas = byId<HTMLCanvasElement>("evidence-canvas");
  const targetWidth = 640;
  const targetHeight = Math.max(180, Math.round((targetWidth * image.height) / image.width));
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  canvas.style.aspectRatio = `${image.width} / ${image.height}`;
  const context = canvas.getContext("2d");
  if (!context) return;

  const source = document.createElement("canvas");
  source.width = image.width;
  source.height = image.height;
  const sourceContext = source.getContext("2d");
  if (!sourceContext) return;
  sourceContext.putImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    0,
    0
  );
  context.drawImage(source, 0, 0, targetWidth, targetHeight);
  context.fillStyle = "rgba(1, 6, 4, 0.18)";
  context.fillRect(0, 0, targetWidth, targetHeight);

  if (!detection?.geometry) {
    context.strokeStyle = "rgba(255,123,123,.55)";
    context.fillStyle = "rgba(2,8,5,.72)";
    context.fillRect(14, targetHeight - 38, 208, 24);
    context.font = "10px monospace";
    context.fillStyle = "#ff9d9d";
    context.fillText("NO VERIFIED ANCHOR", 24, targetHeight - 22);
    return;
  }

  const scale = targetWidth / image.width;
  const cell = detection.geometry.cellSize * scale;
  const offsetX = detection.geometry.offsetX * scale;
  const offsetY = detection.geometry.offsetY * scale;
  if (cell >= 2.2) {
    context.beginPath();
    context.strokeStyle = "rgba(133,255,201,.19)";
    context.lineWidth = 0.6;
    for (let x = offsetX % cell; x < targetWidth; x += cell) {
      context.moveTo(x, 0);
      context.lineTo(x, targetHeight);
    }
    for (let y = offsetY % cell; y < targetHeight; y += cell) {
      context.moveTo(0, y);
      context.lineTo(targetWidth, y);
    }
    context.stroke();
  }

  const tileWidth = cell * 12;
  const tileHeight = cell * 8;
  for (const tile of detection.tiles.slice(0, 10)) {
    if (tile.agreement < 0.54) continue;
    const x = tile.x * scale;
    const y = tile.y * scale;
    context.fillStyle = "rgba(85,230,165,.075)";
    context.fillRect(x, y, tileWidth, tileHeight);
    context.strokeStyle = tile.agreement >= 0.66 ? "rgba(85,230,165,.72)" : "rgba(85,230,165,.34)";
    context.lineWidth = 1;
    context.strokeRect(x + 0.5, y + 0.5, tileWidth - 1, tileHeight - 1);
  }

  context.fillStyle = "rgba(2,8,5,.76)";
  context.fillRect(14, 14, 242, 27);
  context.font = "9px monospace";
  context.fillStyle = found ? "#9ff5c9" : "#f1c46b";
  context.fillText(
    `${found ? "VERIFIED" : "CANDIDATE"} · CELL ${detection.geometry.cellSize.toFixed(1)}PX`,
    24,
    31
  );
}

function renderBitmap(
  detection: AnalysisResult["frames"][number]["detection"] | null
): void {
  const container = byId("bitmap");
  container.replaceChildren();
  const values = detection?.bitValues ?? [];
  const bits = detection?.bitMatrix ?? [];
  const maxMagnitude = values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  for (let index = 0; index < 96; index += 1) {
    const cell = document.createElement("i");
    if (bits.length === 96) {
      cell.classList.add(bits[index] === 1 ? "positive" : "negative");
      if (maxMagnitude > 0 && Math.abs(values[index] ?? 0) < maxMagnitude * 0.16) {
        cell.classList.add("uncertain");
      }
      cell.title = `bit ${String(index + 1).padStart(2, "0")} · ${bits[index] === 1 ? "+" : "−"} · 强度 ${(values[index] ?? 0).toFixed(2)}`;
    }
    container.append(cell);
  }
}

function renderTimeline(frames: AnalysisFrame[]): void {
  const container = byId("timeline-bars");
  container.replaceChildren();
  for (const frame of frames) {
    const bar = document.createElement("i");
    const detection = frame.detection;
    if (detection.found) {
      bar.classList.add("hit");
      bar.style.height = `${Math.min(100, 62 + detection.confidence * 0.38)}%`;
    } else if (detection.bitValues.length === 96) {
      bar.classList.add("tentative");
      bar.style.height = `${Math.min(75, 26 + detection.syncMatches * 2.6)}%`;
    } else {
      bar.style.height = "14%";
    }
    bar.title =
      `帧 ${frame.index + 1} · ${formatDuration(frame.timestamp)} · ` +
      `${detection.found ? "命中" : detection.bitValues.length ? "候选" : "无证据"} · ` +
      `同步 ${detection.syncMatches}/16`;
    container.append(bar);
  }
}

function activateView(view: "mark" | "verify" | "method"): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".nav-item")) {
    button.classList.toggle("is-active", button.dataset.view === view);
  }
  for (const section of document.querySelectorAll<HTMLElement>(".view")) {
    const active = section.id === `view-${view}`;
    section.hidden = !active;
    section.classList.toggle("is-visible", active);
  }
  const steps = document.querySelectorAll<HTMLElement>(".workflow-step");
  steps.forEach((step, index) => {
    const isMarkStep = index < 2;
    step.classList.toggle(
      "is-active",
      (view === "mark" && isMarkStep) || (view === "verify" && index === 2)
    );
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setStrength(next: Strength): void {
  strength = next;
  const labels: Record<Strength, string> = {
    subtle: "隐蔽",
    balanced: "均衡",
    resilient: "强韧"
  };
  setText("strength-output", labels[next]);
  for (const button of document.querySelectorAll<HTMLButtonElement>("#strength-control button")) {
    const selected = button.dataset.strength === next;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", String(selected));
  }
  refreshMarkPreview();
}

function setSensitivity(next: Sensitivity): void {
  sensitivity = next;
  setText("sensitivity-output", SENSITIVITY_LABEL[next]);
  for (const button of document.querySelectorAll<HTMLButtonElement>("#sensitivity-control button")) {
    const selected = button.dataset.sensitivity === next;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", String(selected));
  }
}

function bindDrop(
  dropId: string,
  inputId: string,
  handler: (file: File) => void
): void {
  const drop = byId(dropId);
  const input = byId<HTMLInputElement>(inputId);
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) handler(file);
    input.value = "";
  });
  for (const eventName of ["dragenter", "dragover"]) {
    drop.addEventListener(eventName, (event) => {
      event.preventDefault();
      drop.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    drop.addEventListener(eventName, (event) => {
      event.preventDefault();
      drop.classList.remove("is-dragging");
    });
  }
  drop.addEventListener("drop", (event) => {
    const file = (event as DragEvent).dataTransfer?.files?.[0];
    if (file) handler(file);
  });
}

function buildMethodGrid(): void {
  const container = byId("method-grid");
  container.replaceChildren();
  const symbols = buildPayload(1).symbols;
  for (let index = 0; index < 96; index += 1) {
    const cell = document.createElement("i");
    cell.className = symbols[index] ? "high" : "low";
    container.append(cell);
  }
}

function initializeEvents(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".nav-item")) {
    button.addEventListener("click", () => {
      const view = button.dataset.view as "mark" | "verify" | "method";
      activateView(view);
    });
  }

  bindDrop("mark-drop", "mark-file", (file) => void loadMarkFile(file));
  bindDrop("verify-drop", "verify-file", (file) => void loadVerifyFile(file));
  byId("mark-choose").addEventListener("click", () => byId<HTMLInputElement>("mark-file").click());
  byId("verify-choose").addEventListener("click", () => byId<HTMLInputElement>("verify-file").click());
  byId("mark-replace").addEventListener("click", () => {
    if (mark.exporting) {
      toast("请等待当前导出完成。", true);
      return;
    }
    resetMarkDrop();
    byId<HTMLInputElement>("mark-file").click();
  });
  byId("verify-replace").addEventListener("click", () => {
    if (verify.analyzing) {
      toast("请等待当前核验完成。", true);
      return;
    }
    resetVerifyDrop();
    byId<HTMLInputElement>("verify-file").click();
  });

  const idInput = byId<HTMLInputElement>("creator-id");
  idInput.addEventListener("input", () => {
    idInput.value = idInput.value.replace(/[^\d]/g, "").slice(0, 10);
    refreshMarkPreview();
  });
  idInput.addEventListener("blur", () => {
    const value = Number(idInput.value);
    if (value > 0xffffffff) idInput.value = "4294967295";
    if (value < 1) idInput.value = "88420719";
    refreshMarkPreview();
  });
  byId("random-id").addEventListener("click", randomCreatorId);
  byId("mark-export").addEventListener("click", () => void runMarkExport());
  byId("verify-run").addEventListener("click", () => void runVerification());

  for (const button of document.querySelectorAll<HTMLButtonElement>("#strength-control button")) {
    button.addEventListener("click", () => setStrength(button.dataset.strength as Strength));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("#sensitivity-control button")) {
    button.addEventListener("click", () =>
      setSensitivity(button.dataset.sensitivity as Sensitivity)
    );
  }
}

async function initializeCapabilities(): Promise<void> {
  const capabilities = await probeMediaCapabilities();
  setText(
    "engine-status",
    capabilities.webAudio ? "Canvas / WebAudio / MSE" : "Canvas"
  );
  setText(
    "codec-status",
    capabilities.webCodecs
      ? capabilities.vp9
        ? "WebCodecs · VP9"
        : "WebCodecs · 可用"
      : capabilities.mediaRecorder
        ? "MediaRecorder"
        : "不可用"
  );
}

async function init(): Promise<void> {
  buildMethodGrid();
  initializeEvents();
  setStrength("balanced");
  setSensitivity("balanced");
  updateMarkStats();
  await initializeCapabilities();
}

void init();
