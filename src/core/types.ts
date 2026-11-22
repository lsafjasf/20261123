/** A single decoded frame, 8-bit RGBA, row-major. */
export interface Frame {
  index: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export type DefectKind = "dust" | "hair" | "scratch";

export type Decision =
  | "repaired"        // defect removed inside mask
  | "locked-content"  // ambiguous vertical line, treated as picture content
  | "skipped-motion"  // candidate overlapped moving picture, not touched
  | "disabled";       // frame repair switched off by the operator

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MaskEntry {
  id: string;
  kind: DefectKind;
  bbox: BBox;
  area: number;
  confidence: number; // 0..1
  decision: Decision;
  temporal: {
    inPrev: boolean;   // visible at same place in previous frame
    inNext: boolean;   // visible at same place in next frame
    persistence: number; // fraction of window frames showing the defect
  };
  grainBefore: number; // local grain sigma before repair
  grainAfter: number;  // local grain sigma after repair + regrain
}

export interface FrameReport {
  frame: number;
  timecode: string;
  disabled: boolean;
  manualEdit: boolean;
  masks: MaskEntry[];
}

export interface LockedLine {
  x: number;           // column of the vertical line
  frames: number[];    // frames where it was seen
  reason: string;
}

export interface Manifest {
  tool: string;
  generated: string;
  source: {
    name: string;
    width: number;
    height: number;
    fps: number;
    frameCount: number;
  };
  options: {
    repairStrength: number;
    grainPreservation: number;
    disabledFrames: number[];
  };
  frames: FrameReport[];
  lockedLines: LockedLine[];
  manualFrames: number[];
  summary: {
    repairedMasks: number;
    lockedMasks: number;
    skippedMotion: number;
    disabledFrames: number;
    manualEdits: number;
  };
}

export interface PipelineOptions {
  fps: number;
  repairStrength: number;     // 0..1, scales detection sensitivity
  grainPreservation: number;  // 0..1, fraction of local grain re-injected
  disabledFrames: Set<number>;
  windowRadius: number;       // temporal half-window (default 2)
  minDelta: number;           // absolute luma delta floor
  sigmaK: number;             // defect threshold = sigmaK * local noise
  scratchMinWidth: number;    // px
  scratchMaxWidth: number;    // px
  lockPersistence: number;    // >= this fraction of all frames => lock as content
}

export function defaultOptions(): PipelineOptions {
  return {
    fps: 24,
    repairStrength: 0.78,
    grainPreservation: 0.96,
    disabledFrames: new Set<number>(),
    windowRadius: 2,
    minDelta: 10,
    sigmaK: 3.0,
    scratchMinWidth: 1,
    scratchMaxWidth: 4,
    lockPersistence: 0.5,
  };
}
