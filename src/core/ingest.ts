/**
 * Intermediate ingest representation. Both parsers (EDL, FCPXML) emit this;
 * normalize.ts converts it onto the unified project frame grid.
 * All times are exact rational seconds.
 */

import type { Rational } from "./rational.ts";
import type { FrameRate } from "./timecode.ts";
import type { TrackKind, TransitionKind } from "./model.ts";

export interface IngestSpeedSegment {
  /** Timeline-relative start (seconds, rational). */
  readonly timelineStart: Rational;
  readonly timelineDuration: Rational;
  /** Source start in seconds on the source-rate grid. */
  readonly sourceStart: Rational;
  readonly speed: number;
  readonly ramp: boolean;
}

export interface IngestTransition {
  readonly kind: TransitionKind;
  readonly name: string;
  readonly duration: Rational;
  /** Timeline position (seconds) where the transition starts. */
  readonly at: Rational;
}

export interface IngestClip {
  readonly name: string;
  readonly reel: string;
  readonly mediaPath: string | null;
  readonly sourceRate: FrameRate;
  readonly sourceIn: Rational;
  readonly sourceOut: Rational;
  readonly recordIn: Rational;
  readonly recordOut: Rational;
  readonly speedSegments: IngestSpeedSegment[];
  readonly transitions: IngestTransition[];
  readonly capabilities: string[];
  readonly kind: TrackKind;
  readonly lane: number;
}

export interface IngestResult {
  readonly title: string;
  readonly sourceFile: string;
  /** Rate declared by the file itself, if any (FCPXML always; EDL via FCM/CLI). */
  readonly declaredRate: FrameRate | null;
  readonly clips: IngestClip[];
  readonly warnings: string[];
}
