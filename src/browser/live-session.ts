import { EventLog } from '../core/event-log.ts';
import { MediaClock } from '../core/media-clock.ts';
import type { LatencyInfo, MonotonicClock } from '../core/types.ts';
import { SyncEngine, type FrameRenderer } from '../media/sync-engine.ts';
import type { CatchUpPolicy } from '../core/types.ts';
import type { MediaFrame } from '../media/media-types.ts';
import type { MediaTransport } from '../media/media-types.ts';

export interface LiveSessionOptions {
  readonly clock: MonotonicClock;
  readonly log: EventLog;
  readonly mediaClock: MediaClock;
  readonly audioRenderer: FrameRenderer;
  readonly videoRenderer: FrameRenderer;
  readonly transport: MediaTransport;
  /** 数据拉取后、入队前的转换钩子，浏览器中接 WebCodecs 解码。 */
  readonly pullFrames?: () => MediaFrame[];
  readonly catchUpPolicy?: CatchUpPolicy;
  /** 驱动循环间隔（毫秒）。 */
  readonly tickIntervalMs?: number;
  readonly documentVisibility?: {
    readonly hidden: boolean;
    addListener(fn: (hidden: boolean) => void): () => void;
  };
}

/**
 * 直播会话：统一装配与事件入口。
 * 外部事件（暂停、拖动、切后台、蓝牙延迟）全部收敛到这里，
 * 再交给 MediaClock 做确定性仲裁，渲染侧只订阅结果。
 */
export class LiveSession {
  private readonly engine: SyncEngine;
  private readonly mediaClock: MediaClock;
  private readonly log: EventLog;
  private readonly clock: MonotonicClock;
  private readonly transport: MediaTransport;
  private readonly pullFrames?: () => MediaFrame[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickIntervalMs: number;
  private detachVisibility: (() => void) | null = null;
  private bufferedFloorMs = 0;
  private bufferedCeilMs = 0;

  constructor(options: LiveSessionOptions) {
    this.clock = options.clock;
    this.log = options.log;
    this.mediaClock = options.mediaClock;
    this.transport = options.transport;
    this.pullFrames = options.pullFrames;
    this.tickIntervalMs = options.tickIntervalMs ?? 20;
    this.engine = new SyncEngine({
      clock: options.clock,
      media: options.mediaClock,
      log: options.log,
      audioRenderer: options.audioRenderer,
      videoRenderer: options.videoRenderer,
      ...(options.catchUpPolicy ? { catchUpPolicy: options.catchUpPolicy } : {}),
    });

    if (options.documentVisibility) {
      this.detachVisibility = options.documentVisibility.addListener((hidden) => {
        if (hidden) {
          this.handleHidden();
        } else {
          this.handleVisible();
        }
      });
    }
  }

  start(): void {
    this.mediaClock.start();
    this.timer = setInterval(() => this.loop(), this.tickIntervalMs);
    // unref：Node 测试环境下不阻止进程退出；浏览器忽略该方法。
    this.timer.unref?.();
  }

  /** 用户暂停。 */
  pause(): void {
    this.mediaClock.pause();
  }

  /** 用户恢复。 */
  resume(): void {
    this.mediaClock.resume();
  }

  /** 用户拖动到指定媒体时间（毫秒）。 */
  seek(targetMediaMs: number): void {
    this.bufferedFloorMs = targetMediaMs;
    this.bufferedCeilMs = targetMediaMs;
    this.mediaClock.userSeek(targetMediaMs);
  }

  /** 蓝牙/输出设备延迟变化入口。 */
  reportLatency(info: LatencyInfo): void {
    this.mediaClock.latencyChange(info);
  }

  /** 数据层报告新的缓冲区间与直播边缘。 */
  reportBufferedRange(fromMs: number, toMs: number, liveEdgeMs: number): void {
    this.engine.updateBufferedRange(fromMs, toMs, liveEdgeMs);
  }

  /** 数据层报告目标数据已就绪。 */
  reportDataAvailable(): void {
    this.engine.notifyDataAvailable();
  }

  getEngine(): SyncEngine {
    return this.engine;
  }

  getClock(): MediaClock {
    return this.mediaClock;
  }

  private handleHidden(): void {
    this.engine.onHidden();
  }

  private handleVisible(): void {
    this.engine.onVisible();
  }

  private loop(): void {
    if (this.pullFrames) {
      for (const frame of this.pullFrames()) {
        this.engine.enqueue(frame);
        this.bufferedCeilMs = Math.max(this.bufferedCeilMs, frame.ptsMs);
      }
    }
    const liveEdge = this.transport.liveEdgeMs();
    if (liveEdge > 0) {
      this.reportBufferedRange(this.bufferedFloorMs, this.bufferedCeilMs, liveEdge);
    }
    this.engine.tick();
    // 播放位置成为新的缓冲下界，已渲染掉的帧不再算作可回退数据。
    this.bufferedFloorMs = this.mediaClock.getMediaMs();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.detachVisibility?.();
  }
}
