/**
 * Time-base conversion between legacy integer milliseconds and the new
 * frame/sample based grid.
 *
 * Key rule: always convert ABSOLUTE timeline positions, never durations.
 * Rounding a position costs at most half a tick; rounding durations and
 * summing them lets the error accumulate without bound.
 */

import {
  type Rational,
  type RoundedInt,
  rational,
  mul,
  div,
  roundToInt,
  toNumber,
} from "./rational.ts";

export type TimeUnit = "frames" | "samples";

export interface TimeGrid {
  readonly unit: TimeUnit;
  /** Ticks per second: frame rate for video, sample rate for audio. */
  readonly ticksPerSecond: Rational;
  /** Short label used in traces, e.g. "30000/1001fps" or "48000Hz". */
  readonly label: string;
}

export function videoGrid(fps: Rational): TimeGrid {
  return { unit: "frames", ticksPerSecond: fps, label: `${fps.num}/${fps.den}fps` };
}

export function audioGrid(sampleRate: number): TimeGrid {
  return {
    unit: "samples",
    ticksPerSecond: rational(sampleRate),
    label: `${sampleRate}Hz`,
  };
}

export interface ConvertedTime {
  /** Integer tick on the target grid. */
  readonly ticks: bigint;
  /** True when the legacy position lands exactly on a tick boundary. */
  readonly exact: boolean;
  /** Signed error in milliseconds (exact position minus rounded position). */
  readonly errorMs: number;
  /** Signed error in ticks. */
  readonly errorTicks: Rational;
}

/** Converts an integer-millisecond position onto the grid. */
export function msToGrid(ms: number, grid: TimeGrid): ConvertedTime {
  if (!Number.isSafeInteger(ms)) {
    throw new RangeError(`time: legacy position must be an integer ms, got ${ms}`);
  }
  const seconds = rational(BigInt(ms), 1000n);
  const exactTicks = mul(seconds, grid.ticksPerSecond);
  const rounded: RoundedInt = roundToInt(exactTicks);
  const errorSeconds = div(rounded.error, grid.ticksPerSecond);
  return {
    ticks: rounded.value,
    exact: rounded.exact,
    errorMs: toNumber(errorSeconds) * 1000,
    errorTicks: rounded.error,
  };
}

/** Converts integer ticks back to seconds (as a float, for reporting). */
export function ticksToSeconds(ticks: bigint, grid: TimeGrid): number {
  return toNumber(div(rational(ticks), grid.ticksPerSecond));
}

/** Duration of one tick in milliseconds. */
export function tickDurationMs(grid: TimeGrid): number {
  return toNumber(div(rational(1000n), grid.ticksPerSecond));
}

export interface Tolerance {
  /**
   * Maximum allowed absolute difference between legacy and migrated
   * total sequence duration, in milliseconds. Default: half a video
   * frame plus half an audio sample of the project grid.
   */
  readonly maxDurationDriftMs: number;
  /**
   * When true, any cut point that does not land exactly on a grid tick
   * sends its clip to the quarantine list instead of the approximate
   * list. Default false.
   */
  readonly requireExactCuts: boolean;
}

export function defaultTolerance(video: TimeGrid, audio: TimeGrid): Tolerance {
  const drift = tickDurationMs(video) / 2 + tickDurationMs(audio) / 2;
  return { maxDurationDriftMs: drift, requireExactCuts: false };
}
