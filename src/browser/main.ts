import {
  fraction,
  toNumber,
} from "../core/fraction.ts";
import { PlaybackController } from "../core/playback-controller.ts";
import type {
  DeviceFormat,
  MigrationReason,
  PlaybackSnapshot,
  PlaybackStatus,
} from "../core/types.ts";
import { createDemoSource } from "./demo-source.ts";
import { MediaSourceSurface } from "./media-source-surface.ts";
import { PcmAudioSinkFactory } from "./pcm-audio-sink.ts";
import { drawScene, formatClock } from "./render-scene.ts";

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing element #${id}`);
  }
  return node as T;
}

const canvas = element<HTMLCanvasElement>("stage");
const context = canvas.getContext("2d");
if (context === null) {
  throw new Error("Canvas 2D is not available");
}

const playButton = element<HTMLButtonElement>("play");
const recoverButton = element<HTMLButtonElement>("recover");
const switchButton = element<HTMLButtonElement>("switch");
const outputSelect = element<HTMLSelectElement>("output");
const rateSelect = element<HTMLSelectElement>("rate");
const channelSelect = element<HTMLSelectElement>("channels");
const seek = element<HTMLInputElement>("seek");
const seekLabel = element<HTMLElement>("seek-label");
const statusPill = element<HTMLElement>("status");
const positionText = element<HTMLElement>("position");
const frameText = element<HTMLElement>("frames");
const deviceText = element<HTMLElement>("device");
const errorText = element<HTMLElement>("error");
const logList = element<HTMLOListElement>("log");

const source = createDemoSource(18, 48_000);
let controller: PlaybackController | null = null;
let mediaSurface: MediaSourceSurface | null = null;
let lastStatus: PlaybackStatus = "idle";
let lastLogMessage = "";
let scrubbing = false;
let seeking = false;
let queuedSeek: number | null = null;
let currentSnapshot: PlaybackSnapshot | null = null;

const sinkFactory = new PcmAudioSinkFactory(source, {
  onPosition: (sink, snapshot) => {
    controller?.acceptPositionUpdate({ sink, snapshot });
  },
  onLost: (_sink, error) => {
    addLog(`设备丢失: ${error.message}`);
    void controller?.deviceLost(error.message);
  },
});

controller = new PlaybackController({
  durationFrames: source.durationFrames,
  sampleRate: source.sampleRate,
  sinkFactory,
  onChange: (snapshot) => {
    currentSnapshot = snapshot;
    updateUi(snapshot);
  },
});

function requestedFormat(): DeviceFormat {
  const channelCount = Number(channelSelect.value);
  return {
    deviceId: outputSelect.value || "default",
    label: outputSelect.selectedOptions[0]?.textContent?.trim() || "Default output",
    sampleRate: Number(rateSelect.value),
    channelCount,
    channelLayout:
      channelCount === 1 ? "mono" : channelCount === 2 ? "stereo" : "surround",
  };
}

function migrationReason(next: DeviceFormat, previous: DeviceFormat | null): MigrationReason {
  if (previous === null || next.deviceId !== previous.deviceId) {
    return "device-switch";
  }
  if (next.sampleRate !== previous.sampleRate) {
    return "sample-rate-change";
  }
  return "channel-layout-change";
}

async function refreshDevices(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return;
  }
  const selected = outputSelect.value || "default";
  const devices = await navigator.mediaDevices.enumerateDevices();
  const outputs = devices.filter((device) => device.kind === "audiooutput");
  outputSelect.replaceChildren();
  const defaultOption = new Option("Default output", "default");
  outputSelect.add(defaultOption);
  for (const [index, device] of outputs.entries()) {
    outputSelect.add(
      new Option(device.label || `Output ${index + 1}`, device.deviceId),
    );
  }
  const stillPresent =
    selected === "default" ||
    outputs.some((device) => device.deviceId === selected);
  outputSelect.value = stillPresent ? selected : "default";

  if (
    !stillPresent &&
    currentSnapshot?.device !== null &&
    currentSnapshot?.status !== "interrupted"
  ) {
    addLog("当前输出设备已从系统列表消失");
    await controller?.deviceLost("active output device disappeared");
  }
}

function updateUi(snapshot: PlaybackSnapshot): void {
  statusPill.textContent = snapshot.status;
  statusPill.dataset.status = snapshot.status;
  positionText.textContent = formatClock(snapshot.positionSeconds);
  frameText.textContent = `${Math.floor(toNumber(snapshot.position))} / ${snapshot.durationFrames} src frames`;
  const device = snapshot.device;
  deviceText.textContent =
    device === null
      ? "no output"
      : `${device.label} · ${device.sampleRate} Hz · ${device.channelCount} ch (${device.channelLayout})`;
  errorText.textContent = snapshot.lastError ?? "";
  recoverButton.disabled = !(snapshot.status === "interrupted" && snapshot.recoverable);
  playButton.textContent = snapshot.status === "playing" ? "Pause" : "Play";
  playButton.disabled = snapshot.status === "migrating" || snapshot.status === "loading";

  if (!scrubbing) {
    seek.value = String(
      Math.min(1, snapshot.durationSeconds === 0 ? 0 : snapshot.positionSeconds / snapshot.durationSeconds),
    );
  }
  seekLabel.textContent = `${formatClock(snapshot.positionSeconds)} / ${formatClock(snapshot.durationSeconds)}`;

  if (snapshot.status !== lastStatus) {
    addLog(
      `${lastStatus} → ${snapshot.status} @ src frame ${Math.floor(toNumber(snapshot.position))}`,
    );
    lastStatus = snapshot.status;
  }
  if (
    snapshot.lastError !== null &&
    snapshot.lastError !== lastLogMessage
  ) {
    addLog(snapshot.lastError);
    lastLogMessage = snapshot.lastError;
  }
}

