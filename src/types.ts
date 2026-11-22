// 共享类型定义（纯类型，构建时全部擦除）。

export type SegmentKind =
  | 'dropout'  // 掉字：语音中间的短暂丢失（默认 30ms ~ 1s）
  | 'pop'      // 单点爆音：瞬时尖峰/个别削波采样
  | 'clip'     // 持续削波：连续满幅失真
  | 'silence'  // 异常空白：超过阈值的整段静音
  | 'noise'    // 持续噪声：高谱平坦度、非调性的稳态声音
  | 'music'    // 音乐：调性/谐波持续段（信息项，不算故障）
  | 'pause';   // 正常停顿（含白名单命中的静音段）

export interface FrameFeatures {
  rate: number;        // 分析采样率（固定 16000）
  hopSec: number;      // 帧移（秒）
  count: number;       // 帧数
  rms: Float32Array;
  peak: Float32Array;
  maxJump: Float32Array;   // 帧内最大相邻采样差（爆音特征）
  clipCount: Uint16Array;  // 帧内 |x|>=clipLevel 的采样数
  flatness: Float32Array;  // 谱平坦度 0..1（高=噪声样，低=调性）
  centroid: Float32Array;  // 归一化谱质心 0..1
}

export interface Segment {
  kind: SegmentKind;
  start: number;   // 秒
  end: number;     // 秒
  confidence: number; // 0..1
  detail: string;  // 人读摘要，如 "持续 3.2s，RMS -58dB"
  whitelisted: boolean;
}

export interface Thresholds {
  silenceDb: number;      // 静音判定 RMS 门限（dBFS），默认 -50
  silenceMinSec: number;  // 超过此时长算“异常空白”，默认 2
  dropoutMinSec: number;  // 掉字最短时长，默认 0.03
  dropoutMaxSec: number;  // 掉字最长时长，默认 1.0
  popJump: number;        // 爆音相邻采样跳变门限，默认 0.5
  popMaxSec: number;      // 单点爆音最长时长，默认 0.05
  clipMinSec: number;     // 持续削波最短时长，默认 0.1
  noiseFlatness: number;  // 噪声谱平坦度下限，默认 0.45
  noiseMinDb: number;     // 噪声能量下限（dBFS），默认 -45
  noiseMinSec: number;    // 持续噪声最短时长，默认 1
  musicFlatness: number;  // 音乐谱平坦度上限，默认 0.12
  musicMinDb: number;     // 音乐能量下限，默认 -40
  musicMinSec: number;    // 音乐最短时长，默认 2
}

export interface WhitelistRule {
  minSec: number;  // 命中时长区间（含边界）
  maxSec: number;
  label: string;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  silenceDb: -50,
  silenceMinSec: 2,
  dropoutMinSec: 0.03,
  dropoutMaxSec: 1.0,
  popJump: 0.5,
  popMaxSec: 0.05,
  clipMinSec: 0.1,
  noiseFlatness: 0.45,
  noiseMinDb: -45,
  noiseMinSec: 1,
  musicFlatness: 0.12,
  musicMinDb: -40,
  musicMinSec: 2,
};
