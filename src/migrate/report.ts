/**
 * Migration report: the auditable output of a run. Three disjoint
 * buckets per clip — migrated, approximate (migrated but with rounded
 * cut points, listed separately as required), and quarantined (failed,
 * isolated from the rest of the project).
 */

import type { CutPointTrace } from "../model/schema.ts";

export interface ApproximateEntry {
  readonly sequenceId: string;
  readonly trackId: string;
  readonly clipId: string;
  /** Only the cut points that needed rounding. */
  readonly roundedCuts: readonly CutPointTrace[];
  readonly maxAbsErrorMs: number;
}

export interface QuarantineEntry {
  readonly sequenceId: string;
  readonly trackId: string;
  readonly clipId: string;
  readonly reason: string;
  /** The raw legacy clip, preserved verbatim for manual repair. */
  readonly legacyClip: unknown;
}

export interface SequenceDurationCheck {
  readonly sequenceId: string;
  readonly legacyDurationMs: number;
  readonly migratedDurationMs: number;
  readonly driftMs: number;
  readonly toleranceMs: number;
  readonly withinTolerance: boolean;
}

export interface MigrationReport {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly projectId: string;
  readonly totals: {
    readonly clipsMigrated: number;
    readonly clipsReusedFromCache: number;
    readonly clipsApproximate: number;
    readonly clipsQuarantined: number;
  };
  readonly approximate: readonly ApproximateEntry[];
  readonly quarantined: readonly QuarantineEntry[];
  readonly durationChecks: readonly SequenceDurationCheck[];
}

/** Error type for hard, per-clip migration failures. */
export class ClipMigrationError extends Error {
  readonly clipId: string;
  constructor(clipId: string, message: string) {
    super(message);
    this.name = "ClipMigrationError";
    this.clipId = clipId;
  }
}
