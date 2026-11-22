import { KeyframeRingBuffer, type ReplaySnapshot } from "./ring-buffer.ts";
import { TrailScene } from "./scene.ts";
import { LiveRecorder, type RecorderTelemetry } from "./live-recorder.ts";

const MAX_DURATION_US = 90_000_000;
const MAX_BYTES = 192 * 1024 * 1024;

function element<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing UI element #${id}`);
  }
  return found as T;
}

const liveCanvas = element<HTMLCanvasElement>("liveCanvas");
const startButton = element<HTMLButtonElement>("startButton");
const stopButton = element<HTMLButtonElement>("stopButton");
const replayButton = element<HTMLButtonElement>("replayButton");
const replayVideo = element<HTMLVideoElement>("replayVideo");
const replayEmpty = element<HTMLDivElement>("replayEmpty");
const liveBadge = element<HTMLSpanElement>("liveBadge");
const liveBadgeText = element<HTMLElement>("liveBadgeText");
const sourceLabel = element<HTMLElement>("sourceLabel");
const encoderReadout = element<HTMLElement>("encoderReadout");
const sessionClock = element<HTMLElement>("sessionClock");
const canvasInfo = element<HTMLElement>("canvasInfo");
const bufferWatermark = element<HTMLElement>("bufferWatermark");
const bufferFill = element<HTMLDivElement>("bufferFill");
const bufferMarker = element<HTMLDivElement>("bufferMarker");
const pressureBadge = element<HTMLElement>("pressureBadge");
const gopCount = element<HTMLElement>("gopCount");
const keyframeCount = element<HTMLElement>("keyframeCount");
const bufferBytes = element<HTMLElement>("bufferBytes");
const audioFrameCount = element<HTMLElement>("audioFrameCount");
const ringNote = element<HTMLElement>("ringNote");
const bitrateValue = element<HTMLElement>("bitrateValue");
const videoFrameValue = element<HTMLElement>("videoFrameValue");
const skipValue = element<HTMLElement>("skipValue");
const audioModeValue = element<HTMLElement>("audioModeValue");
const warningLine = element<HTMLElement>("warningLine");
const replayTitle = element<HTMLElement>("replayTitle");
const replayRange = element<HTMLElement>("replayRange");
const replayState = element<HTMLDivElement>("replayState");
const historyBody = element<HTMLTableSectionElement>("historyBody");
const historyCount = element<HTMLElement>("historyCount");
const toast = element<HTMLElement>("toast");
const footerEndpoint = element<HTMLElement>("footerEndpoint");

const ring = new KeyframeRingBuffer({
  maxDurationUs: MAX_DURATION_US,
  maxBytes: MAX_BYTES,
});
const scene = new TrailScene(liveCanvas);
scene.start();

let recorder: LiveRecorder | null = null;
let sessionEpoch = Date.now();
let starting = false;
let replayWorker: Worker | null = null;
let replayBusy = false;
let activeRequestId = 0;
let requestCounter = 0;
let replayObjectUrl: string | null = null;
let toastTimer = 0;

interface ReplayRecord {
  id: number;
  requestId: number;
  startUs: number;
  endUs: number;
  durationMs: number;
  keyframeOrdinal: number;
  videoFrames: number;
  audioFrames: number;
  bytes: number;
  status: "building" | "ready" | "error";
  message: string;
  mimeType: string;
  clipUrl: string | null;
  clusterCount: number;
}

const replayRecords: ReplayRecord[] = [];

