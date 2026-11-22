import { EventLog } from '../core/event-log.ts';
import type { MonotonicClock, CatchUpPolicy } from '../core/types.ts';
import { MediaClock } from '../core/media-clock.ts';
import { FrameScheduler } from './frame-scheduler.ts';
import { JitterBuffer } from './jitter-buffer.ts';
import type { MediaFrame, ScheduleDecision } from './media-types.ts';

/** 引擎对外依赖：音视频渲染器由浏览器层实现，测试中可注入假实现。 */
export interface FrameRenderer {
  render(frame: MediaFrame, dueInMs: number): void;
  /** 跳帧时释放 WebCodecs 载荷。 */
  release(frame: MediaFrame): void;
  /** 冻结通知：音频挂起、Canvas 保留最后一帧。 */
  freeze(reason: string, mediaMs: number): void;
  /** 恢复通知：清除挂起状态（可选实现）。 */
  unfreeze?(mediaMs: number): void;
}

export interface SyncEngineOptions {
  readonly clock: MonotonicClock;
  readonly media: MediaClock;
  readonly log: EventLog;
  readonly audioRenderer: FrameRenderer;
  readonly videoRenderer: FrameRenderer;
  readonly jitter?: JitterBuffer;
  readonly scheduler?: FrameScheduler;
  readonly catchUpPolicy?: CatchUpPolicy;
  /** 连续多久没有可渲染帧即判定欠载（毫秒）。 */
  readonly stallTimeoutMs?: number;
}

const DEFAULT_CATCH_UP_POLICY: CatchUpPolicy = {
  thresholdMs: 4000,
  stepMs: 1000,
  withinMs: 250,
};

/**
 * 同步引擎：管线的唯一驱动循环。
 * 每次 tick 只从 MediaClock 读取一个媒体时间，音频与视频调度共享该值，
 * 因此缓冲/暂停冻结时两边一起停，恢复后从同一 PTS 继续。
 */
export class SyncEngine {
  private readonly media: MediaClock;
  private readonly log: EventLog;
  private readonly clock: MonotonicClock;
  private readonly audioRenderer: FrameRenderer;
  private readonly videoRenderer: FrameRenderer;
  private readonly jitter: JitterBuffer;
  private readonly scheduler: FrameScheduler;
  private readonly catchUpPolicy: CatchUpPolicy;
  private frozen = false;
  private lastRenderedPerfMs: number | null = null;
  private readonly stallTimeoutMs: number;

  constructor(options: SyncEngineOptions) {
    this.clock = options.clock;
    this.media = options.media;
    this.log = options.log;
    this.audioRenderer = options.audioRenderer;
    this.videoRenderer = options.videoRenderer;
    this.jitter = options.jitter ?? new JitterBuffer();
    this.scheduler = options.scheduler ?? new FrameScheduler();
    this.catchUpPolicy = options.catchUpPolicy ?? DEFAULT_CATCH_UP_POLICY;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 250;
  }

  getJitterBuffer(): JitterBuffer {
    return this.jitter;
  }

  /** 喂入一帧解码后的媒体数据。 */
  enqueue(frame: MediaFrame): void {
    this.jitter.push(frame);
  }

