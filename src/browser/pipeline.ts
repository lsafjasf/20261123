// Real encode + decode pipeline. Runs entirely in the browser against
// WebCodecs with procedurally generated frames. Nothing here trusts
// isConfigSupported alone: every config is exercised end to end.

import type { TestConfig } from '../shared/matrix.ts';
import { generateFrame, videoFrameLayout } from '../shared/frames.ts';
import { frameToRgba, deviation } from '../shared/metrics.ts';
import type { RunResult } from '../shared/result.ts';

export interface EncodedChunkRecord {
  data: Uint8Array;
  timestamp: number;
  duration: number;
  keyframe: boolean;
}

export interface PipelineOutput {
  claimedSupport: RunResult['claimedSupport'];
  timing: RunResult['timing'];
  quality: RunResult['quality'];
  frames: RunResult['frames'];
  chunks: EncodedChunkRecord[];
  decoderDescription: Uint8Array | null;
}

export class StageError extends Error {
  stage: NonNullable<RunResult['failStage']>;
  constructor(stage: NonNullable<RunResult['failStage']>, message: string) {
    super(message);
    this.stage = stage;
  }
}

function now(): number {
  return performance.now();
}

export function startMemorySampler(): { stop: () => number | null } {
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
  if (!perf.memory) return { stop: () => null };
  let peak = perf.memory.usedJSHeapSize;
  const timer = setInterval(() => {
    peak = Math.max(peak, perf.memory!.usedJSHeapSize);
  }, 50);
  return {
    stop: () => {
      clearInterval(timer);
      return Math.max(peak, perf.memory!.usedJSHeapSize);
    },
  };
}

function makeCanvas(width: number, height: number): {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) return { canvas, ctx: ctx as OffscreenCanvasRenderingContext2D };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new StageError('decode', 'no 2d canvas context available');
  return { canvas, ctx };
}

export async function probeSupport(cfg: TestConfig): Promise<RunResult['claimedSupport']> {
  const encoderConfig: VideoEncoderConfig = {
    codec: cfg.codecString,
    width: cfg.width,
    height: cfg.height,
    bitrate: cfg.bitrateKbps * 1000,
    framerate: cfg.fps,
  };
  const decoderConfig: VideoDecoderConfig = {
    codec: cfg.codecString,
    codedWidth: cfg.width,
    codedHeight: cfg.height,
  };
  let encoder: boolean | null = null;
  let decoder: boolean | null = null;
  let mse: boolean | null = null;
  try {
    encoder = (await VideoEncoder.isConfigSupported(encoderConfig)).supported === true;
  } catch {
    encoder = false;
  }
  try {
    decoder = (await VideoDecoder.isConfigSupported(decoderConfig)).supported === true;
  } catch {
    decoder = false;
  }
  try {
    mse = cfg.mp4Muxable
      ? typeof MediaSource !== 'undefined' &&
        MediaSource.isTypeSupported(`video/mp4; codecs="${cfg.codecString}"`)
      : null;
  } catch {
    mse = false;
  }
  return { encoder, decoder, mse };
}