function formatBytes(value: number): string {
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(0)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes} 分 ${remainder.toFixed(1)} 秒`;
}

function formatClock(timestampUs: number): string {
  const date = new Date(sessionEpoch + timestampUs / 1000);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const millis = String(date.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 4_000);
}

function setReplayState(kind: "idle" | "busy" | "ready" | "error", message: string): void {
  replayState.classList.remove("is-busy", "is-ready", "is-error");
  replayState.classList.add(`is-${kind}`);
  const label = replayState.querySelector("span");
  if (label) {
    label.textContent = message;
  }
}

function updateBufferView(telemetry: RecorderTelemetry | null): void {
  const stats = ring.stats();
  const seconds = stats.durationUs / 1_000_000;
  const percentage = Math.min(100, (seconds / (MAX_DURATION_US / 1_000_000)) * 100);
  bufferWatermark.innerHTML = `${seconds.toFixed(1)}<small>s</small>`;
  bufferFill.style.width = `${percentage}%`;
  bufferMarker.style.left = `${percentage}%`;
  bufferMarker.style.opacity = stats.videoFrameCount ? "1" : "0";
  gopCount.textContent = String(stats.gopCount);
  keyframeCount.textContent = stats.keyframeOrdinal ? `#${stats.keyframeOrdinal}` : "—";
  bufferBytes.textContent = formatBytes(stats.totalBytes);
  audioFrameCount.textContent = String(stats.audioFrameCount);

  const memoryPressure = stats.totalBytes / MAX_BYTES;
  pressureBadge.classList.remove("is-high", "is-critical");
  if (stats.overBudget) {
    pressureBadge.textContent = "活动 GOP 超预算";
    pressureBadge.classList.add("is-critical");
    bufferFill.style.background = "linear-gradient(90deg, #7a473c, #ff836c)";
    ringNote.textContent = "当前 GOP 已超出内存预算，但不会被截断；等下一个关键帧到达后再从完整 GOP 边界淘汰。";
  } else if (memoryPressure >= 0.8) {
    pressureBadge.textContent = "高水位";
    pressureBadge.classList.add("is-high");
    bufferFill.style.background = "linear-gradient(90deg, #7d693c, #f3b968)";
    ringNote.textContent = "内存水位偏高，编码器将提前请求关键帧，旧 GOP 仍按完整边界淘汰。";
  } else {
    pressureBadge.textContent = stats.videoFrameCount ? "余量充足" : "空闲";
    bufferFill.style.background = "linear-gradient(90deg, #657e42, #d6f37a)";
    ringNote.textContent = "窗口按关键帧对齐，允许最多一个 GOP 溢出；活动 GOP 即使超预算也不会被截断。";
  }

  if (telemetry?.running) {
    bitrateValue.textContent = `${telemetry.bitrateKbps} kbps`;
    videoFrameValue.textContent = String(telemetry.videoFrames);
    skipValue.textContent = String(telemetry.skippedVideoFrames);
    audioModeValue.textContent = telemetry.audioMode === "microphone"
      ? "本机麦克风"
      : telemetry.audioMode === "synthetic" ? "本地合成声" : "不可用";
    warningLine.hidden = !telemetry.warning;
    warningLine.textContent = telemetry.warning ?? "";
  } else {
    bitrateValue.textContent = "— kbps";
    audioModeValue.textContent = "—";
    warningLine.hidden = true;
  }

  if (recorder) {
    liveBadge.classList.add("is-live");
    liveBadgeText.textContent = "LIVE";
    encoderReadout.textContent = `${telemetry?.cameraActive ? "摄像头" : "演示画面"} · ${telemetry?.bitrateKbps ?? 0} kbps`;
    sourceLabel.textContent = telemetry?.cameraActive ? "本机摄像头画面" : "本地演示画面";
    const now = Math.max(0, Date.now() - sessionEpoch);
    sessionClock.textContent = formatElapsed(now);
  } else {
    liveBadge.classList.remove("is-live");
    liveBadgeText.textContent = stats.videoFrameCount ? "已结束" : "待机";
    encoderReadout.textContent = stats.videoFrameCount ? "本地缓冲可回放" : "缓冲尚未开始";
    sourceLabel.textContent = stats.videoFrameCount ? "已结束 · 回放仍可用" : "本地演示画面";
    const latest = stats.latestUs / 1000;
    sessionClock.textContent = formatElapsed(latest);
  }

  replayButton.disabled = replayBusy || !stats.videoFrameCount;
}

async function requestLocalMedia(): Promise<MediaStream | null> {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("本机没有可用的媒体采集接口，使用内置演示画面。");
    return null;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    return stream;
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "MediaError";
    showToast(`没有获得摄像头/麦克风权限（${name}），已切换到本地演示画面。所有数据仍只留在本机。`);
    return null;
  }
}

