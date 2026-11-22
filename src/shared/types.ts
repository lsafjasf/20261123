/**
 * Shared type definitions used by both the browser client and the Node tests.
 * All coordinates are normalized to [0, 1] relative to the compositor canvas.
 */

export type PanelId = 'main' | 'cams' | 'map';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PanelRects = Record<PanelId, Rect>;

/** A keyframe pins the three panel rects at a point on the master timeline. */
export interface LayoutKeyframe {
  frame: number;
  rects: PanelRects;
  /** Human label for the match segment, e.g. "team-fight round 3". */
  label?: string;
}

/** A key HUD region drawn on the main feed, in normalized coordinates. */
export interface HudZone {
  id: string;
  label: string;
  rect: Rect;
  /** Fraction of the zone area that may be covered before an alert is raised. */
  tolerance: number;
}

export type OcclusionLevel = 'clear' | 'partial' | 'blocked';

export interface OcclusionResult {
  zoneId: string;
  level: OcclusionLevel;
  /** Covered fraction in [0, 1], measured against the zone area. */
  covered: number;
}

export type ManifestEventType =
  | 'layout-change'
  | 'occlusion'
  | 'occlusion-clear'
  | 'cut';

export interface ManifestEvent {
  frame: number;
  timeSec: number;
  type: ManifestEventType;
  panel?: PanelId;
  zoneId?: string;
  level?: OcclusionLevel;
  detail: string;
}

export interface LayoutManifest {
  frameRate: number;
  width: number;
  height: number;
  generatedAt: string;
  events: ManifestEvent[];
}

export interface CutDecision {
  isCut: boolean;
  /** Mean absolute pixel difference, normalized to [0, 1]. */
  diff: number;
  threshold: number;
}

export interface VerificationResult {
  comparedFrames: number;
  maxChannelDelta: number;
  meanChannelDelta: number;
  mismatchedFrames: number;
  passed: boolean;
  tolerance: number;
  perFrame: Array<{ frame: number; maxDelta: number; meanDelta: number }>;
}
