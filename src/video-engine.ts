import type { ByteRangeReader, VideoTrack } from "./mp4.ts";
import { readSampleData } from "./mp4.ts";
import { GopFrameCache, type CacheStats } from "./gop-cache.ts";
import type { DisplayFrame, FrameTimeline } from "./timeline.ts";

export interface FrameResult {
  frameNumber: number;
  gopId: number;
  fromCache: boolean;
  decodeMs: number;
}

export interface VideoEngineStats {
  cache: CacheStats;
  gopId: number | null;
  decodedThrough: number | null;
  decoderState: string;
  lastDecodeMs: number;
  decodeRequests: number;
  cacheHits: number;
}

interface DecodeSession {
  generation: number;
  gopId: number;
  nextDecodeIndex: number;
  endDecodeIndex: number;
  timestampToFrame: Map<number, number>;
  decoder: VideoDecoder;
}

interface Waiter {
  generation: number;
  frameNumber: number;
  gopId: number;
  promise: Promise<FrameResult>;
  resolve: (result: FrameResult) => void;
  reject: (error: Error) => void;
}

const DECODE_LOOKAHEAD = 24;
const OUTPUT_TIMEOUT_MS = 80;

export function frameTimestampUs(frame: DisplayFrame): number {
  return Math.max(0, Math.round(frame.ctsSeconds * 1_000_000));
}

export async function resolveVideoConfig(track: VideoTrack): Promise<VideoDecoderConfig> {
  const base: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.width,
    codedHeight: track.height,
    description: track.description,
    optimizeForLatency: true
  };
  for (const hardwareAcceleration of ["prefer-hardware", "no-preference", "prefer-software"] as const) {
    try {
      const support = await VideoDecoder.isConfigSupported({ ...base, hardwareAcceleration });
      if (support.supported) return support.config ?? { ...base, hardwareAcceleration };
    } catch {
      // Try the next hardware preference.
    }
  }
  throw new Error(`WebCodecs 不支持 ${track.codec}`);
}

function frameBytes(frame: VideoFrame): number {
  try {
    return Math.max(1, frame.allocationSize());
  } catch {
    return Math.max(1, Math.round(frame.codedWidth * frame.codedHeight * 1.5));
  }
}

export class VideoDecodeEngine {
  readonly timeline: FrameTimeline;
  private readonly track: VideoTrack;
  private readonly source: ByteRangeReader;
  private readonly cache: GopFrameCache<VideoFrame>;
  private decoder: VideoDecoder | null = null;
  private session: DecodeSession | null = null;
  private waiter: Waiter | null = null;
  private generation = 0;
  private lastDecodeMs = 0;
  private decodeRequests = 0;
  private cacheHits = 0;
  private configSupport: Promise<VideoDecoderConfig> | null = null;
  private disposed = false;

  constructor(
    source: ByteRangeReader,
    track: VideoTrack,
    timeline: FrameTimeline,
    maxGops = 3,
    maxBytes = 512 * 1024 * 1024
  ) {
    if (typeof VideoDecoder === "undefined") {
      throw new Error("当前浏览器不支持 WebCodecs VideoDecoder");
    }
    this.source = source;
    this.track = track;
    this.timeline = timeline;
    this.cache = new GopFrameCache<VideoFrame>(maxGops, maxBytes);
  }

  get stats(): VideoEngineStats {
    return {
      cache: this.cache.stats,
      gopId: this.session?.gopId ?? null,
      decodedThrough: this.session ? this.session.nextDecodeIndex - 1 : null,
      decoderState: this.decoder?.state ?? "closed",
      lastDecodeMs: this.lastDecodeMs,
      decodeRequests: this.decodeRequests,
      cacheHits: this.cacheHits
    };
  }

  getCached(frameNumber: number): VideoFrame | null {
    const frame = this.timeline.frameAt(frameNumber);
    return this.cache.get(frame.gopId, frame.frameNumber) ?? null;
  }

