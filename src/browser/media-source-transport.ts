import type { MediaChunk, MediaTransport } from '../media/media-types.ts';

/** fMP4 配置：codec 字符串由上层根据会议协商结果注入。 */
export interface MediaSourceTransportOptions {
  readonly mediaSource: MediaSource;
  readonly videoCodec: string;
  readonly audioCodec: string;
  /** 直播保留窗口（毫秒），超出后 remove 旧段，控制内存增长。 */
  readonly retainWindowMs?: number;
  /** append 队列排空后的回调，用于驱动数据拉取。 */
  onUpdateEnd?: () => void;
  /** 缓冲区间变化回调（毫秒），同步给 MediaClock。 */
  onBufferedRange?: (range: { fromMs: number; toMs: number }) => void;
}

const SECOND_MS = 1000;

/**
 * MediaSource 传输层。
 * 只管理压缩段的 append/remove 与时间窗口，
 * 解码与呈现节奏仍由 WebCodecs + 统一媒体时钟决定，避免双时钟。
 */
export class MediaSourceTransport implements MediaTransport {
  private readonly mediaSource: MediaSource;
  /**
   * 复用型 fMP4 SourceBuffer：会议流通常把音视频封装在同一 fMP4 轨道集合，
   * 因此这里维持单个 SourceBuffer；若协商为分离轨道，可扩展为两个 SourceBuffer
   * 并在 pump 中分别排队，MediaClock 与上层管线无需改动。
   */
  private sourceBuffer: SourceBuffer | null = null;
  private readonly queue: MediaChunk[] = [];
  private readonly retainWindowMs: number;
  private readonly onUpdateEnd?: () => void;
  private readonly onBufferedRange?: (range: { fromMs: number; toMs: number }) => void;
  private liveEdgeValue = 0;

  constructor(options: MediaSourceTransportOptions) {
    this.mediaSource = options.mediaSource;
    this.retainWindowMs = options.retainWindowMs ?? 30_000;
    this.onUpdateEnd = options.onUpdateEnd;
    this.onBufferedRange = options.onBufferedRange;

    const mimeType = `video/mp4; codecs="${options.videoCodec},${options.audioCodec}"`;
    if (!MediaSource.isTypeSupported(mimeType)) {
      throw new Error(`unsupported MSE codec configuration: ${mimeType}`);
    }
    this.mediaSource.addEventListener('sourceopen', () => this.handleSourceOpen(mimeType), { once: true });
  }

  private handleSourceOpen(mimeType: string): void {
    const sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
    this.sourceBuffer = sourceBuffer;
    sourceBuffer.mode = 'segments';
    sourceBuffer.addEventListener('updateend', () => {
      this.emitBufferedRange(sourceBuffer);
      this.pump();
      this.onUpdateEnd?.();
    });
    this.pump();
  }

  /** 放入一个压缩段（初始化段优先），串行 append。 */
  enqueue(chunk: MediaChunk): void {
    this.queue.push(chunk);
    if (chunk.ptsMs + chunk.durationMs > this.liveEdgeValue) {
      this.liveEdgeValue = chunk.ptsMs + chunk.durationMs;
    }
    this.pump();
  }

  nextChunk(): MediaChunk | null {
    return this.queue.shift() ?? null;
  }

  liveEdgeMs(): number {
    return this.liveEdgeValue;
  }

  /**
   * 跳转到目标位置：清除目标窗口外的缓冲数据。
   * 与 MediaClock 的 seek 缓冲配合，新段 append 完成后再解冻。
   */
  pruneBefore(targetMediaMs: number): void {
    const buffer = this.sourceBuffer;
    if (!buffer || buffer.updating) {
      return;
    }
    const cutoff = Math.max(0, targetMediaMs - this.retainWindowMs);
    if (cutoff <= 0) {
      return;
    }
    buffer.remove(0, cutoff / SECOND_MS);
  }

  private pump(): void {
    const buffer = this.sourceBuffer;
    if (!buffer || buffer.updating || this.queue.length === 0) {
      return;
    }
    const chunk = this.queue.shift();
    if (!chunk) {
      return;
    }
    buffer.appendBuffer(chunk.data.slice());
  }

  private emitBufferedRange(buffer: SourceBuffer): void {
    const timeRanges = buffer.buffered;
    if (timeRanges.length === 0) {
      return;
    }
    const fromMs = timeRanges.start(0) * SECOND_MS;
    const toMs = timeRanges.end(timeRanges.length - 1) * SECOND_MS;
    this.onBufferedRange?.({ fromMs, toMs });
  }

  endOfStream(): void {
    if (this.mediaSource.readyState === 'open') {
      this.mediaSource.endOfStream();
    }
  }
}
