/**
 * 共享领域模型。单位约定：
 * - 所有时间统一用「秒」（浮点），导出时再转微秒/采样数。
 * - 时间线只有一条：画面、节拍、音频、切点都挂在同一时间坐标上。
 */

/** 片段强弱：强拍优先落在重片段上，弱片段更倾向停留更久。 */
export type SegmentWeight = "strong" | "normal" | "weak";

/** 源媒体上的可选入点（秒），片段从源时间 inPoint 开始取。 */
export interface ClipSource {
  /** 源素材标识（demo 素材或本地导入素材的 id）。 */
  sourceId: string;
  /** 源内入点（秒），默认为 0。 */
  inPoint: number;
}

/** 八段旅行片的一个片段。 */
export interface Clip {
  id: string;
  name: string;
  /** 在最终时间线上的起点（秒）。 */
  start: number;
  /** 在最终时间线上的持续时长（秒）。 */
  duration: number;
  weight: SegmentWeight;
  source: ClipSource;
}

/** 节拍事件：由 WebAudio 离线分析得到。 */
export interface Beat {
  /** 时间线上的时刻（秒）。 */
  time: number;
  /** 拍号内强度，0..1（onset 能量归一化）。 */
  strength: number;
  /** 是否为重拍（downbeat / 小节首拍）。 */
  downbeat: boolean;
}

/** 切点：一条位于时间线上的剪辑边界，可单条拖动。 */
export interface CutPoint {
  id: string;
  /** 当前切点在时间线上的时刻（秒）。 */
  time: number;
  /** 系统最初建议的时刻（秒），用于显示偏移量与复位。 */
  suggestedTime: number;
  /** 关联的两个片段 id（左、右）；首尾切点只有一侧。 */
  leftClipId: string | null;
  rightClipId: string | null;
  /** 关联的节拍时间（若切点吸附于某拍）。 */
  beatTime: number | null;
  /** true 表示用户手动拖动过，重算时必须保留。 */
  manual: boolean;
}

/** 检测到的人物说话区间（秒），用于防止话被拦腰切断。 */
export interface SpeechSpan {
  start: number;
  end: number;
  /** 平均语音能量，0..1。 */
  level: number;
}

/** 切点规划的输入参数。 */
export interface PlannerOptions {
  /** 每段最短停留（秒）；可按片段覆盖。 */
  defaultMinDuration: number;
  /** 片段级最短停留覆盖，key 为 clipId。 */
  minDurationOverrides: Record<string, number>;
  /** 只在重拍切的倾向权重（0..1，越大越偏向 downbeat）。 */
  downbeatBias: number;
  /** 允许切点偏离节拍的最大距离（秒）。 */
  maxSnapDistance: number;
}

/** 切点校验结果中的一条问题。 */
export interface CutIssue {
  cutId: string;
  kind: "speech-split" | "too-short" | "out-of-range";
  message: string;
  time: number;
}

/** 完整工程：一条时间线上的全部数据。 */
export interface Project {
  clips: Clip[];
  beats: Beat[];
  cuts: CutPoint[];
  speech: SpeechSpan[];
  duration: number;
}
