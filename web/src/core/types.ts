export interface AudioSource {
  name: string;
  sampleRate: number;
  channels: Float32Array[];
  bitDepth: number;
  format: "pcm" | "float" | "demo";
  originalBytes: number;
  isDemo: boolean;
}

export type SegmentState = "active" | "bypassed" | "undone";

export interface DetectedPause {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  confidence: number;
  levelDb: number;
  spectralTilt: number;
  state: SegmentState;
  targetMs: number;
  kind: "clean" | "breath" | "long";
}

export interface DetectionSettings {
  minSilenceMs: number;
  targetMs: number;
  smartProtection: boolean;
}

export interface SegmentTimeline {
  segment: DetectedPause;
  outputStart: number;
  outputEnd: number;
}

export interface RenderOptions {
  targetMs: number;
  speed: number;
  segments: DetectedPause[];
}

export interface RenderResult {
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
  timeline: SegmentTimeline[];
  removedSeconds: number;
}

export interface LoudnessResult {
  integratedLufs: number;
  truePeakDb: number;
  limitedSamples: number;
}

export interface MasterResult extends LoudnessResult {
  channels: Float32Array[];
  gainDb: number;
}
