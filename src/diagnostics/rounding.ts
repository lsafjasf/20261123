import { Rational, rational } from "../time/rational.ts";

export interface RoundingStage {
  stage: string;
  representation: "exact" | "quantized";
  boundary?: string;
  note: string;
}

export const ROUNDING_STAGES: readonly RoundingStage[] = Object.freeze([
  {
    stage: "container-rate-probe",
    representation: "exact",
    note: "source fps, audio sample rate and edit base are stored as reduced bigint ratios",
  },
  {
    stage: "edit-timeline",
    representation: "exact",
    note: "cut, subtitle and audio cue times are reduced ratios of seconds",
  },
  {
    stage: "webcodecs-timestamp",
    representation: "quantized",
    boundary: "microsecond",
    note: "absolute exact time is rounded once to an integer timestamp",
  },
  {
    stage: "display-frame",
    representation: "quantized",
    boundary: "frame",
    note: "absolute exact time is rounded once to a display frame; residual is retained",
  },
  {
    stage: "audio-sample",
    representation: "quantized",
    boundary: "sample",
    note: "absolute exact time is rounded once to an output sample; residual is retained",
  },
  {
    stage: "checker-and-ui",
    representation: "quantized",
    boundary: "display-only",
    note: "decimal seconds are rendered after frame/sample checks, never fed back into them",
  },
]);

export interface LegacyDuration {
  frameDurationMs: Rational;
  accumulatedTimeMs: Rational;
  exactTimeMs: Rational;
  driftMs: Rational;
}

/**
 * Reproduces the original defect without using it in the timeline:
 * 1000 / fps was rounded to a whole millisecond and then multiplied by the
 * frame number. At 30000/1001 fps this is 33 ms per frame, so 3000 frames
 * already drift by more than one second.
 */
export function simulateRoundedDurationAccumulation(
  fpsInput: string | Rational,
  frameCount: bigint | number,
): LegacyDuration {
  const fps = fpsInput instanceof Rational ? fpsInput : rational(fpsInput);
  if (fps.compare(Rational.zero()) <= 0) throw new RangeError("fps must be positive");
  const frames = typeof frameCount === "bigint" ? frameCount : BigInt(frameCount);
  if (frames < 0n) throw new RangeError("frameCount cannot be negative");

  const exactFrameMs = Rational.of(1000n).div(fps);
  const roundedWholeMs = exactFrameMs.round("half-up");
  const frameDurationMs = Rational.integer(roundedWholeMs);
  const legacyMs = frameDurationMs.mul(Rational.integer(frames));
  const exactMs = Rational.of(1000n).mul(Rational.integer(frames)).div(fps);
  return {
    frameDurationMs,
    accumulatedTimeMs: legacyMs,
    exactTimeMs: exactMs,
    driftMs: legacyMs.sub(exactMs),
  };
}

export function describeRoundingAudit(): string {
  return ROUNDING_STAGES.map((stage) => {
    const boundary = stage.boundary ? ` -> ${stage.boundary}` : "";
    return `${stage.stage}: ${stage.representation}${boundary}; ${stage.note}`;
  }).join("\n");
}
