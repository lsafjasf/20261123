import type { ByteRangeReader, VideoTrack } from "./mp4.ts";
import { readSampleData } from "./mp4.ts";
import type { FrameTimeline } from "./timeline.ts";
import { frameTimestampUs, resolveVideoConfig } from "./video-engine.ts";

interface ThumbnailEntry {
  bitmap: ImageBitmap;
  touched: number;
}

export class ThumbnailStore {
  lastDecode: { gopId: number; frameNumber: number; timestamp: number } | null = null;
  private readonly source: ByteRangeReader;
  private readonly track: VideoTrack;
  private readonly timeline: FrameTimeline;
  private readonly cache = new Map<number, ThumbnailEntry>();
  private readonly pending = new Map<number, Promise<ImageBitmap | null>>();
  private queue: Promise<unknown> = Promise.resolve();
  private clock = 0;
  private disposed = false;

  constructor(source: ByteRangeReader, track: VideoTrack, timeline: FrameTimeline) {
    this.source = source;
    this.track = track;
    this.timeline = timeline;
  }

  peek(gopId: number): ImageBitmap | null {
    const entry = this.cache.get(gopId);
    if (!entry) return null;
    entry.touched = ++this.clock;
    return entry.bitmap;
  }

  request(gopId: number): Promise<ImageBitmap | null> {
    if (this.disposed) return Promise.resolve(null);
    const cached = this.peek(gopId);
    if (cached) return Promise.resolve(cached);
    const existing = this.pending.get(gopId);
    if (existing) return existing;

    const task = this.queue
      .then(() => this.decodeKeyframe(gopId))
      .then((bitmap) => {
        if (!bitmap) return null;
        if (this.disposed) {
          bitmap.close();
          return null;
        }
        this.cache.set(gopId, { bitmap, touched: ++this.clock });
        this.evict();
        return bitmap;
      })
      .finally(() => {
        this.pending.delete(gopId);
      });
    this.pending.set(gopId, task);
    this.queue = task.catch(() => undefined);
    return task;
  }

  clear(): void {
    this.disposed = true;
    for (const entry of this.cache.values()) entry.bitmap.close();
    this.cache.clear();
  }

  private async decodeKeyframe(gopId: number): Promise<ImageBitmap | null> {
    const keyframe = this.timeline.frameForDecodeIndex(gopId);
    if (!keyframe || this.disposed) return null;
    this.lastDecode = {
      gopId,
      frameNumber: keyframe.frameNumber,
      timestamp: frameTimestampUs(keyframe)
    };
    const sample = keyframe.sample;
    const bytes = await readSampleData(this.source, this.track, sample);
    if (this.disposed) return null;

    const config = await resolveVideoConfig(this.track);

    const canvas = new OffscreenCanvas(320, 180);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;
    const decoded: { frame: VideoFrame | null } = { frame: null };
    let rejected: Error | null = null;
    const decoder = new VideoDecoder({
      output: (frame) => {
        decoded.frame?.close();
        decoded.frame = frame;
      },
      error: (error) => {
        rejected = new Error(error.message);
      }
    });
    try {
      decoder.configure(config);
      decoder.decode(new EncodedVideoChunk({
        type: "key",
        timestamp: frameTimestampUs(keyframe),
        duration: Math.max(1, Math.round(keyframe.durationSeconds * 1_000_000)),
        data: bytes
      }));
      await decoder.flush();
      if (rejected) throw rejected;
      if (!decoded.frame) return null;
      const frame = decoded.frame;
      this.drawContained(context, frame, canvas.width, canvas.height);
      return canvas.transferToImageBitmap();
    } finally {
      decoded.frame?.close();
      if (decoder.state !== "closed") decoder.close();
    }
  }

  private drawContained(
    context: OffscreenCanvasRenderingContext2D,
    frame: VideoFrame,
    width: number,
    height: number
  ): void {
    const scale = Math.min(width / frame.displayWidth, height / frame.displayHeight);
    const drawWidth = frame.displayWidth * scale;
    const drawHeight = frame.displayHeight * scale;
    context.fillStyle = "#090b0d";
    context.fillRect(0, 0, width, height);
    context.drawImage(
      frame,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight
    );
  }

  private evict(): void {
    while (this.cache.size > 96) {
      const oldest = [...this.cache.entries()].sort((left, right) => left[1].touched - right[1].touched)[0];
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      oldest[1].bitmap.close();
    }
  }
}