async function startLive(): Promise<void> {
  if (starting || recorder) {
    return;
  }
  starting = true;
  startButton.disabled = true;
  stopButton.disabled = true;
  try {
    const stream = await requestLocalMedia();
    ring.clear();
    sessionEpoch = Date.now();
    const nextRecorder = new LiveRecorder({
      canvas: liveCanvas,
      scene,
      ring,
      onError: (message) => {
        showToast(message);
        refreshUi();
      },
    });
    recorder = nextRecorder;
    await nextRecorder.start(stream);
    stopButton.disabled = false;
    setReplayState("idle", ring.stats().videoFrameCount ? "缓冲就绪" : "等待首帧");
    showToast(stream ? "直播已开始；最近 90 秒将写入本机环形缓冲。" : "本地演示直播已开始；最近 90 秒只写入本机内存。");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = recorder;
    recorder = null;
    await failed?.stop().catch(() => undefined);
    showToast(`直播启动失败：${message}`);
  } finally {
    starting = false;
    refreshUi();
  }
}

async function stopLive(): Promise<void> {
  if (!recorder) {
    return;
  }
  const current = recorder;
  recorder = null;
  stopButton.disabled = true;
  startButton.disabled = true;
  await current.stop().catch((error: unknown) => {
    showToast(`停止时发生错误：${error instanceof Error ? error.message : String(error)}`);
  });
  startButton.disabled = false;
  showToast("直播已结束；已缓冲的关键帧片段仍可回放和下载。");
  refreshUi();
}

