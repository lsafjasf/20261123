import { activeCueAt, activeSentenceAt } from "../shared/cues.js";
import { layoutSubtitle } from "../shared/layout.js";
import { PRESETS } from "../shared/presets.js";
import { frameTimings, frameTimestamp, validateFrameTimings, type FrameRate } from "../shared/timeline.js";
import type { Aspect, FrameTiming, LayoutStyle, PlacementPreference, SubjectBox, SubtitleCue, VideoPreset } from "../shared/types.js";
import { concat } from "./mp4/bytes.js";
import { muxMp4, type EncodedVideoSample } from "./mp4/mux.js";
import { parseMp4, type Mp4File } from "./mp4/reader.js";
import { createCanvas, createMeasure, drawComposite, renderSubtitleLayer } from "./renderer.js";

export interface ExportRequest {
  fileName: string;
  bytes: Uint8Array;
  cues: SubtitleCue[];
  aspect: Aspect;
  style: LayoutStyle;
  subjectBox: SubjectBox | null;
  placement: PlacementPreference;
  onProgress?: (progress: ExportProgress) => void;
}

export interface ExportProgress {
  phase: "decode" | "render" | "encode" | "mux" | "verify" | "done";
  frame: number;
  total: number;
  message: string;
}

export interface FrameMap {
  index: number;
  outputPtsUs: number;
  sourcePtsUs: number;
  durationUs: number;
  cueId: string | null;
  activeSentenceId: number;
  firstLine: string;
  lineCount: number;
  fontSize: number;
}

export interface ExportManifest {
  version: 1;
  generatedAt: string;
  fileName: string;
  aspect: Aspect;
  width: number;
  height: number;
  preset: string;
  encoder: string;
  fps: number;
  frameCount: number;
  sourceSampleCount: number;
  durationUs: number;
  firstPtsUs: number;
  lastPtsUs: number;
  timing: ReturnType<typeof validateFrameTimings>;
  frameMapping: {
    exact: boolean;
    maxErrorUs: number;
    sourceFrames: number;
    outputFrames: number;
  };
  layout: {
    fontSize: number;
    maxFontSize: number;
    lineCounts: Record<string, number>;
    minFontSizeSeen: number;
    warnings: string[];
  };
  audio: {
    sourceSamples: number;
    outputSamples: number;
    sourceBytes: number;
    outputBytes: number;
    sourceSha256: string;
    outputSha256: string;
    bytePreserved: boolean;
    startUs: number;
  };
  frames: FrameMap[];
}

export interface ExportResult {
  blob: Blob;
  manifest: ExportManifest;
  manifestBlob: Blob;
}

interface QueuedFrame {
  frame: VideoFrame;
  timestampUs: number;
}

class FrameQueue {
  private queue: QueuedFrame[] = [];
  private waiters: Array<(value: QueuedFrame | null) => void> = [];
  private finished = false;

  push(frame: VideoFrame, timestampUs: number): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ frame, timestampUs });
    else this.queue.push({ frame, timestampUs });
  }

  finish(): void {
    this.finished = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  async next(): Promise<QueuedFrame | null> {
    const value = this.queue.shift();
    if (value) return value;
    if (this.finished) return null;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

async function waitForDecoderSlot(decoder: VideoDecoder): Promise<void> {
  if (decoder.decodeQueueSize < 8) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 4);
    decoder.addEventListener(
      "dequeue",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

function estimateFrameRate(file: Mp4File): { rate: { numerator: number; denominator: number }; fps: number } {
  const sorted = [...new Set(file.video.samples.map((sample) => sample.cts))].sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let index = 1; index < Math.min(sorted.length, 120); index += 1) {
    const delta = sorted[index] - sorted[index - 1];
    if (delta > 0) deltas.push(delta);
  }
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)] ?? file.video.timescale / 30;
  const candidate = file.video.timescale / median;
  const common = [
    [24, 1],
    [25, 1],
    [30, 1],
    [50, 1],
    [60, 1],
    [24000, 1001],
    [30000, 1001],
    [60000, 1001]
  ];
  const best = common.reduce(
    (current, [numerator, denominator]) => {
      const difference = Math.abs(candidate - numerator / denominator);
      return difference < current.difference ? { numerator, denominator, difference } : current;
    },
    { numerator: 30, denominator: 1, difference: Number.POSITIVE_INFINITY }
  );
  return {
    rate: { numerator: best.numerator, denominator: best.denominator },
    fps: candidate
  };
}

