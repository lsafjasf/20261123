export interface RgbaFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface LumaFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface FrameScheduleEntry {
  index: number;
  timeSec: number;
  timestampUs: number;
  sourceIndex: number;
  nextSourceIndex: number;
  nearestSourceIndex: number;
  sourcePhase: number;
}

export interface MotionField {
  width: number;
  height: number;
  blockSize: number;
  cols: number;
  rows: number;
  vx: Float32Array;
  vy: Float32Array;
  cost: Float32Array;
}

export interface PairMotion {
  forward: MotionField;
  backward: MotionField;
  estimateMs: number;
}

export interface InterpolationRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  feather: number;
  strength: number;
  enabled: boolean;
}

export interface InterpolationSettings {
  blockSize: number;
  maxDisplacement: number;
  occlusionThreshold: number;
  photoThreshold: number;
  costThreshold: number;
  region: InterpolationRegion;
}

export interface InterpolationStats {
  interpolatedPixels: number;
  occludedPixels: number;
  averageConfidence: number;
  meanForwardBackwardError: number;
}

export interface InterpolationResult {
  frame: RgbaFrame;
  occlusionMask: Uint8Array;
  occlusionEdgeMask: Uint8Array;
  stats: InterpolationStats;
}

export interface TimingSummary {
  count: number;
  averageIntervalMs: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  jitterMs: number;
  maxTimestampErrorUs: number;
  ordered: boolean;
  duplicateTimestamps: number;
}

export interface SyntheticCheck {
  sourceFrames: number;
  outputFrames: number;
  timing: TimingSummary;
  meanAbsoluteError: number;
  nearestFrameError: number;
  errorImprovement: number;
  panelMeanAbsoluteError: number;
  panelNearestFrameError: number;
  peakAbsoluteError: number;
  occlusionEdgeCoverage: number;
  guardedPixelRatio: number;
  elapsedMs: number;
}