function ensureReplayWorker(): Worker {
  if (replayWorker) {
    return replayWorker;
  }
  const worker = new Worker(new URL("./replay-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    handleWorkerReply(event.data);
  };
  worker.onerror = (event) => {
    showToast(`回放封装 Worker 异常：${event.message}`);
    worker.terminate();
    if (replayWorker === worker) {
      replayWorker = null;
    }
    if (activeRequestId) {
      finishReplayFailure(activeRequestId, `Worker 异常：${event.message}`);
    }
  };
  replayWorker = worker;
  return worker;
}

function requestReplay(): void {
  if (replayBusy) {
    showToast("上一段仍在独立 Worker 中封装，已忽略重复点击；直播录制未受影响。");
    return;
  }
  const snapshot = ring.snapshot();
  if (!snapshot) {
    showToast("还没有可回放的关键帧数据，请先开启直播。");
    return;
  }
  const requestId = ++requestCounter;
  const record: ReplayRecord = {
    id: replayRecords.length + 1,
    requestId,
    startUs: snapshot.anchorKeyframeUs,
    endUs: snapshot.sourceEndUs,
    durationMs: snapshot.durationMs,
    keyframeOrdinal: snapshot.keyframeOrdinal,
    videoFrames: snapshot.videoFrames.length,
    audioFrames: snapshot.audioFrames.length,
    bytes: snapshot.bytes,
    status: "building",
    message: "",
    mimeType: "",
    clipUrl: null,
    clusterCount: 0,
  };
  replayRecords.push(record);
  replayBusy = true;
  activeRequestId = requestId;
  replayButton.disabled = true;
  replayTitle.textContent = `片段 #${record.id} 正在生成`;
  replayRange.textContent = `${formatClock(record.startUs)} → ${formatClock(record.endUs)} · ${formatDuration(record.durationMs)}`;
  setReplayState("busy", "关键帧快照已隔离，Worker 封装中");
  renderHistory();

  const worker = ensureReplayWorker();
  const transfers: ArrayBuffer[] = [];
  for (const frame of [...snapshot.videoFrames, ...snapshot.audioFrames]) {
    transfers.push(frame.data.buffer as ArrayBuffer);
  }
  try {
    worker.postMessage({
      type: "mux",
      requestId,
      snapshot,
      width: liveCanvas.width,
      height: liveCanvas.height,
      audioChannels: 2,
    }, transfers);
  } catch (error) {
    finishReplayFailure(requestId, error instanceof Error ? error.message : String(error));
  }
}

function handleWorkerReply(message: WorkerReply): void {
  if (message.requestId !== activeRequestId) {
    return;
  }
  if (message.type === "error") {
    finishReplayFailure(message.requestId, message.message);
    return;
  }
  const record = replayRecords.find((item) => item.requestId === message.requestId);
  if (!record) {
    finishReplayFailure(message.requestId, "找不到对应的回放记录");
    return;
  }
  record.status = "ready";
  record.message = "MediaSource 片段已生成";
  record.mimeType = message.mimeType;
  record.clusterCount = message.clusterCount;
  record.videoFrames = message.videoFrameCount;
  record.audioFrames = message.audioFrameCount;
  record.durationMs = message.durationMs;
  record.bytes = message.buffer.byteLength;
  const blob = new Blob([message.buffer], { type: message.mimeType });
  record.clipUrl = URL.createObjectURL(blob);
  releaseOldClipUrls(record.id);
  replayTitle.textContent = `片段 #${record.id} 已生成`;
  replayRange.textContent = replayRecordDetail(record);
  setReplayState("busy", "正在装载 MediaSource");
  renderHistory();

  void playClip(message.buffer, message.mimeType, message.durationMs)
    .then((autoplayed) => {
      replayBusy = false;
      activeRequestId = 0;
      setReplayState("ready", autoplayed ? "正在回放 · 直播未中断" : "片段就绪 · 点击视频播放");
      replayEmpty.hidden = true;
      renderHistory();
      updateBufferView(recorder?.getTelemetry() ?? null);
    })
    .catch((error: unknown) => {
      replayBusy = false;
      activeRequestId = 0;
      const text = error instanceof Error ? error.message : String(error);
      setReplayState("error", `片段已生成，回放装载失败：${text}`);
      showToast("片段已保存为本地 Blob；点击视频区播放，或使用下载链接。");
      renderHistory();
      updateBufferView(recorder?.getTelemetry() ?? null);
    });
}

function finishReplayFailure(requestId: number, message: string): void {
  const record = replayRecords.find((item) => item.requestId === requestId);
  if (record) {
    record.status = "error";
    record.message = message;
  }
  replayBusy = false;
  activeRequestId = 0;
  setReplayState("error", `封装失败：${message}`);
  replayTitle.textContent = record ? `片段 #${record.id} 生成失败` : "片段生成失败";
  showToast(`回放片段生成失败：${message}`);
  renderHistory();
  updateBufferView(recorder?.getTelemetry() ?? null);
}

function replayRecordDetail(record: ReplayRecord): string {
  return [
    `${formatClock(record.startUs)} → ${formatClock(record.endUs)}`,
    formatDuration(record.durationMs),
    `起始关键帧 #${record.keyframeOrdinal}`,
    `${record.videoFrames} 视频帧 / ${record.audioFrames} 音频帧`,
    `${record.clusterCount} clusters`,
    formatBytes(record.bytes),
  ].join(" · ");
}

async function playClip(buffer: ArrayBuffer, mimeType: string, durationMs: number): Promise<boolean> {
  if (!MediaSource.isTypeSupported(mimeType)) {
    throw new Error(`当前浏览器不支持 ${mimeType}`);
  }
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  const previousUrl = replayObjectUrl;
  replayObjectUrl = objectUrl;
  replayVideo.pause();
  replayVideo.src = objectUrl;
  replayVideo.classList.add("is-ready");
  replayEmpty.hidden = true;
  if (previousUrl) {
    URL.revokeObjectURL(previousUrl);
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("MediaSource 初始化超时"));
      }
    }, 8_000);
    const fail = (message: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      reject(new Error(message));
    };
    const open = (): void => {
      try {
        const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        const appended = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          window.clearTimeout(timeout);
          try {
            if (mediaSource.readyState === "open") {
              mediaSource.duration = durationMs / 1000;
              mediaSource.endOfStream();
            }
          } catch {
          }
          resolve();
        };
        sourceBuffer.addEventListener("updateend", appended, { once: true });
        sourceBuffer.addEventListener("error", () => fail("SourceBuffer 拒绝了 WebM 片段"), { once: true });
        sourceBuffer.appendBuffer(buffer);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    };
    mediaSource.addEventListener("sourceopen", open, { once: true });
    mediaSource.addEventListener("sourceclose", () => fail("MediaSource 提前关闭"), { once: true });
  });

  replayVideo.currentTime = 0;
  try {
    await replayVideo.play();
    return true;
  } catch {
    return false;
  }
}