async function chooseEncoderConfig(
  width: number,
  height: number,
  fps: number,
  bitrate: number
): Promise<VideoEncoderConfig> {
  const candidates = ["avc1.4d0033", "avc1.42003e", "avc1.640033", "avc1.4d0028", "avc1.42002a"];
  for (const codec of candidates) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      latencyMode: "realtime",
      avc: { format: "avc" }
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return support.config ?? config;
    } catch {
      // Try the next AVC level/profile.
    }
  }
  throw new Error("当前浏览器 WebCodecs 不支持 AVC 编码");
}

function audioBytes(file: Mp4File): Uint8Array[] {
  if (!file.audio) return [];
  return file.audio.samples.map((sample) => file.bytes.slice(sample.offset, sample.offset + sample.size));
}

async function digestParts(parts: Uint8Array[]): Promise<string> {
  const merged = concat(parts);
  const digest = await crypto.subtle.digest("SHA-256", merged);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeDescription(description: unknown): Uint8Array | null {
  if (!description) return null;
  if (description instanceof ArrayBuffer) return new Uint8Array(description.slice(0));
  if (ArrayBuffer.isView(description)) {
    return new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice();
  }
  return null;
}

async function logFrameMap(
  sourceTimestamps: number[],
  cues: SubtitleCue[],
  preset: VideoPreset,
  style: LayoutStyle,
  ctx: OffscreenCanvasRenderingContext2D,
  subjectBox: SubjectBox | null,
  placement: PlacementPreference,
  rate: FrameRate
): Promise<FrameMap[]> {
  const measure = createMeasure(ctx, style);
  const timings = frameTimings(sourceTimestamps, cues, { originUs: sourceTimestamps[0] ?? 0, rate });
  return timings.map((timing) => {
    const cue = activeCueAt(cues, timing.timestampUs);
    const layout = layoutSubtitle(
      { preset, style, subjectBox, placement, timeUs: timing.timestampUs, cue },
      measure
    );
    return {
      index: timing.index,
      outputPtsUs: timing.timestampUs,
      sourcePtsUs: timing.timestampUs,
      durationUs: timing.durationUs,
      cueId: cue?.id ?? null,
      activeSentenceId: cue ? (activeSentenceAt(cue, timing.timestampUs)?.id ?? -1) : -1,
      firstLine: layout.lines.map((line) => line.text).join(" / ").slice(0, 160),
      lineCount: layout.lines.length,
      fontSize: layout.fontSize
    };
  });
}

export async function exportBurnedVideo(request: ExportRequest): Promise<ExportResult> {
  if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined") {
    throw new Error("浏览器不支持 WebCodecs；请使用最新版 Chrome / Edge");
  }
  const source = parseMp4(request.bytes);
  if (!source.video.codec.startsWith("avc")) {
    throw new Error(`当前导出仅接受 H.264/AVC MP4，源视频为 ${source.video.codec}`);
  }
  if (!source.video.description) throw new Error("源视频缺少 AVC 解码配置");
  const preset = PRESETS[request.aspect];
  const fpsInfo = estimateFrameRate(source);
  const videoStartSeconds = source.video.presentationStartSeconds;
  const audioStartSeconds = source.audio ? source.audio.presentationStartSeconds : videoStartSeconds;
  const audioStartUs = Math.max(0, Math.round((audioStartSeconds - videoStartSeconds) * 1_000_000));
  const bitrate = Math.max(2_500_000, Math.round(preset.width * preset.height * Math.min(60, fpsInfo.fps) * 0.115));

  const report = (phase: ExportProgress["phase"], frame: number, total: number, message: string) =>
    request.onProgress?.({ phase, frame, total, message });
  report("decode", 0, source.video.samples.length, "配置 WebCodecs 解码器");

  const decoderConfig: VideoDecoderConfig = {
    codec: source.video.codec,
    description: source.video.description,
    codedWidth: source.video.width,
    codedHeight: source.video.height,
    optimizeForLatency: true
  };
  const decoderSupport = await VideoDecoder.isConfigSupported(decoderConfig);
  if (!decoderSupport.supported) throw new Error(`浏览器无法解码 ${source.video.codec}`);

  const queue = new FrameQueue();
  let decodeError: Error | null = null;
  const decoder = new VideoDecoder({
    output: (frame) => queue.push(frame, frame.timestamp),
    error: (error) => {
      decodeError = error instanceof Error ? error : new Error(String(error));
      queue.finish();
    }
  });
  decoder.configure(decoderConfig);

  const feedPromise = (async () => {
    try {
      for (const sample of source.video.samples) {
        const timestampUs = Math.round(((sample.cts - source.video.editMediaTime) / source.video.timescale) * 1_000_000);
        const data = source.bytes.slice(sample.offset, sample.offset + sample.size);
        decoder.decode(
          new EncodedVideoChunk({
            type: sample.isKey ? "key" : "delta",
            timestamp: timestampUs,
            duration: Math.round((sample.duration / source.video.timescale) * 1_000_000),
            data
          })
        );
        await waitForDecoderSlot(decoder);
      }
      await decoder.flush();
    } catch (error) {
      decodeError = error instanceof Error ? error : new Error(String(error));
    } finally {
      queue.finish();
      decoder.close();
    }
  })();

  const encoderConfig = await chooseEncoderConfig(preset.width, preset.height, fpsInfo.fps, bitrate);
  const encodedSamples: EncodedVideoSample[] = [];
  let description: Uint8Array | null = null;
  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const encoderDescription = normalizeDescription(metadata.decoderConfig?.description);
      if (encoderDescription) description = encoderDescription;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      encodedSamples.push({
        data,
        timestampUs: chunk.timestamp,
        durationUs: chunk.duration ?? 0,
        isKey: chunk.type === "key"
      });
    },
    error: (error) => {
      encoderError = error instanceof Error ? error : new Error(String(error));
    }
  });
  encoder.configure(encoderConfig);

  const outputCanvas = createCanvas(preset.width, preset.height);
  const outputCtx = outputCanvas.getContext("2d", { alpha: false });
  if (!outputCtx) throw new Error("Canvas 2D 不可用");
  const measure = createMeasure(outputCtx, request.style);
  const sourceTimestamps: number[] = [];
  const layoutWarnings = new Set<string>();
  let minFontSizeSeen = preset.fontSize;
  const lineCounts: Record<string, number> = {};
  let renderedFrames = 0;
  let keyframeCounter = 0;
  const keyframeInterval = Math.max(1, Math.round(fpsInfo.fps * 2));

  report("render", 0, source.video.samples.length, "逐帧渲染字幕层");
  for (;;) {
    const item = await queue.next();
    if (!item) break;
    if (decodeError) {
      item.frame.close();
      throw decodeError;
    }
    if (encoderError) {
      item.frame.close();
      throw encoderError;
    }
    const timestampUs = item.timestampUs;
    sourceTimestamps.push(timestampUs);
    const cue = activeCueAt(request.cues, timestampUs);
    const layout = layoutSubtitle(
      {
        preset,
        style: request.style,
        subjectBox: request.subjectBox,
        placement: request.placement,
        timeUs: timestampUs,
        cue
      },
      measure
    );
    for (const warning of layout.warnings) layoutWarnings.add(warning);
    minFontSizeSeen = Math.min(minFontSizeSeen, layout.fontSize);
    const lineKey = String(layout.lines.length);
    lineCounts[lineKey] = (lineCounts[lineKey] ?? 0) + 1;
    const subtitleCanvas = renderSubtitleLayer(layout, request.style, preset);
    drawComposite(outputCtx, item.frame, item.frame.displayWidth, item.frame.displayHeight, subtitleCanvas, preset);
    const outputFrame = new VideoFrame(outputCanvas, {
      timestamp: timestampUs,
      duration: Math.max(1, item.frame.duration ?? Math.round(1_000_000 / fpsInfo.fps))
    });
    encoder.encode(outputFrame, { keyFrame: keyframeCounter++ % keyframeInterval === 0 });
    outputFrame.close();
    item.frame.close();
    renderedFrames += 1;

    if (encoder.encodeQueueSize > 4) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 4);
        encoder.addEventListener(
          "dequeue",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      });
    }
    if (renderedFrames % 3 === 0 || renderedFrames === source.video.samples.length) {
      report("encode", renderedFrames, source.video.samples.length, `编码第 ${renderedFrames} 帧`);
    }
    if (renderedFrames % 12 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await feedPromise;
  if (decodeError) throw decodeError;
  await encoder.flush();
  encoder.close();
  if (encoderError) throw encoderError;
  if (encodedSamples.length === 0) throw new Error("编码器没有输出视频帧");
  if (!description) throw new Error("编码器没有返回 avcC 配置");

  let inferredDuration = Math.max(1, Math.round(1_000_000 / fpsInfo.fps));
  for (let index = encodedSamples.length - 1; index >= 0; index -= 1) {
    if (encodedSamples[index].durationUs <= 0) encodedSamples[index].durationUs = inferredDuration;
    inferredDuration = encodedSamples[index].durationUs;
  }

  report("mux", renderedFrames, source.video.samples.length, "复用原始 AAC 样本并封装 MP4");
  const muxed = muxMp4({
    width: preset.width,
    height: preset.height,
    source,
    videoSamples: encodedSamples,
    videoDescription: description,
    audioStartUs
  });

  report("verify", renderedFrames, source.video.samples.length, "校验音轨字节与帧映射");
  const output = parseMp4(muxed.mp4);
  const sourceAudio = audioBytes(source);
  const outputAudio = audioBytes(output);
  const sourceSha256 = await digestParts(sourceAudio);
  const outputSha256 = await digestParts(outputAudio);
  if (sourceSha256 !== outputSha256) throw new Error("音频样本校验失败，导出已中止");

  const sortedSource = [...sourceTimestamps].sort((a, b) => a - b);
  const sortedOutput = encodedSamples.map((sample) => sample.timestampUs).sort((a, b) => a - b);
  const timing = validateFrameTimings(sortedOutput, request.cues, fpsInfo.rate, sortedOutput[0] ?? 0);
  const sourceTiming = validateFrameTimings(sortedSource, request.cues, fpsInfo.rate, sortedSource[0] ?? 0);
  if (sourceTiming.frameCount !== sortedOutput.length) {
    throw new Error(`帧数不一致：源 ${sourceTiming.frameCount}，输出 ${sortedOutput.length}`);
  }
  let maxMappingError = 0;
  for (let index = 0; index < sortedSource.length; index += 1) {
    maxMappingError = Math.max(maxMappingError, Math.abs(sortedSource[index] - sortedOutput[index]));
  }
  if (maxMappingError > 1) throw new Error(`帧时间戳偏移 ${maxMappingError}µs，导出已中止`);

  const frameMap = await logFrameMap(
    sortedOutput,
    request.cues,
    preset,
    request.style,
    outputCtx,
    request.subjectBox,
    request.placement,
    fpsInfo.rate
  );
  for (let index = 0; index < frameMap.length && index < sortedSource.length; index += 1) {
    frameMap[index].sourcePtsUs = sortedSource[index];
  }

  const sourceAudioBytes = sourceAudio.reduce((sum, bytes) => sum + bytes.length, 0);
  const outputAudioBytes = outputAudio.reduce((sum, bytes) => sum + bytes.length, 0);
  const manifest: ExportManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    fileName: request.fileName,
    aspect: request.aspect,
    width: preset.width,
    height: preset.height,
    preset: `${request.aspect} ${preset.width}×${preset.height}`,
    encoder: `${encoderConfig.codec} / ${preset.width}×${preset.height} / ${fpsInfo.fps.toFixed(3)}fps`,
    fps: fpsInfo.fps,
    frameCount: sortedOutput.length,
    sourceSampleCount: source.video.samples.length,
    durationUs: sortedOutput[sortedOutput.length - 1] + encodedSamples[encodedSamples.length - 1].durationUs,
    firstPtsUs: sortedOutput[0] ?? 0,
    lastPtsUs: sortedOutput[sortedOutput.length - 1] ?? 0,
    timing: { ...timing, warnings: [...timing.warnings, ...(maxMappingError > 0 ? [`最大帧时间映射误差 ${maxMappingError}µs`] : [])] },
    frameMapping: {
      exact: maxMappingError <= 1 && sortedSource.length === sortedOutput.length,
      maxErrorUs: maxMappingError,
      sourceFrames: sortedSource.length,
      outputFrames: sortedOutput.length
    },
    layout: {
      fontSize: preset.fontSize,
      maxFontSize: preset.fontSize,
      lineCounts,
      minFontSizeSeen,
      warnings: [...layoutWarnings]
    },
    audio: {
      sourceSamples: source.audio?.samples.length ?? 0,
      outputSamples: output.audio?.samples.length ?? 0,
      sourceBytes: sourceAudioBytes,
      outputBytes: outputAudioBytes,
      sourceSha256,
      outputSha256,
      bytePreserved: sourceSha256 === outputSha256,
      startUs: audioStartUs
    },
    frames: frameMap
  };
  report("done", renderedFrames, source.video.samples.length, "完成");
  return {
    blob: new Blob([muxed.mp4], { type: "video/mp4" }),
    manifest,
    manifestBlob: new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" })
  };
}

export function frameLabel(manifest: ExportManifest, frame: number): string {
  const index = Math.min(manifest.frames.length - 1, Math.max(0, frame));
  return `${frameTimestamp(frame, { numerator: Math.round(manifest.fps * 1000), denominator: 1000 })}µs`;
}
