// Shared types for the timelapse pipeline.

export interface PhotoMeta {
  name: string;
  url: string;
  bytes: number;
  mtime: number;
}

export interface Anchor {
  id: number;
  x: number; // reference-frame coordinates
  y: number;
}

// Similarity transform without rotation: out = s * p + t
export interface Transform {
  s: number;
  tx: number;
  ty: number;
}

export interface FrameAnalysis {
  index: number;
  name: string;
  transform: Transform;
  residualPx: number;      // RMS anchor error after fit
  matchedAnchors: number;  // anchors that matched above NCC threshold
  evRaw: number;           // measured log2 luminance
  evTrend: number;         // slow day/night component
  evCorrection: number;    // applied gain (flicker removal only)
  skipped: boolean;
  dwell: number;           // extra output repeats (0 = normal)
  anomalies: string[];
}

export interface Anomaly {
  frame: number;
  name: string;
  kind: string;
  detail: string;
}

export const IDENTITY: Transform = { s: 1, tx: 0, ty: 0 };
