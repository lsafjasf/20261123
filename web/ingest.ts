import { TearingDetector } from "../src/core/analyzer.ts";
import type { FrameAnalysis } from "../src/core/types.ts";

export interface IngestOptions {
  file: File;
  fast: boolean;
  maxFrames: number;
  onProgress: (ratio: number, label: string) => void;
}

export interface IngestResult {
  frames: FrameAnalysis[];
  thumbnails: string[];
  images: string[];
  waveform: Float32Array;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
}

interface CaptureCanvas {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

export async function ingestVideo(options: IngestOptions): Promise<IngestResult> {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  const objectUrl = URL.createObjectURL(options.file);
  video.src = objectUrl;
  await waitForMetadata(video);
  if (!video.videoWidth || !video.videoHeight) throw new Error("录像没有可解码的视频轨道。");

  const scale = Math.min(1, 960 / video.videoWidth);
  const width = Math.max(2, Math.round(video.videoWidth * scale));
  const height = Math.max(2, Math.round(video.videoHeight * scale));
  const capture = createCaptureCanvas(width, height);
  const detector = new TearingDetector({ analysisWidth: 384 });
  const frames: FrameAnalysis[] = [];
  const thumbnails: string[] = [];
  const images: string[] = [];
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const targetFps = options.fast ? 12 : 30;
  const targetCount = Math.max(1, Math.min(options.maxFrames, Math.ceil(duration * targetFps) || options.maxFrames));
  const waveformPromise = decodeWaveform(options.file);

  if (options.fast || !("requestVideoFrameCallback" in video)) {
    const interval = duration > 0 ? Math.max(1 / targetFps, duration / targetCount) : 1 / targetFps;
    for (let index = 0; index < targetCount; index += 1) {
      const time = Math.min(duration || index * interval, index * interval);
      await seek(video, time);
      captureFrame(video, capture);
      const frame = detector.analyze(
        { width, height, data: capture.context.getImageData(0, 0, width, height).data },
        time * 1000,
      );
      frames.push(frame);
      thumbnails.push(makeThumbnail(capture.canvas));
      images.push(capture.canvas.toDataURL("image/jpeg", 0.84));
      options.onProgress(
        (index + 1) / targetCount,
        `正在解码 ${formatTime(time)} / ${formatTime(duration)} · 帧内断层 ${frames.length}`,
      );
      await nextTask();
    }
  } else {
    await captureDuringPlayback(video, capture, detector, frames, thumbnails, images, options, targetCount);
  }

  const waveform = await waveformPromise;
  video.removeAttribute("src");
  video.load();
  URL.revokeObjectURL(objectUrl);
  return {
    frames,
    thumbnails,
    images,
    waveform,
    width,
    height,
    fps: frames.length > 1 ? (frames.length - 1) / Math.max(0.001, (frames[frames.length - 1].timestampMs - frames[0].timestampMs) / 1000) : targetFps,
    durationMs: duration * 1000 || frames.at(-1)?.timestampMs || 0,
  };
}

async function captureDuringPlayback(
  video: HTMLVideoElement,
  capture: CaptureCanvas,
  detector: TearingDetector,
  frames: FrameAnalysis[],
  thumbnails: string[],
  images: string[],
  options: IngestOptions,
  targetCount: number,
): Promise<void> {
  video.currentTime = 0;
  await seek(video, 0);
  await video.play();
  const callback = video as HTMLVideoElement & {
    requestVideoFrameCallback: (callback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
  };
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      video.pause();
      resolve();
    };
    const onEnded = (): void => finish();
    video.addEventListener("ended", onEnded, { once: true });
    video.addEventListener("error", () => reject(video.error ?? new Error("视频解码失败。")), {
      once: true,
    });
    const tick = (): void => {
      if (finished) return;
      captureFrame(video, capture);
      const timestamp = video.currentTime * 1000;
      frames.push(
        detector.analyze(
          { width: capture.canvas.width, height: capture.canvas.height, data: capture.context.getImageData(0, 0, capture.canvas.width, capture.canvas.height).data },
          timestamp,
        ),
      );
      thumbnails.push(makeThumbnail(capture.canvas));
      images.push(capture.canvas.toDataURL("image/jpeg", 0.84));
      options.onProgress(
        Math.min(1, frames.length / targetCount),
        `逐帧解码 ${formatTime(video.currentTime)} / ${formatTime(Number.isFinite(video.duration) ? video.duration : 0)}`,
      );
      if (frames.length >= targetCount || video.ended) {
        video.removeEventListener("ended", onEnded);
        finish();
        return;
      }
      callback.requestVideoFrameCallback(tick);
    };
    callback.requestVideoFrameCallback(tick);
  });
}

function captureFrame(video: HTMLVideoElement, capture: CaptureCanvas): void {
  const { canvas, context } = capture;
  let frame: VideoFrame | null = null;
  try {
    if (typeof VideoFrame !== "undefined") {
      frame = new VideoFrame(video, { timestamp: Math.round(video.currentTime * 1_000_000) });
      context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    } else {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
  } catch {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
  } finally {
    frame?.close();
  }
}

function createCaptureCanvas(width: number, height: number): CaptureCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法创建 Canvas 2D 取样画布。");
  return { canvas, context };
}

function makeThumbnail(canvas: HTMLCanvasElement): string {
  const thumb = document.createElement("canvas");
  thumb.width = 120;
  thumb.height = 68;
  const context = thumb.getContext("2d");
  context?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL("image/jpeg", 0.7);
}

async function decodeWaveform(file: File): Promise<Float32Array> {
  if (typeof AudioContext === "undefined") return new Float32Array();
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const bins = 900;
    const data = new Float32Array(bins);
    const channel = buffer.getChannelData(0);
    const span = Math.max(1, Math.floor(channel.length / bins));
    for (let i = 0; i < bins; i += 1) {
      let peak = 0;
      const start = i * span;
      const end = Math.min(channel.length, start + span);
      for (let at = start; at < end; at += 1) peak = Math.max(peak, Math.abs(channel[at]));
      data[i] = peak;
    }
    return data;
  } catch {
    return new Float32Array();
  } finally {
    await context.close().catch(() => undefined);
  }
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(video.error ?? new Error("无法读取录像。")), {
      once: true,
    });
  });
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const onSeeked = (): void => finish();
    const finish = (): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    const timeout = window.setTimeout(finish, 900);
    video.addEventListener("seeked", onSeeked);
    try {
      video.currentTime = Math.max(0, Math.min(time, Math.max(0, video.duration - 0.001)));
    } catch {
      finish();
    }
  });
}

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
