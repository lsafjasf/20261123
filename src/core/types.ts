export type FrameClass =
  | "normal"
  | "tear"
  | "encode-block"
  | "vfx-glitch"
  | "uncertain";

export type EvidenceTag =
  | "seam-shift"
  | "cross-time-skew"
  | "block-grid"
  | "localized-block"
  | "line-burst"
  | "recurring-pattern"
  | "scanline-baseline"
  | "low-shift-support"
  | "no-horizontal-shift";

export interface RGBAFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  timestampMs?: number;
}

export interface SeamEvidence {
  y: number;
  yRatio: number;
  shift: number;
  shiftRatio: number;
  boundary: number;
  matchGain: number;
  seamGain: number;
  seamResidual: number;
  seamBaseline: number;
  support: number;
  confidence: number;
  temporalSkew: number;
}

export interface FrameMetrics {
  lineDensity: number;
  lineBurst: number;
  lineRecurrence: number;
  blockGrid: number;
  blockAnomaly: number;
  crossFrameSkew: number;
  chromaShift: number;
}

export interface FrameAnalysis {
  index: number;
  timestampMs: number;
  width: number;
  height: number;
  classification: FrameClass;
  confidence: number;
  tearScore: number;
  encodeScore: number;
  vfxScore: number;
  seam: SeamEvidence | null;
  metrics: FrameMetrics;
  tags: EvidenceTag[];
  note: string;
}

export interface AnalyzerOptions {
  analysisWidth: number;
  minShiftPx: number;
  minSupport: number;
  maxHistory: number;
}

export interface AnalysisSummary {
  frames: number;
  counts: Record<FrameClass, number>;
  ratios: Record<FrameClass, number>;
  flaggedFrames: number;
  averageConfidence: number;
}

export interface FrameSignature {
  rowProfile: Float32Array;
  top: Float32Array;
  bottom: Float32Array;
  width: number;
  height: number;
}
