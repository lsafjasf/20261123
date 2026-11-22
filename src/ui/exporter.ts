/**
 * 导出管线（浏览器专用）：
 * Canvas -> VideoFrame -> VideoEncoder(VP9)
 * PCM -> AudioData -> AudioEncoder(Opus)
 * chunk 字节 -> WebmWriter -> Blob(.webm)
 */

import { WebmWriter, type ChunkInput } from "../core/muxer.ts";
import { RENDER_HEIGHT, RENDER_WIDTH, renderFrame, type RenderContext } from "./canvas-render.ts";
import { secToUs } from "../core/timeline.ts";

export interface ExportOptions {
  frameRate: number;
  sampleRate: number;
  audioChannels: number;
  /** 每帧渲染回调，用于进度条。 */
  onProgress?: (ratio: number) => void;
  /** 可选：替换 VideoEncoder 构造，方便降级测试。 */
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  bytes: number;
  frameCount: number;
}

function assertWebCodecs(): void {
  if (typeof globalThis.VideoEncoder === "undefined" || typeof globalThis.AudioEncoder === "undefined") {
    throw new Error("当前浏览器不支持 WebCodecs，无法导出视频");
  }
}

/**
 * 主导出流程。audioPcm 为与时间线等长的交错 PCM（多声道平铺）。
 */
export async function exportWebm(
  canvas: HTMLCanvasElement,
  renderContext: RenderContext,
  durationSec: number,
  audioPcm: Float32Array,
  options: ExportOptions,
): Promise<ExportResult> {
  assertWebCodecs();
  const { frameRate, sampleRate, audioChannels } = options;
  const writer = new WebmWriter(
    { width: RENDER_WIDTH, height: RENDER_HEIGHT, frameRate },
    {
      sampleRate,
      channels: audioChannels,
      // Opus Head（WebM CodecPrivate）：'OpusHead' + 版本/声道/预跳过/采样率/gain/映射。
      codecPrivate: buildOpusHead(sampleRate, audioChannels),
    },
  );
  writer.start();

  const videoChunks = await encodeVideo(canvas, renderContext, durationSec, frameRate, options);
  for (const chunk of videoChunks) writer.addChunk(chunk);
  const audioChunks = await encodeAudio(audioPcm, sampleRate, audioChannels);
  for (const chunk of audioChunks) writer.addChunk(chunk);

  const bytes = writer.finish();
  return {
    blob: new Blob([bytes], { type: "video/webm;codecs=vp9,opus" }),
    bytes: bytes.length,
    frameCount: videoChunks.length,
  };
}

async function encodeVideo(
  canvas: HTMLCanvasElement,
  renderContext: RenderContext,
  durationSec: number,
  frameRate: number,
  options: ExportOptions,
): Promise<ChunkInput[]> {
  const chunks: ChunkInput[] = [];
  let failed: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({
        kind: "video",
        timestampUs: chunk.timestamp,
        data,
        keyframe: chunk.type === "key",
      });
      void metadata;
    },
    error: (error) => {
      failed = error;
    },
  });
  encoder.configure({
    codec: "vp09.00.10.08",
    width: RENDER_WIDTH,
    height: RENDER_HEIGHT,
    bitrate: 2_500_000,
    framerate: frameRate,
  });

  const frameDurationUs = secToUs(1 / frameRate);
  const totalFrames = Math.max(1, Math.round(durationSec * frameRate));
  for (let i = 0; i < totalFrames; i++) {
    options.signal?.throwIfAborted();
    const time = i / frameRate;
    renderFrame(canvas, Math.min(time, durationSec - 1e-4), renderContext);
    const frame = new VideoFrame(canvas, { timestamp: i * frameDurationUs, duration: frameDurationUs });
    encoder.encode(frame, { keyFrame: i % (frameRate * 2) === 0 });
    frame.close();
    if (encoder.encodeQueueSize > 4) await encoder.flush().catch(() => undefined);
    if (failed) throw failed;
    options.onProgress?.((i + 1) / (totalFrames + 1));
    // 让出事件循环，避免长时间阻塞 UI。
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await encoder.flush();
  if (failed) throw failed;
  encoder.close();
  return chunks;
}

async function encodeAudio(
  pcm: Float32Array,
  sampleRate: number,
  channels: number,
): Promise<ChunkInput[]> {
  const chunks: ChunkInput[] = [];
  let failed: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ kind: "audio", timestampUs: chunk.timestamp, data, keyframe: true });
    },
    error: (error) => {
      failed = error;
    },
  });
  encoder.configure({
    codec: "opus",
    sampleRate,
    numberOfChannels: channels,
    bitrate: 96_000,
  });

  const frameSamples = Math.floor(sampleRate * 0.02); // Opus 20ms 帧
  const frames = Math.floor(pcm.length / channels / frameSamples);
  for (let i = 0; i < frames; i++) {
    // AudioData 的 f32-planar 要求各声道数据连续平铺：
    // [ch0 frame0..n][ch1 frame0..n]...，先从交错 PCM 拆出平面布局。
    const planar = new Float32Array(frameSamples * channels);
    const base = i * frameSamples * channels;
    for (let sample = 0; sample < frameSamples; sample++) {
      for (let channel = 0; channel < channels; channel++) {
        planar[channel * frameSamples + sample] = pcm[base + sample * channels + channel] ?? 0;
      }
    }
    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: frameSamples,
      numberOfChannels: channels,
      timestamp: secToUs((i * frameSamples) / sampleRate),
      data: planar,
    });
    encoder.encode(audioData);
    audioData.close();
  }
  await encoder.flush();
  if (failed) throw failed;
  encoder.close();
  return chunks;
}

/** 构造 19 字节 OpusHead（Codecprivate）。 */
function buildOpusHead(sampleRate: number, channels: number): Uint8Array {
  const bytes = new Uint8Array(19);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  view.setUint8(8, 1); // version
  view.setUint8(9, channels);
  view.setUint16(10, 0x1388, true); // pre-skip 312@48k 的占位
  view.setUint32(12, sampleRate, true);
  view.setUint16(16, 0, true); // gain
  view.setUint8(18, 0); // 声道映射 family 0
  return bytes;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(text: string, filename: string, mime: string): void {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

/** MediaSource 预览：把导出的 blob 挂到 video 元素。 */
export function openMediaSource(video: HTMLVideoElement, blob: Blob): void {
  if (typeof MediaSource === "undefined") {
    video.src = URL.createObjectURL(blob);
    return;
  }
  const mediaSource = new MediaSource();
  video.src = URL.createObjectURL(mediaSource);
  mediaSource.addEventListener("sourceopen", async () => {
    const sourceBuffer = mediaSource.addSourceBuffer('video/webm;codecs="vp9,opus"');
    sourceBuffer.addEventListener("updateend", () => {
      if (mediaSource.readyState === "open") mediaSource.endOfStream();
    });
    sourceBuffer.appendBuffer(await blob.arrayBuffer());
  }, { once: true });
}
