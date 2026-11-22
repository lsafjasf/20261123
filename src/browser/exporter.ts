import { muxWebm, type EncodedVideoSample } from "../core/webm.js";
import type { FrameScheduleEntry } from "../core/types.js";
import type { PreviewInterpolator } from "./interpolator.js";
import type { SourceInfo } from "./sources.js";

export interface ExportProgress {
  frame: number;
  total: number;
  stage: "interpolate" | "encode" | "mux" | "load";
}

export interface ExportResult {
  blob: Blob;
  buffer: ArrayBuffer;
  mimeType: string;
  durationSec: number;
}

export function exportSupported(): boolean {
  return (
    typeof VideoEncoder !== "undefined" &&
    typeof VideoFrame !== "undefined" &&
    typeof MediaSource !== "undefined"
  );
}

async function waitForQueue(encoder: VideoEncoder, limit = 8): Promise<void> {
  while (encoder.encodeQueueSize > limit) {
    await new Promise<void>((resolve) => setTimeout(resolve, 4));
  }
}

export async function exportInterpolatedVideo(
  interpolator: PreviewInterpolator,
  schedule: FrameScheduleEntry[],
  info: SourceInfo,
  onProgress?: (progress: ExportProgress) => void
): Promise<ExportResult> {
  if (!exportSupported()) throw new Error("当前浏览器不支持 WebCodecs 导出");
  const config: VideoEncoderConfig = {
    codec: "vp8",
    width: info.width,
    height: info.height,
    bitrate: Math.max(2_000_000, Math.round(info.width * info.height * 24)),
    framerate: 60,
    latencyMode: "quality"
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error("当前浏览器无法编码 VP8");

  const sampleRate = 60;
  const samples: EncodedVideoSample[] = [];
  const encoder = new VideoEncoder({
    output(chunk) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({
        timestampUs: chunk.timestamp,
        durationUs: chunk.duration ?? Math.round(1_000_000 / sampleRate),
        key: chunk.type === "key",
        data
      });
    },
    error(error) {
      throw error;
    }
  });
  encoder.configure(config);

  const canvas = document.createElement("canvas");
  canvas.width = info.width;
  canvas.height = info.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D 不可用");
  const total = schedule.length;

  for (let index = 0; index < schedule.length; index += 1) {
    const entry = schedule[index];
    const prepared = await interpolator.prepare(entry);
    const image = new ImageData(
      new Uint8ClampedArray(prepared.result.frame.data),
      prepared.result.frame.width,
      prepared.result.frame.height
    );
    context.putImageData(image, 0, 0);
    const frame = new VideoFrame(canvas, {
      timestamp: entry.timestampUs,
      duration: Math.round(1_000_000 / sampleRate)
    });
    encoder.encode(frame, { keyFrame: index % 60 === 0 });
    frame.close();
    if (index % 3 === 0) {
      onProgress?.({ frame: index + 1, total, stage: "interpolate" });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await waitForQueue(encoder);
  }
  onProgress?.({ frame: total, total, stage: "encode" });
  await encoder.flush();
  encoder.close();
  samples.sort((a, b) => a.timestampUs - b.timestampUs);
  onProgress?.({ frame: total, total, stage: "mux" });
  const durationUs = (schedule.at(-1)?.timestampUs ?? 0) + Math.round(1_000_000 / sampleRate);
  const data = muxWebm(samples, {
    width: info.width,
    height: info.height,
    codec: "vp8",
    durationUs,
    frameRate: sampleRate
  });
  const owned = new Uint8Array(data.length);
  owned.set(data);
  const buffer = owned.buffer;
  return {
    blob: new Blob([buffer], { type: "video/webm" }),
    buffer,
    mimeType: 'video/webm; codecs="vp8"',
    durationSec: durationUs / 1_000_000
  };
}

export async function playWithMediaSource(
  video: HTMLVideoElement,
  buffer: ArrayBuffer,
  mimeType: string
): Promise<() => void> {
  if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(mimeType)) {
    const url = URL.createObjectURL(new Blob([buffer], { type: "video/webm" }));
    video.src = url;
    await video.play().catch(() => undefined);
    return () => URL.revokeObjectURL(url);
  }

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;
  await new Promise<void>((resolve) => {
    mediaSource.addEventListener("sourceopen", () => resolve(), { once: true });
  });
  const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
  await new Promise<void>((resolve, reject) => {
    sourceBuffer.addEventListener("updateend", () => resolve(), { once: true });
    sourceBuffer.addEventListener(
      "error",
      () => reject(new Error("MediaSource 追加失败")),
      { once: true }
    );
    sourceBuffer.appendBuffer(buffer);
  });
  if (mediaSource.readyState === "open") mediaSource.endOfStream();
  await video.play().catch(() => undefined);
  return () => {
    URL.revokeObjectURL(objectUrl);
    if (mediaSource.readyState === "open") mediaSource.endOfStream();
  };
}