function releaseOldClipUrls(keepRecordId: number): void {
  const downloadable = replayRecords.filter((record) => record.clipUrl);
  while (downloadable.length > 8) {
    const oldest = downloadable.shift();
    if (!oldest || oldest.id === keepRecordId || !oldest.clipUrl) {
      continue;
    }
    URL.revokeObjectURL(oldest.clipUrl);
    oldest.clipUrl = null;
    oldest.message = "本地 Blob 已释放";
  }
}

function renderHistory(): void {
  historyBody.replaceChildren();
  historyCount.textContent = `${replayRecords.length} 段`;
  if (!replayRecords.length) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = "还没有回放记录。直播开始几秒后即可回放。";
    row.append(cell);
    historyBody.append(row);
    return;
  }

  for (const record of replayRecords) {
    const row = document.createElement("tr");
    const id = document.createElement("td");
    id.className = "history-id";
    id.textContent = `#${String(record.id).padStart(2, "0")}`;
    const range = document.createElement("td");
    range.className = "history-range";
    range.textContent = `${formatClock(record.startUs)} → ${formatClock(record.endUs)}`;
    const duration = document.createElement("td");
    duration.textContent = formatDuration(record.durationMs);
    const keyframe = document.createElement("td");
    keyframe.className = "history-kf";
    keyframe.textContent = `#${record.keyframeOrdinal}`;
    const size = document.createElement("td");
    size.className = "history-size";
    size.textContent = formatBytes(record.bytes);
    const status = document.createElement("td");
    const tag = document.createElement("span");
    tag.className = `status-tag is-${record.status}`;
    tag.textContent = record.status === "building" ? "封装中" : record.status === "ready" ? "已生成" : "失败";
    tag.title = record.message;
    status.append(tag);
    const clip = document.createElement("td");
    if (record.clipUrl) {
      const link = document.createElement("a");
      link.className = "download-link";
      link.href = record.clipUrl;
      link.download = `trail-replay-${record.id}-${formatClock(record.startUs).replaceAll(":", "-")}.webm`;
      link.textContent = "下载 WebM";
      clip.append(link);
    } else {
      clip.textContent = record.status === "building" ? "等待封装" : record.clipUrl === null && record.status === "ready" ? "已释放" : "—";
    }
    row.append(id, range, duration, keyframe, size, status, clip);
    historyBody.append(row);
  }
}

function refreshUi(): void {
  if (recorder && !starting && !recorder.getTelemetry().running) {
    const stopped = recorder;
    recorder = null;
    void stopped.stop().catch(() => undefined);
  }
  const telemetry = recorder?.getTelemetry() ?? null;
  updateBufferView(telemetry);
  const running = Boolean(telemetry?.running);
  startButton.disabled = starting || recorder !== null;
  stopButton.disabled = !running;
  canvasInfo.textContent = `${liveCanvas.width} × ${liveCanvas.height} · 30 fps`;
  footerEndpoint.textContent = `${location.host} · 仅本机访问`;
}

startButton.addEventListener("click", () => {
  void startLive();
});
stopButton.addEventListener("click", () => {
  void stopLive();
});
replayButton.addEventListener("click", requestReplay);
replayVideo.addEventListener("playing", () => {
  if (!replayBusy) {
    setReplayState("ready", "正在回放 · 直播未中断");
  }
});
window.addEventListener("beforeunload", () => {
  replayWorker?.terminate();
  if (replayObjectUrl) {
    URL.revokeObjectURL(replayObjectUrl);
  }
  for (const record of replayRecords) {
    if (record.clipUrl) {
      URL.revokeObjectURL(record.clipUrl);
    }
  }
  void recorder?.stop();
});

renderHistory();
refreshUi();
window.setInterval(refreshUi, 250);

type WorkerReply =
  | {
      type: "result";
      requestId: number;
      buffer: ArrayBuffer;
      mimeType: string;
      durationMs: number;
      clusterCount: number;
      videoFrameCount: number;
      audioFrameCount: number;
    }
  | {
      type: "error";
      requestId: number;
      message: string;
    };