  pin(frameNumber: number): VideoFrame | null {
    const frame = this.timeline.frameAt(frameNumber);
    return this.cache.pin(frame.gopId, frame.frameNumber)?.value ?? null;
  }

  unpin(): void {
    this.cache.unpin();
  }

  async ensureFrame(frameNumber: number): Promise<FrameResult> {
    if (this.disposed) throw new Error("解码器已关闭");
    const target = this.timeline.frameAt(frameNumber);
    const cached = this.cache.get(target.gopId, target.frameNumber);
    if (cached) {
      this.cacheHits += 1;
      return {
        frameNumber: target.frameNumber,
        gopId: target.gopId,
        fromCache: true,
        decodeMs: 0
      };
    }

    const started = performance.now();
    this.decodeRequests += 1;
    await this.ensureSession(target);
    const session = this.session!;
    const pending = this.armWaiter(session, target);
    await this.feed(target, session);

    let frame = this.cache.get(target.gopId, target.frameNumber);
    if (!frame) {
      try {
        await this.waitForOutput(pending, target, session);
      } catch (error) {
        if (this.waiter === pending) this.waiter = null;
        throw error;
      }
      frame = this.cache.get(target.gopId, target.frameNumber);
    } else if (this.waiter === pending) {
      this.waiter = null;
    }
    if (!frame) throw new Error(`解码后未找到第 ${target.frameNumber + 1} 帧`);
    this.lastDecodeMs = performance.now() - started;
    return {
      frameNumber: target.frameNumber,
      gopId: target.gopId,
      fromCache: false,
      decodeMs: this.lastDecodeMs
    };
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.waiter?.reject(new Error("解码器已关闭"));
    this.waiter = null;
    this.closeDecoder();
    this.cache.clear();
  }

  private async ensureSession(target: DisplayFrame): Promise<void> {
    const current = this.session;
    const usable =
      current &&
      current.gopId === target.gopId &&
      target.decodeIndex >= current.nextDecodeIndex;
    if (usable) return;
    await this.startSession(target.gopId);
  }

  private async startSession(gopId: number): Promise<void> {
    const generation = ++this.generation;
    this.waiter?.reject(new Error("新的逐帧请求已开始"));
    this.waiter = null;
    this.closeDecoder();
    const config = await this.getConfig();
    if (generation !== this.generation || this.disposed) throw new Error("解码请求已取消");

    const timestampToFrame = new Map<number, number>();
    for (const frame of this.timeline.gopFrames(gopId)) {
      timestampToFrame.set(frameTimestampUs(frame), frame.frameNumber);
    }
    const decoder = new VideoDecoder({
      output: (frame) => this.handleOutput(frame, generation),
      error: (error) => this.handleDecoderError(error, generation)
    });
    decoder.configure(config);
    const gopFrames = this.timeline.gopFrames(gopId);
    const maxDecode = gopFrames.reduce((maximum, frame) => Math.max(maximum, frame.decodeIndex), gopId);
    this.decoder = decoder;
    this.session = {
      generation,
      gopId,
      nextDecodeIndex: gopId,
      endDecodeIndex: maxDecode,
      timestampToFrame,
      decoder
    };
  }

  private async feed(target: DisplayFrame, session: DecodeSession): Promise<void> {
    const gopFrames = this.timeline.gopFrames(session.gopId);
    const framesByDecode = new Map(gopFrames.map((frame) => [frame.decodeIndex, frame]));
    const feedEnd = Math.min(session.endDecodeIndex, target.decodeIndex + DECODE_LOOKAHEAD);
    while (session.nextDecodeIndex <= feedEnd) {
      if (session.generation !== this.generation) throw new Error("解码请求已取消");
      const frame = framesByDecode.get(session.nextDecodeIndex);
      if (!frame) {
        session.nextDecodeIndex += 1;
        continue;
      }
      const sample = frame.sample;
      const bytes = await readSampleData(this.source, this.track, sample);
      if (session.generation !== this.generation) throw new Error("解码请求已取消");
      const chunk = new EncodedVideoChunk({
        type: sample.isSync ? "key" : "delta",
        timestamp: frameTimestampUs(frame),
        duration: Math.max(1, Math.round((sample.durationTicks / this.track.timescale) * 1_000_000)),
        data: bytes
      });
      session.decoder.decode(chunk);
      session.nextDecodeIndex += 1;
    }
  }

