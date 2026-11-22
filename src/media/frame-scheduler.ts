import type { MediaFrame, ScheduleDecision } from './media-types.ts';

/** 调度器参数。 */
export interface SchedulerOptions {
  /** 提前量（毫秒）：音频需要提前入队以补偿输出延迟。 */
  readonly audioLeadMs: number;
  /** 视频容忍提前量（毫秒），超过则继续等待。 */
  readonly videoLeadMs: number;
  /** 迟到超过该阈值（毫秒）的帧选择跳帧而不是立即补渲染。 */
  readonly lateToleranceMs: number;
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  audioLeadMs: 0,
  videoLeadMs: 12,
  lateToleranceMs: 60,
};

/**
 * 帧渲染调度决策（纯函数，无 DOM 依赖）。
 * 所有判断都基于统一媒体时钟给出的 currentMediaMs，
 * 因此缓冲冻结（currentMediaMs 停止）时音视频决策同时停滞。
 */
export class FrameScheduler {
  private readonly options: SchedulerOptions;

  constructor(options: Partial<SchedulerOptions> = {}) {
    this.options = { ...DEFAULT_SCHEDULER_OPTIONS, ...options };
  }

  /**
   * 决定队首帧的处理方式。
   * @param frame 抖动缓冲队首帧
   * @param currentMediaMs 统一时钟当前媒体时间
   * @param outputLatencyMs 当前音频输出延迟（蓝牙），仅作用于音频提前量
   */
  decide(frame: MediaFrame | null, currentMediaMs: number, outputLatencyMs: number): ScheduleDecision {
    if (!frame) {
      return { action: 'wait' };
    }
    const errorMs = frame.ptsMs - currentMediaMs;

    if (frame.kind === 'audio') {
      // 音频需要在“外部时钟 - 输出延迟”时刻发声，因此按延迟量提前调度。
      const lead = outputLatencyMs + this.options.audioLeadMs;
      if (errorMs <= lead) {
        if (errorMs < -this.options.lateToleranceMs) {
          return { action: 'skip', frame, reason: 'late' };
        }
        return { action: 'render', frame, dueInMs: Math.max(0, errorMs - outputLatencyMs) };
      }
      return { action: 'wait' };
    }

    // 视频：在帧 PTS 附近（容忍提前量内）呈现到 Canvas。
    if (errorMs <= this.options.videoLeadMs) {
      if (errorMs < -this.options.lateToleranceMs) {
        return { action: 'skip', frame, reason: 'late' };
      }
      return { action: 'render', frame, dueInMs: Math.max(0, errorMs) };
    }
    return { action: 'wait' };
  }

  /**
   * 计算帧相对于统一时钟的呈现误差（毫秒）。
   * 正值表示帧偏早（PTS 在未来），负值表示迟到。用于日志与质量统计。
   */
  presentationError(frame: MediaFrame, currentMediaMs: number): number {
    return Math.round((frame.ptsMs - currentMediaMs) * 1000) / 1000;
  }
}
