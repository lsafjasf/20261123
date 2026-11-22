export const MANIFEST_VERSION = 1 as const;

export type SegmentKind = "scene" | "branch" | "ending";

export interface MediaSegment {
  id: string;
  name: string;
  src: string;
  durationMs: number;
  kind: SegmentKind;
  accent: string;
  summary: string;
}

export interface MainlineClip {
  id: string;
  segmentId: string;
}

export interface ChoiceOption {
  id: string;
  label: string;
  hint: string;
  targetSegmentId: string;
  targetEndMs: number;
  returnToMs: number;
  correct: boolean;
}

export interface Decision {
  id: string;
  title: string;
  prompt: string;
  timelineStartMs: number;
  timelineEndMs: number;
  pauseAtMs: number;
  options: ChoiceOption[];
}

export interface BranchManifest {
  version: typeof MANIFEST_VERSION;
  id: string;
  title: string;
  description: string;
  updatedAt: string;
  canvasWidth: number;
  canvasHeight: number;
  segments: MediaSegment[];
  mainline: MainlineClip[];
  decisions: Decision[];
}

export interface MainlinePlacement {
  clip: MainlineClip;
  segment: MediaSegment;
  index: number;
  startMs: number;
  endMs: number;
}

export interface ValidationIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}