  /**
   * 驱动一次调度。返回本次 tick 的决策列表（测试可断言）。
   * 冻结状态下不消费任何帧，仅向渲染器下发 freeze。
   */
  tick(): ScheduleDecision[] {
    const now = this.clock.now();
    const state = this.media.getState();
    const decisions: ScheduleDecision[] = [];

    if (state !== 'playing') {
      if (!this.frozen) {
        this.frozen = true;
        const mediaMs = this.media.getMediaMs(now);
        this.audioRenderer.freeze(state, mediaMs);
        this.videoRenderer.freeze(state, mediaMs);
        this.log.record({
          perfMs: now,
          event: 'renderFreeze',
          phase: 'applied',
          state,
          mediaMs,
          outputLatencyMs: this.media.getOutputLatencyMs(),
          detail: { reason: state },
        });
      }
      return decisions;
    }

    if (this.frozen) {
      this.frozen = false;
      this.lastRenderedPerfMs = null;
      const resumeMediaMs = this.media.getMediaMs(now);
      this.audioRenderer.unfreeze?.(resumeMediaMs);
      this.videoRenderer.unfreeze?.(resumeMediaMs);
      this.log.record({
        perfMs: now,
        event: 'renderResume',
        phase: 'applied',
        state,
        mediaMs: resumeMediaMs,
        outputLatencyMs: this.media.getOutputLatencyMs(),
        detail: {},
      });
    }

    const currentMediaMs = this.media.getMediaMs(now);
    const outputLatencyMs = this.media.getOutputLatencyMs();

    // 停滞看门狗：抖动缓冲耗尽且持续无帧可渲染时，主动进入 underrun 缓冲，
    // 保证“画面与声音一起冻结 + 数据就绪后同位置恢复”的语义不依赖数据源主动上报。
    if (this.jitter.size === 0 && this.lastRenderedPerfMs !== null
      && now - this.lastRenderedPerfMs >= this.stallTimeoutMs) {
      this.media.beginBuffering('underrun', now);
      this.lastRenderedPerfMs = null;
      return decisions;
    }

    // 单帧循环：音视频帧在同一 PTS 序列上交替到期。
    let guard = 0;
    while (guard < 256) {
      const frame = this.jitter.peek();
      const decision = this.scheduler.decide(frame, currentMediaMs, outputLatencyMs);
      decisions.push(decision);
      if (decision.action === 'wait') {
        break;
      }
      this.lastRenderedPerfMs = now;
      this.jitter.pop();
      if (decision.action === 'skip') {
        this.handleSkip(decision.frame, currentMediaMs);
      } else {
        this.handleRender(decision.frame, decision.dueInMs, currentMediaMs);
      }
      guard += 1;
    }

    this.maybeCatchUp(now);
    return decisions;
  }

  /** 页面切后台：主动冻结管线并挂起音频。 */
  onHidden(): void {
    const now = this.clock.now();
    if (this.media.getState() === 'playing') {
      this.media.beginBuffering('background', now);
    }
  }

  /** 页面回前台：等待数据层确认缓冲区间后解冻。 */
  onVisible(): void {
    const now = this.clock.now();
    const result = this.media.notifyDataAvailable(now);
    if (result?.resumed) {
      this.log.record({
        perfMs: now,
        event: 'foregroundResume',
        phase: 'applied',
        state: 'playing',
        mediaMs: this.media.getMediaMs(now),
        outputLatencyMs: this.media.getOutputLatencyMs(),
        detail: {},
      });
    }
  }

  /** 数据层更新缓冲区间；欠载时由时钟进入 buffering(underrun)。 */
  updateBufferedRange(fromMs: number, toMs: number, liveEdgeMs: number): void {
    const now = this.clock.now();
    const report = this.media.updateBufferedRange(fromMs, toMs, liveEdgeMs, now);
    if (report.underrun) {
      this.media.beginBuffering('underrun', now);
    }
  }

  /** 数据就绪通知透传给时钟。 */
  notifyDataAvailable(): void {
    this.media.notifyDataAvailable(this.clock.now());
  }

  private handleRender(frame: MediaFrame, dueInMs: number, currentMediaMs: number): void {
    const renderer = frame.kind === 'audio' ? this.audioRenderer : this.videoRenderer;
    renderer.render(frame, dueInMs);
    this.log.record({
      perfMs: this.clock.now(),
      event: frame.kind === 'audio' ? 'audioRender' : 'videoRender',
      phase: 'scheduled',
      state: this.media.getState(),
      mediaMs: currentMediaMs,
      outputLatencyMs: this.media.getOutputLatencyMs(),
      errorMs: this.scheduler.presentationError(frame, currentMediaMs),
      detail: { ptsMs: frame.ptsMs, dueInMs, sourceSeq: frame.sourceSeq },
    });
  }

  private handleSkip(frame: MediaFrame, currentMediaMs: number): void {
    const renderer = frame.kind === 'audio' ? this.audioRenderer : this.videoRenderer;
    renderer.release(frame);
    this.log.record({
      perfMs: this.clock.now(),
      event: frame.kind === 'audio' ? 'audioSkip' : 'videoSkip',
      phase: 'rejected',
      state: this.media.getState(),
      mediaMs: currentMediaMs,
      outputLatencyMs: this.media.getOutputLatencyMs(),
      errorMs: this.scheduler.presentationError(frame, currentMediaMs),
      detail: { ptsMs: frame.ptsMs, reason: 'late', sourceSeq: frame.sourceSeq },
    });
  }

  private maybeCatchUp(now: number): void {
    const plan = this.media.planCatchUp(this.catchUpPolicy, now);
    if (!plan) {
      return;
    }
    this.media.catchUp(plan.targetMediaMs, now);
  }
}
