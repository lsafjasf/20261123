import type { JitterStats, MediaFrame } from './media-types.ts';

/**
 * 音视频共用的按 PTS 排序抖动缓冲。
 * 冻结时上层停止调用 drain，帧与画面位置自然同时停住，
 * 不存在音频走独立时钟而继续前进的情况。
 */
export class JitterBuffer {
  private readonly frames: MediaFrame[] = [];
  private readonly targetDepthMs: number;
  private readonly maxFrames: number;

  constructor(
    /** 目标缓冲深度（毫秒），低于该值通常意味着即将欠载。 */
    targetDepthMs = 800,
    /** 最大容量（帧数），防止异常数据源无限堆积。 */
    maxFrames = 4096,
  ) {
    this.targetDepthMs = targetDepthMs;
    this.maxFrames = maxFrames;
  }

  /** 插入一帧并按 PTS 归位。同 PTS 时音频排在视频前，保证顺序确定。 */
  push(frame: MediaFrame): void {
    if (this.frames.length >= this.maxFrames) {
      throw new RangeError('jitter buffer overflow');
    }
    let insertAt = this.frames.length;
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      const existing = this.frames[i];
      if (!existing) {
        continue;
      }
      if (existing.ptsMs < frame.ptsMs) {
        break;
      }
      if (existing.ptsMs === frame.ptsMs && existing.kind === 'audio') {
        break;
      }
      insertAt = i;
    }
    this.frames.splice(insertAt, 0, frame);
  }

  /** 队首帧，空时为 null。 */
  peek(): MediaFrame | null {
    return this.frames[0] ?? null;
  }

  /** 弹出 PTS 不超过 currentMediaMs 的最早帧；没有到期帧返回 null。 */
  drainDue(currentMediaMs: number): MediaFrame | null {
    const head = this.frames[0];
    if (!head || head.ptsMs > currentMediaMs) {
      return null;
    }
    return this.frames.shift() ?? null;
  }

  /** 弹出队首帧（调度器已决定 render/skip 时使用）。 */
  pop(): MediaFrame | null {
    return this.frames.shift() ?? null;
  }

  /**
   * 跳转后清理：保留 PTS 落在 [fromMs, toMs] 内的帧，其余丢弃。
   * 返回被丢弃的帧，调用方负责 close 其 WebCodecs 载荷并写日志。
   */
  prune(fromMs: number, toMs: number): MediaFrame[] {
    const dropped: MediaFrame[] = [];
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      const frame = this.frames[i];
      if (frame && (frame.ptsMs < fromMs || frame.ptsMs > toMs)) {
        dropped.push(frame);
        this.frames.splice(i, 1);
      }
    }
    return dropped;
  }

  /** 清空全部帧（缓冲冻结/结束时使用）。 */
  clear(): MediaFrame[] {
    return this.frames.splice(0);
  }

  get size(): number {
    return this.frames.length;
  }

  stats(): JitterStats {
    let audioFrames = 0;
    let videoFrames = 0;
    for (const frame of this.frames) {
      if (frame.kind === 'audio') {
        audioFrames += 1;
      } else {
        videoFrames += 1;
      }
    }
    const lowest = this.frames[0]?.ptsMs ?? null;
    const highest = this.frames.at(-1)?.ptsMs ?? null;
    return {
      audioFrames,
      videoFrames,
      lowestPtsMs: lowest,
      highestPtsMs: highest,
      depthMs: lowest === null || highest === null ? 0 : highest - lowest,
    };
  }

  isHealthy(): boolean {
    const stats = this.stats();
    return stats.depthMs >= this.targetDepthMs;
  }
}