export async function runPipeline(
  cfg: TestConfig,
  minPsnrDb: number,
  claimedSupport: RunResult['claimedSupport'],
): Promise<PipelineOutput> {

  // 1. Deterministic input frames.
  const genStart = now();
  const frames = [];
  for (let i = 0; i < cfg.frames; i++) {
    frames.push(generateFrame(cfg.id, cfg.width, cfg.height, cfg.chroma, i));
  }
  const generateMs = now() - genStart;
  if (frames.length !== cfg.frames) throw new StageError('generate', 'frame count mismatch');

  // 2. Encode.
  const chunks: EncodedChunkRecord[] = [];
  let decoderDescription: Uint8Array | null = null;
  let asyncError: Error | null = null;
  const frameDurationUs = Math.round(1_000_000 / cfg.fps);
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({
        data,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? frameDurationUs,
        keyframe: chunk.type === 'key',
      });
      const description = metadata?.decoderConfig?.description;
      if (description && !decoderDescription) {
        decoderDescription = new Uint8Array(description as ArrayBuffer);
      }
    },
    error: (err) => {
      if (!asyncError) asyncError = err;
    },
  });
  const encoderConfig: VideoEncoderConfig = {
    codec: cfg.codecString,
    width: cfg.width,
    height: cfg.height,
    bitrate: cfg.bitrateKbps * 1000,
    framerate: cfg.fps,
    latencyMode: 'quality',
  };
  if (cfg.avcFormat) {
    (encoderConfig as unknown as { avc: { format: string } }).avc = { format: cfg.avcFormat };
  }
  const encodeStart = now();
  let firstChunkMs: number | null = null;
  const firstChunkAt = chunks.length;
  encoder.configure(encoderConfig);
  const gop = Math.max(1, cfg.fps * 2);
  for (let i = 0; i < frames.length; i++) {
    if (asyncError) throw new StageError('encode', String(asyncError));
    const frame = frames[i];
    const videoFrame = new VideoFrame(frame.data, {
      format: cfg.chroma,
      codedWidth: cfg.width,
      codedHeight: cfg.height,
      timestamp: i * frameDurationUs,
      duration: frameDurationUs,
      layout: videoFrameLayout(frame),
    });
    encoder.encode(videoFrame, { keyFrame: i % gop === 0 });
    videoFrame.close();
    if (chunks.length > firstChunkAt && firstChunkMs === null) {
      firstChunkMs = now() - encodeStart;
    }
  }
  try {
    await encoder.flush();
  } catch (err) {
    throw new StageError('encode', `flush failed: ${String(err)}`);
  }
  encoder.close();
  const encodeMs = now() - encodeStart;
  if (asyncError) throw new StageError('encode', String(asyncError));
  if (chunks.length === 0) throw new StageError('encode', 'encoder produced no chunks');
  if (firstChunkMs === null) firstChunkMs = encodeMs;

  // 3. Decode and compare content frame by frame.
  const { ctx } = makeCanvas(cfg.width, cfg.height);
  let decoded = 0;
  let ttffMs: number | null = null;
  let lastTimestamp = -1;
  let timestampsMonotonic = true;
  let maeSum = 0;
  let psnrMin = Infinity;
  let psnrSum = 0;
  const decodeStartHolder: { t: number } = { t: 0 };
  const decoder = new VideoDecoder({
    output: (videoFrame) => {
      if (ttffMs === null) ttffMs = now() - decodeStartHolder.t;
      if (videoFrame.timestamp <= lastTimestamp) timestampsMonotonic = false;
      lastTimestamp = videoFrame.timestamp;
      const index = Math.round(videoFrame.timestamp / frameDurationUs);
      if (index >= 0 && index < frames.length) {
        const reference = frameToRgba(frames[index]);
        (ctx as CanvasRenderingContext2D).drawImage(videoFrame as CanvasImageSource, 0, 0);
        const actual = (ctx as CanvasRenderingContext2D).getImageData(0, 0, cfg.width, cfg.height).data;
        const d = deviation(reference, actual);
        maeSum += d.mae;
        psnrSum += d.psnrDb;
        if (d.psnrDb < psnrMin) psnrMin = d.psnrDb;
      }
      decoded++;
      videoFrame.close();
    },
    error: (err) => {
      if (!asyncError) asyncError = err;
    },
  });
  const decoderConfig: VideoDecoderConfig = {
    codec: cfg.codecString,
    codedWidth: cfg.width,
    codedHeight: cfg.height,
  };
  if (decoderDescription) {
    (decoderConfig as { description?: Uint8Array }).description = decoderDescription;
  }
  decoder.configure(decoderConfig);
  decodeStartHolder.t = now();
  for (const chunk of chunks) {
    if (asyncError) throw new StageError('decode', String(asyncError));
    decoder.decode(
      new EncodedVideoChunk({
        type: chunk.keyframe ? 'key' : 'delta',
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        data: chunk.data,
      }),
    );
  }
  try {
    await decoder.flush();
  } catch (err) {
    throw new StageError('decode', `flush failed: ${String(err)}`);
  }
  decoder.close();
  const decodeMs = now() - decodeStartHolder.t;
  if (asyncError) throw new StageError('decode', String(asyncError));
  if (decoded !== frames.length) {
    throw new StageError('decode', `decoded ${decoded}/${frames.length} frames`);
  }
  if (!timestampsMonotonic) {
    throw new StageError('decode', 'decoded timestamps not monotonic');
  }

  const framesCompared = decoded;
  const mae = framesCompared ? maeSum / framesCompared : null;
  const psnrDb = framesCompared ? psnrSum / framesCompared : null;
  if (psnrDb !== null && psnrDb < minPsnrDb) {
    throw new StageError(
      'deviation',
      `mean PSNR ${psnrDb.toFixed(2)} dB below threshold ${minPsnrDb} dB (min frame ${psnrMin.toFixed(2)} dB)`,
    );
  }

  return {
    claimedSupport,
    timing: {
      generateMs,
      encodeMs,
      firstChunkMs,
      decodeMs,
      ttffMs,
      mseMs: null,
    },
    quality: { mae, psnrDb, framesCompared },
    frames: { expected: frames.length, encoded: chunks.length, decoded },
    chunks,
    decoderDescription,
  };
}
