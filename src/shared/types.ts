export interface AudioTrack {
  name: string;
  sampleRate: number;
  channels: Float32Array[];
  duration: number;
}

export type WindowKind = "silence" | "music" | "ambient" | "transient";

export interface AnalysisWindow {
  index: number;
  start: number;
  end: number;
  rms: number;
  peak: number;
  zcr: number;
  periodicity: number;
  onsetCount: number;
  kind: WindowKind;
  usable: boolean;
  lagMs: number | null;
  corrPeak: number;
  corrZ: number;
  confidence: number;
  excluded: boolean;
}

export interface Anchor {
  t: number;
  offsetMs: number;
  confidence: number;
  corrZ: number;
  kind: WindowKind;
  windowIndex: number;
}

export interface CurveSegment {
  index: number;
  start: number;
  end: number;
  offsetMsAtStart: number;
  offsetMsAtEnd: number;
  slopeMsPerSec: number;
  stretchFactor: number;
  confidence: number;
  residualMs: number;
  anchorCount: number;
  enabled: boolean;
}

export interface AnalysisResult {
  params: AnalysisParams;
  duration: number;
  refSampleRate: number;
  recSampleRate: number;
  windows: AnalysisWindow[];
  anchors: Anchor[];
  segments: CurveSegment[];
  breakpoints: number[];
  globalFit: { interceptMs: number; slopeMsPerSec: number; residualMs: number };
  createdAt: string;
}

export interface AnalysisParams {
  windowSec: number;
  hopSec: number;
  maxOffsetMs: number;
  silenceDb: number;
  periodicityLimit: number;
  maxSegments: number;
}

export const DEFAULT_PARAMS: AnalysisParams = {
  windowSec: 2.0,
  hopSec: 1.0,
  maxOffsetMs: 600,
  silenceDb: -55,
  periodicityLimit: 0.45,
  maxSegments: 6,
};
