import { Rational, type RoundingMode } from "../time/rational.ts";
import { ExactTimeline } from "../time/timeline.ts";

export interface DecodedTimestampLike {
  timestamp: number | null;
  duration?: number | null;
}

export interface TimestampAlignment {
  sourceFrame: bigint;
  timestampUs: bigint;
  exactFrameTime: Rational;
  residualSeconds: Rational;
  residualUs: Rational;
  aligned: boolean;
}

function asNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new RangeError(`${label} ${value} exceeds WebCodecs' safe integer range`);
  }
  return number;
}

/**
 * The only place where exact source/display time becomes a WebCodecs
 * microsecond timestamp. Durations are differences between absolute
 * timestamps, never a rounded per-frame duration multiplied by a frame count.
 */
export class ExactWebCodecsClock {
  readonly timeline: ExactTimeline;
  readonly rounding: RoundingMode;

  constructor(timeline: ExactTimeline, rounding: RoundingMode = "half-even") {
    this.timeline = timeline;
    this.rounding = rounding;
  }

  sourceFrameTimestamp(sourceFrame: bigint | number): number {
    return asNumber(this.sourceFrameTimestampBigInt(sourceFrame), "source timestamp");
  }

  sourceFrameTimestampBigInt(sourceFrame: bigint | number): bigint {
    return this.timeline.timeToMicroseconds(
      this.timeline.sourceFrameTime(sourceFrame),
      this.rounding,
    );
  }

  displayFrameTimestamp(displayFrame: bigint | number): number {
    return asNumber(this.displayFrameTimestampBigInt(displayFrame), "display timestamp");
  }

  displayFrameTimestampBigInt(displayFrame: bigint | number): bigint {
    return this.timeline.timeToMicroseconds(
      this.timeline.displayFrameTime(displayFrame),
      this.rounding,
    );
  }

  sourceFrameDuration(sourceFrame: bigint | number): number {
    const start = this.sourceFrameTimestampBigInt(sourceFrame);
    const end = this.sourceFrameTimestampBigInt(BigInt(sourceFrame) + 1n);
    return asNumber(end - start, "frame duration");
  }

  alignDecodedTimestamp(item: DecodedTimestampLike): TimestampAlignment {
    if (item.timestamp === null || !Number.isSafeInteger(item.timestamp)) {
      throw new TypeError("decoded VideoFrame must have a safe integer microsecond timestamp");
    }
    const timestampUs = BigInt(item.timestamp);
    const exactTime = this.timeline.microsecondsToTime(timestampUs);
    const exactFramePosition = exactTime.mul(this.timeline.sourceFps);
    const sourceFrame = exactFramePosition.round("half-even");
    const exactFrameTime = this.timeline.sourceFrameTime(sourceFrame);
    const residualSeconds = exactTime.sub(exactFrameTime);
    const residualUs = residualSeconds.mul(Rational.of(1_000_000n));
    const halfFrameSeconds = Rational.one()
      .div(this.timeline.sourceFps)
      .div(Rational.of(2n));
    return {
      sourceFrame,
      timestampUs,
      exactFrameTime,
      residualSeconds,
      residualUs,
      aligned: residualSeconds.abs().compare(halfFrameSeconds) <= 0,
    };
  }

  displayFrameForSourceFrame(
    sourceFrame: bigint | number,
    rounding: RoundingMode = this.rounding,
  ): bigint {
    return this.timeline.mapSourceFrameToDisplayFrame(sourceFrame, rounding).displayFrame;
  }
}