  private armWaiter(session: DecodeSession, target: DisplayFrame): Waiter {
    this.waiter?.reject(new Error("新的逐帧请求已开始"));
    let resolvePromise!: (result: FrameResult) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<FrameResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const waiter: Waiter = {
      generation: session.generation,
      frameNumber: target.frameNumber,
      gopId: target.gopId,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise
    };
    this.waiter = waiter;
    return waiter;
  }

  private async waitForOutput(
    waiter: Waiter,
    target: DisplayFrame,
    session: DecodeSession
  ): Promise<void> {
    let timedOut = false;
    let timer = 0;
    const timeout = new Promise<void>((resolve) => {
      timer = window.setTimeout(() => {
        timedOut = true;
        resolve();
      }, OUTPUT_TIMEOUT_MS);
    });
    try {
      await Promise.race([waiter.promise.then(() => undefined), timeout]);
      if (!timedOut) return;

      const result = await this.flushForTarget(target, session);
      if (!result) {
        if (this.cache.has(target.gopId, target.frameNumber)) return;
        throw new Error(`第 ${target.frameNumber + 1} 帧解码超时`);
      }
    } finally {
      window.clearTimeout(timer);
    }
  }

  private async flushForTarget(target: DisplayFrame, session: DecodeSession): Promise<FrameResult | null> {
    if (session.generation !== this.generation) return null;
    try {
      await session.decoder.flush();
    } catch {
      return null;
    }
    if (session.generation === this.generation) this.session = null;
    if (!this.cache.has(target.gopId, target.frameNumber)) return null;
    return {
      frameNumber: target.frameNumber,
      gopId: target.gopId,
      fromCache: false,
      decodeMs: this.lastDecodeMs
    };
  }

  private handleOutput(frame: VideoFrame, generation: number): void {
    if (generation !== this.generation || this.disposed) {
      frame.close();
      return;
    }
    const session = this.session;
    if (!session) {
      frame.close();
      return;
    }
    let frameNumber = session.timestampToFrame.get(frame.timestamp);
    if (frameNumber === undefined) {
      const seconds = this.timeline.originSeconds + frame.timestamp / 1_000_000;
      frameNumber = this.timeline.frameAtTime(seconds).frameNumber;
    }
    this.cache.put(session.gopId, frameNumber, frame, frameBytes(frame));
    const waiter = this.waiter;
    if (
      waiter &&
      waiter.generation === generation &&
      waiter.gopId === session.gopId &&
      waiter.frameNumber === frameNumber
    ) {
      this.waiter = null;
      waiter.resolve({
        frameNumber,
        gopId: session.gopId,
        fromCache: false,
        decodeMs: this.lastDecodeMs
      });
    }
  }

  private handleDecoderError(error: DOMException, generation: number): void {
    if (generation !== this.generation) return;
    const wrapped = new Error(`视频解码失败: ${error.message}`);
    this.waiter?.reject(wrapped);
    this.waiter = null;
    this.session = null;
  }

  private getConfig(): Promise<VideoDecoderConfig> {
    if (!this.configSupport) {
      this.configSupport = resolveVideoConfig(this.track);
    }
    return this.configSupport;
  }

  private closeDecoder(): void {
    this.session = null;
    if (!this.decoder) return;
    try {
      if (this.decoder.state !== "closed") this.decoder.close();
    } catch {
      // A reset decoder may already be closing.
    }
    this.decoder = null;
  }
}
