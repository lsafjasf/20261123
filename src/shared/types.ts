// 共享数据模型：日志事件、帧索引、锚点、映射、连招

export type ButtonState = 'down' | 'up';

export interface InputEvent {
  /** 日志时钟，毫秒（单调，与视频零点无关） */
  t: number;
  btn: string;
  state: ButtonState;
}

export interface InputLog {
  /** 采集设备/会话元信息，可选 */
  meta?: Record<string, string>;
  events: InputEvent[];
}

export interface FrameInfo {
  /** 该帧在视频时间轴上的呈现时间，毫秒 */
  pts: number;
  /** 该帧标称时长，毫秒（VFR 下逐帧不同） */
  dur: number;
}

export interface FrameIndex {
  frames: FrameInfo[];
  /** 检测到的暂停（PTS 大跳变）位置：帧下标 i 表示 gap 出现在 i 与 i+1 之间 */
  pauses: { afterFrame: number; gapMs: number }[];
  medianFrameMs: number;
}

export type AnchorKind = 'startup' | 'run' | 'manual';

export interface Anchor {
  id: string;
  /** 日志时间（毫秒） */
  logT: number;
  /** 对应的视频 PTS（毫秒） */
  videoT: number;
  kind: AnchorKind;
  /** 拟合权重，manual 默认最高 */
  weight: number;
  note?: string;
}

export interface MappingSegment {
  id: number;
  startLogT: number;
  endLogT: number;
  /** video = a * logT + b */
  a: number;
  b: number;
  confidence: number;
  flags: string[];
}

export interface SyncMapping {
  segments: MappingSegment[];
  anchors: Anchor[];
  /** 被判定为冲突并降权的锚点 id */
  conflicts: { anchorId: string; residualMs: number }[];
}

export interface ComboStep {
  btn: string;
  /** 距上一步允许的最大间隔，毫秒 */
  withinMs: number;
}

export interface ComboDef {
  id: string;
  name: string;
  steps: ComboStep[];
}

export interface ComboMatch {
  comboId: string;
  name: string;
  startLogT: number;
  endLogT: number;
}

export interface MappedEvent {
  index: number;
  logT: number;
  btn: string;
  state: ButtonState;
  videoT: number;
  frame: number;
  segmentId: number;
  confidence: number;
  flags: string[];
}