function addLog(message: string): void {
  const item = document.createElement("li");
  const timestamp = new Date().toLocaleTimeString();
  item.textContent = `${timestamp}  ${message}`;
  logList.prepend(item);
  while (logList.childElementCount > 20) {
    logList.lastElementChild?.remove();
  }
}

async function requestSeek(targetFrame: number): Promise<void> {
  queuedSeek = targetFrame;
  if (seeking || controller === null) {
    return;
  }
  seeking = true;
  try {
    while (queuedSeek !== null) {
      const next = queuedSeek;
      queuedSeek = null;
      await controller.seek(fraction(next));
    }
  } finally {
    seeking = false;
  }
}

async function applyFormat(): Promise<void> {
  if (controller === null) {
    return;
  }
  const next = requestedFormat();
  const previous = currentSnapshot?.device ?? null;
  addLog(
    `迁移 ${previous?.sampleRate ?? "?"}Hz/${previous?.channelCount ?? "?"}ch → ${next.sampleRate}Hz/${next.channelCount}ch`,
  );
  await controller.switchDevice(next, migrationReason(next, previous));
}

playButton.addEventListener("click", async () => {
  if (controller === null) {
    return;
  }
  if (currentSnapshot?.status === "playing") {
    await controller.pause();
    return;
  }
  if (
    currentSnapshot !== null &&
    currentSnapshot.positionSeconds >= currentSnapshot.durationSeconds
  ) {
    await controller.seek(fraction(0));
  }
  await controller.play();
});

recoverButton.addEventListener("click", async () => {
  await controller?.recover(requestedFormat());
});

switchButton.addEventListener("click", () => {
  void applyFormat();
});

seek.addEventListener("pointerdown", () => {
  scrubbing = true;
});
seek.addEventListener("pointerup", () => {
  scrubbing = false;
});
seek.addEventListener("input", () => {
  const seconds = Number(seek.value) * source.durationFrames / source.sampleRate;
  seekLabel.textContent = `${formatClock(seconds)} / ${formatClock(source.durationFrames / source.sampleRate)}`;
  void requestSeek(Math.round(Number(seek.value) * source.durationFrames));
});

for (const select of [outputSelect, rateSelect, channelSelect]) {
  select.addEventListener("change", () => {
    void applyFormat();
  });
}

function resizeCanvas(): void {
  const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function renderLoop(): void {
  resizeCanvas();
  if (context === null || controller === null) {
    return;
  }
  const snapshot = controller.snapshot;
  const width = canvas.width;
  const height = canvas.height;
  const presentation = {
    positionSeconds: snapshot.positionSeconds,
    playing: snapshot.status === "playing",
  };
  mediaSurface?.sync(presentation);
  const drewVideo =
    mediaSurface?.draw(context, width, height, presentation.positionSeconds) ??
    false;
  if (!drewVideo) {
    drawScene(context, width, height, snapshot);
  } else {
    context.fillStyle = "rgba(5, 12, 16, 0.54)";
    context.fillRect(0, height * 0.78, width, height * 0.22);
    context.fillStyle = "#f2b84b";
    context.font = `${Math.round(width / 50)}px ui-monospace, monospace`;
    context.fillText(
      `${formatClock(snapshot.positionSeconds)}  ${snapshot.status}`,
      width * 0.03,
      height * 0.86,
    );
  }
  requestAnimationFrame(renderLoop);
}

async function loadOptionalVideo(): Promise<void> {
  let surface: MediaSourceSurface | null = null;
  try {
    const response = await fetch("./public/demo-video.mp4");
    if (!response.ok) {
      return;
    }
    const mimeTypes = [
      'video/mp4; codecs="avc1.42C01E"',
      'video/mp4; codecs="avc1.42E01E"',
    ];
    const mimeType = mimeTypes.find((candidate) =>
      MediaSource.isTypeSupported(candidate),
    );
    if (mimeType === undefined) {
      addLog("浏览器不支持 MSE/H.264，视频面使用 Canvas 动画");
      return;
    }
    surface = new MediaSourceSurface();
    await surface.appendMedia(await response.arrayBuffer(), mimeType);
    mediaSurface = surface;
    addLog("MSE 视频已接入，画面时钟跟随音频 transport");
  } catch (error) {
    surface?.dispose();
    addLog(`MSE 视频不可用: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function start(): Promise<void> {
  outputSelect.value = "default";
  await refreshDevices();
  await controller?.open(requestedFormat());
  addLog("音频 transport 就绪；切换设备会执行精确 handoff");
  void loadOptionalVideo();
  requestAnimationFrame(renderLoop);
}

navigator.mediaDevices?.addEventListener("devicechange", () => {
  void refreshDevices();
});

void start();
