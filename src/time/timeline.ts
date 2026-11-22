import { Rational, type RoundingMode, rational } from "./rational.ts";

export interface TimelineConfig {
  sourceFps: string | Rational;
  displayFps: string | Rational;
  audioSampleRate: string | Rational;
}

export interface QuantizedPosition {
  exact: Rational;
  integer: bigint;
  residual: Rational;
  residualSeconds: Rational;
}

export interface FrameMapping extends QuantizedPosition {
  sourceFrame: bigint;
  displayFrame: bigint;
}

function rate(value: string | Rational, label: string): Rational {
  const parsed = value instanceof Rational ? value : rational(value);
  if (parsed.compare(Rational.zero()) <= 0) {
    throw new RangeError(`${label} must be positive, got ${parsed.toString()}`);
  }
  return parsed;
}

function frame(value: bigint | number, label: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new RangeError(`${label} cannot be negative`);
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer or bigint`);
  }
  return BigInt(value);
}

function quantize(value: Rational, mode: RoundingMode): QuantizedPosition {
  const integer = value.round(mode);
  return {
    exact: value,
    integer,
    residual: Rational.integer(integer).sub(value),
    residualSeconds: Rational.zero(),
  };
}

/**
 * Exact source, edit, display and audio clocks. A frame or sample is always
 * derived from an absolute rational time. No method accumulates a rounded
 * duration.
 */
export class ExactTimeline {
  readonly sourceFps: Rational;
  readonly displayFps: Rational;
  readonly audioSampleRate: Rational;

  constructor(config: TimelineConfig) {
    this.sourceFps = rate(config.sourceFps, "sourceFps");
    this.displayFps = rate(config.displayFps, "displayFps");
    this.audioSampleRate = rate(config.audioSampleRate, "audioSampleRate");
  }

  sourceFrameTime(sourceFrame: bigint | number): Rational {
    return Rational.integer(frame(sourceFrame, "sourceFrame")).div(this.sourceFps);
  }

  displayFrameTime(displayFrame: bigint | number): Rational {
    return Rational.integer(frame(displayFrame, "displayFrame")).div(this.displayFps);
  }

  audioSampleTime(samplePosition: bigint | number): Rational {
    return Rational.integer(frame(samplePosition, "audio sample position")).div(
      this.audioSampleRate,
    );
  }

  timeToDisplayFrame(time: Rational, mode: RoundingMode = "half-even"): QuantizedPosition {
    const position = quantize(time.mul(this.displayFps), mode);
    return {
      ...position,
      residualSeconds: position.residual.div(this.displayFps),
    };
  }

  timeToAudioSample(time: Rational, mode: RoundingMode = "half-even"): QuantizedPosition {
    const position = quantize(time.mul(this.audioSampleRate), mode);
    return {
      ...position,
      residualSeconds: position.residual.div(this.audioSampleRate),
    };
  }

  timeToMicroseconds(time: Rational, mode: RoundingMode = "half-even"): bigint {
    return time.mul(Rational.of(1_000_000n)).round(mode);
  }

  microsecondsToTime(microseconds: bigint | number): Rational {
    return Rational.parse(microseconds).div(Rational.of(1_000_000n));
  }

  mapSourceFrameToDisplayFrame(
    sourceFrame: bigint | number,
    mode: RoundingMode = "half-even",
  ): FrameMapping {
    const source = frame(sourceFrame, "sourceFrame");
    const time = this.sourceFrameTime(source);
    const target = this.timeToDisplayFrame(time, mode);
    const displayFrame = target.integer;
    return {
      sourceFrame: source,
      displayFrame,
      exact: target.exact,
      integer: displayFrame,
      residual: target.residual,
      residualSeconds: target.residualSeconds,
    };
  }

  mapDisplayFrameToSourceFrame(
    displayFrame: bigint | number,
    mode: RoundingMode = "floor",
  ): bigint {
    const time = this.displayFrameTime(displayFrame);
    return timeToFrameAtRate(time, this.sourceFps, mode);
  }

  durationInDisplayFrames(duration: Rational, mode: RoundingMode = "half-even"): bigint {
    return duration.mul(this.displayFps).round(mode);
  }

  durationInAudioSamples(duration: Rational, mode: RoundingMode = "half-even"): bigint {
    return duration.mul(this.audioSampleRate).round(mode);
  }
}

function timeToFrameAtRate(
  time: Rational,
  framesPerSecond: Rational,
  mode: RoundingMode,
): bigint {
  return time.mul(framesPerSecond).round(mode);
}

export function createTimeline(config: TimelineConfig): ExactTimeline {
  return new ExactTimeline(config);
}

export function microsecondsToRational(microseconds: bigint | number): Rational {
  return Rational.parse(microseconds).div(Rational.of(1_000_000n));
}

export function rationalToMicroseconds(
  seconds: Rational,
  mode: RoundingMode = "half-even",
): bigint {
  return seconds.mul(Rational.of(1_000_000n)).round(mode);
}
