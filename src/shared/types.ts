/**
 * 浏览器采集端与 Node 分析端共享的数据契约。
 * 只使用「可擦除类型注解」语法，Node 24 可直接运行，无需编译步骤。
 */

/** 单帧采样指标，由浏览器 Canvas/WebAudio 管线产生，也是后端唯一输入。 */
export interface FrameMetric {
  /** 帧序号，从 0 开始，严格连续。 */
  index: number;
  /** 显示时间戳（秒），来自视频轨道 PTS，而不是墙上时钟。 */
  pts: number;
  /** 帧平均亮度 0..255（BT.601 灰度）。 */
  meanLuma: number;
  /** 黑像素占比 0..1（亮度低于阈值的像素比例）。 */
  blackRatio: number;
  /** 与上一帧的平均像素差（灰度绝对差均值，0..255）。 */
  diff: number;
  /** 与上一帧的块运动向量平均幅度（按 16x16 块做全搜索）。 */
  motion: number;
  /** 与上一帧方向不一致的块运动向量占比 0..1，用于抖动判定。 */
  motionDisorder: number;
  /** 该帧时刻的音频 RMS（无音轨时为 0）。 */
  audioRms: number;
}

/** 一次扫描的完整指标包。 */
export interface MetricBundle {
  schemaVersion: number;
  engineVersion: string;
  file: {
    name: string;
    size: number;
    /** 文件内容 SHA-256；重复扫描稳定性基于该值而非路径。 */
    sha256: string;
  };
  video: {
    width: number;
    height: number;
    frameRate: number;
    frameCount: number;
    durationSec: number;
    hasAudio: boolean;
  };
  /** 采样率：每 N 帧保留一帧指标；1 表示逐帧。 */
  sampleEvery: number;
  frames: FrameMetric[];
  /** 采集端能力信息，仅用于审计，不参与确定性计算。 */
  collector: string;
  createdAt: string;
}

export type SegmentKind =
  | 'black'
  | 'freeze'
  | 'shake'
  | 'shot'
  | 'gap';

/** 分析输出的时间区间（时间码为帧号换算的非丢帧 SMPTE）。 */
export interface Segment {
  kind: SegmentKind;
  startFrame: number;
  endFrame: number;
  startPts: number;
  endPts: number;
  startTc: string;
  endTc: string;
  /** 区间长度（秒）。 */
  durationSec: number;
  /** 抖动/黑场等区间附带的严重度 0..1，便于人工复核排序。 */
  severity: number;
  /** 触发该区间的平均指标，供剪辑复核。 */
  evidence: Record<string, number>;
}

export interface ShotSegment extends Segment {
  kind: 'shot';
  /** 镜头序号，从 1 开始，稳定编号（按起始帧排序）。 */
  shotId: number;
  /** 分配给的同事（确定性哈希分配）。 */
  assignee: string;
  /** 该镜头内命中的文件级标签。 */
  flags: string[];
}

export interface AnalysisResult {
  schemaVersion: number;
  engineVersion: string;
  sha256: string;
  fileName: string;
  frameRate: number;
  frameCount: number;
  durationSec: number;
  labels: FileLabel[];
  black: Segment[];
  freeze: Segment[];
  shake: Segment[];
  shots: ShotSegment[];
  /** 检测参数摘要，保证结果可追溯。 */
  configHash: string;
  analyzedAt: string;
}

export interface FileLabel {
  label: 'black' | 'still' | 'shaky';
  severity: 'high' | 'medium' | 'low';
  /** 命中时长占比 0..1。 */
  coverage: number;
  occurrences: number;
}

/** 断点续扫的检查点状态。 */
export interface ScanState {
  sha256: string;
  fileName: string;
  size: number;
  engineVersion: string;
  status: 'scanning' | 'done';
  /** 已持久化的连续批次数（批次从 0 开始）。 */
  nextBatchIndex: number;
  /** 已接收的最后一帧序号；续扫时浏览器从该帧之后继续。 */
  lastFrameIndex: number;
  totalFrames: number;
  sampleEvery: number;
  videoMeta: MetricBundle['video'] | null;
  updatedAt: string;
}

export interface BatchUpload {
  sha256: string;
  fileName: string;
  size: number;
  engineVersion: string;
  batchIndex: number;
  sampleEvery: number;
  videoMeta?: MetricBundle['video'];
  frames: FrameMetric[];
}

export interface BatchAck {
  sha256: string;
  nextBatchIndex: number;
  lastFrameIndex: number;
  status: ScanState['status'];
}
