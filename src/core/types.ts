/**
 * 核心领域类型定义。
 * 该模块不依赖任何 DOM / Node API，可在浏览器与 Node 测试环境中复用。
 */

/** 播放状态机：所有状态切换都由统一媒体时钟（MediaClock）独占管理。 */
export type PlaybackState =
  | 'idle' // 尚未开始
  | 'playing' // 正常播放，媒体时间随外部时钟推进
  | 'buffering' // 缓冲冻结：画面与声音一起停住，媒体时间不推进
  | 'paused' // 用户主动暂停
  | 'ended'; // 直播结束

/** 引发缓冲冻结的原因，写入日志便于复盘。 */
export type BufferReason =
  | 'initial' // 起播缓冲
  | 'underrun' // 播放中数据不足（含切后台导致的喂料中断）
  | 'seek' // 拖动后目标位置数据未就绪
  | 'background'; // 页面切后台主动冻结

/** 位置类命令的来源：用户操作优先级始终高于自动追直播。 */
export type CommandKind = 'userSeek' | 'catchUp' | 'pause' | 'resume' | 'end';

/**
 * 时间锚点：媒体时间与外部单调时钟（performance.now 语义，毫秒）的线性映射。
 * mediaTime = anchorMediaMs + (nowPerfMs - anchorPerfMs) * rate - outputLatencyMs
 */
export interface TimelineAnchor {
  /** 锚点对应的媒体时间线位置（毫秒，直播场景下为相对于直播起点的 PTS）。 */
  readonly mediaMs: number;
  /** 锚点对应的外部单调时钟读数（毫秒）。 */
  readonly perfMs: number;
  /** 播放速率，暂停/冻结时为 0。 */
  readonly rate: number;
  /** 当前输出链路延迟（蓝牙耳机等），单位毫秒。 */
  readonly outputLatencyMs: number;
}

/** 位置跳转命令。 */
export interface SeekCommand {
  readonly kind: 'userSeek' | 'catchUp';
  /** 目标媒体时间（毫秒）。 */
  readonly targetMediaMs: number;
  /** 命令生成时的外部时钟读数。 */
  readonly issuedPerfMs: number;
  /** 单调递增序号，用于日志排序与去重。 */
  readonly seq: number;
}

/** 简单控制命令。 */
export interface ControlCommand {
  readonly kind: 'pause' | 'resume' | 'end';
  readonly issuedPerfMs: number;
  readonly seq: number;
}

export type Command = SeekCommand | ControlCommand;

/** 事件触发阶段，明确记录顺序。 */
export type EventPhase =
  | 'received' // 输入事件被时钟接收
  | 'queued' // 缓冲冻结期间入队等待
  | 'applied' // 已作用于时间线/状态机
  | 'rejected' // 按确定性规则丢弃
  | 'scheduled'; // 已下发到音频/视频渲染侧

/** 统一结构化日志条目。 */
export interface LogEntry {
  /** 日志序列号，严格单调递增，反映真实触发顺序。 */
  readonly seq: number;
  /** 外部单调时钟读数（毫秒）。 */
  readonly perfMs: number;
  /** 事件名，例如 userSeek / catchUp / bufferStart / bufferEnd / latencyChange / pause / resume。 */
  readonly event: string;
  readonly phase: EventPhase;
  /** 事件发生瞬间的播放状态（切换前的旧状态）。 */
  readonly state: PlaybackState;
  /** 当前媒体时间（毫秒）。 */
  readonly mediaMs: number;
  /** 当前输出延迟（毫秒）。 */
  readonly outputLatencyMs: number;
  /** 实测与目标之间的误差（毫秒），无误差语义时为 0。 */
  readonly errorMs: number;
  /** 结构化细节，例如缓冲原因、命令来源、丢弃原因等。 */
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

/** 输出设备延迟信息（WebAudio AudioContext 语义的抽象）。 */
export interface LatencyInfo {
  /** baseLatency，AudioContext 处理块固有延迟。 */
  readonly baseLatencyMs: number;
  /** outputLatency，含蓝牙编解码/传输链路的实时延迟，设备切换时会突变。 */
  readonly outputLatencyMs: number;
  readonly perfMs: number;
}

/** 时钟对外暴露的只读快照。 */
export interface ClockSnapshot {
  readonly state: PlaybackState;
  readonly mediaMs: number;
  readonly outputLatencyMs: number;
  readonly anchor: TimelineAnchor;
  /** 距离直播边缘（最新可用位置）的滞后量，毫秒。 */
  readonly liveEdgeLagMs: number;
  readonly bufferedToMs: number;
}

/** 追直播策略参数。 */
export interface CatchUpPolicy {
  /** 滞后超过该阈值才发起追直播（毫秒）。 */
  readonly thresholdMs: number;
  /** 每次追直播向直播边缘靠拢的步长（毫秒）。 */
  readonly stepMs: number;
  /** 离直播边缘小于该距离即视为已追上（毫秒）。 */
  readonly withinMs: number;
}

/** 单调时钟抽象，测试中可注入虚拟时钟。 */
export interface MonotonicClock {
  now(): number;
}
