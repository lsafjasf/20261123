/**
 * 版本化检测参数。
 * 任何阈值调整都必须提升 ENGINE_VERSION —— 分析结果里会记录版本与
 * 参数哈希，旧检查点若版本不一致会被拒绝续扫，保证「同一文件重复扫描结果稳定」。
 */
export const ENGINE_VERSION = '1.0.0';
export const SCHEMA_VERSION = 1;

export interface DetectorConfig {
  black: {
    /** 亮度低于该值视为黑像素。 */
    pixelLumaThreshold: number;
    /** 黑像素占比超过该值的帧判定为黑帧。 */
    frameBlackRatio: number;
    /** 连续黑帧不少于该时长（秒）才记为黑场。 */
    minDurationSec: number;
    /** 黑场中允许穿插的非黑帧数量（抗单帧闪白误判）。 */
    gapToleranceFrames: number;
  };
  freeze: {
    /** 帧间差低于该值视为「无变化」。 */
    diffThreshold: number;
    /** 块运动低于该值同时满足才视为静止（排除压缩噪声）。 */
    motionThreshold: number;
    minDurationSec: number;
    gapToleranceFrames: number;
  };
  shake: {
    /** 块运动幅度高于该值视为「有明显运动」。 */
    motionThreshold: number;
    /** 方向无序占比高于该值视为抖动而非平移。 */
    disorderThreshold: number;
    /** 滑窗长度（帧）。 */
    windowFrames: number;
    /** 滑窗内命中帧比例达到该值判定为抖动窗。 */
    windowHitRatio: number;
    minDurationSec: number;
  };
  shot: {
    /** 帧间差超过该值视为硬切候选。 */
    hardCutDiff: number;
    /** 渐变检测滑窗（帧）。 */
    dissolveWindowFrames: number;
    /** 渐变窗口平均差超过该值视为软切。 */
    dissolveAvgDiff: number;
    /** 短于该时长的镜头并入相邻镜头（秒）。 */
    minShotDurationSec: number;
  };
  /** 标签严重度对应的命中时长占比门槛。 */
  labelCoverage: {
    high: number;
    medium: number;
  };
  /** 同事名单：镜头按稳定哈希分配，重复扫描分配结果不变。 */
  assignees: string[];
}

export const DEFAULT_CONFIG: DetectorConfig = {
  black: {
    pixelLumaThreshold: 16,
    frameBlackRatio: 0.98,
    minDurationSec: 0.5,
    gapToleranceFrames: 1,
  },
  freeze: {
    diffThreshold: 2.0,
    motionThreshold: 0.75,
    minDurationSec: 1.0,
    gapToleranceFrames: 2,
  },
  shake: {
    motionThreshold: 6.0,
    disorderThreshold: 0.45,
    windowFrames: 12,
    windowHitRatio: 0.6,
    minDurationSec: 0.5,
  },
  shot: {
    hardCutDiff: 28,
    dissolveWindowFrames: 8,
    dissolveAvgDiff: 10,
    minShotDurationSec: 0.3,
  },
  labelCoverage: {
    high: 0.25,
    medium: 0.08,
  },
  assignees: ['剪辑-A', '剪辑-B', '剪辑-C', '剪辑-D'],
};

/** 稳定字符串哈希（FNV-1a 32 位），用于参数哈希与镜头分配。 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 对配置做规范序列化后哈希，作为结果可追溯凭据。 */
export function configHash(config: DetectorConfig = DEFAULT_CONFIG): string {
  return fnv1a(JSON.stringify(config)).toString(16).padStart(8, '0');
}
