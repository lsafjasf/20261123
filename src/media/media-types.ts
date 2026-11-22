/**
 * 媒体管线类型。帧统一携带媒体时间线 PTS（毫秒），
 * 由统一媒体时钟决定呈现时机，管线自身不维护独立时钟。
 */

export type FrameKind = 'audio' | 'video';

/** 解码后的媒体帧（WebCodecs 输出的抽象载荷）。 */
export interface MediaFrame {
  readonly kind: FrameKind;
  /** 呈现时间戳，位于统一媒体时间线上（毫秒）。 */
  readonly ptsMs: number;
  /** 帧持续时长（毫秒），音频为采样块时长，视频为帧间隔。 */
  readonly durationMs: number;
  /**
   * 解码载荷。浏览器中为 VideoFrame / AudioData；
   * 离线测试中为可比较的占位对象。
   */
  readonly payload: unknown;
  /** 来源序号，便于日志追溯。 */
  readonly sourceSeq: number;
}

/** 传输层产出的压缩包（MediaSource 初始化段/媒体段的抽象）。 */
export interface MediaChunk {
  readonly kind: FrameKind;
  /** 段内起始 PTS（毫秒）。 */
  readonly ptsMs: number;
  readonly durationMs: number;
  readonly data: Uint8Array;
  readonly isInitSegment: boolean;
}

/** 抖动缓冲统计快照。 */
export interface JitterStats {
  readonly audioFrames: number;
  readonly videoFrames: number;
  readonly lowestPtsMs: number | null;
  readonly highestPtsMs: number | null;
  readonly depthMs: number;
}

/** 渲染调度决策。 */
export type ScheduleDecision =
  | { readonly action: 'render'; readonly frame: MediaFrame; readonly dueInMs: number }
  | { readonly action: 'skip'; readonly frame: MediaFrame; readonly reason: 'late' | 'unblock' }
  | { readonly action: 'wait' };

/** 传输层抽象：MediaSource 实时路径与离线合成源共用同一接口。 */
export interface MediaTransport {
  /** 拉取/推送下一个压缩段，无数据时返回 null。 */
  nextChunk(): MediaChunk | null;
  /** 直播边缘（最新可提供位置，毫秒）。 */
  liveEdgeMs(): number;
}
