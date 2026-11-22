import { Rational } from "../time/rational.ts";
import { ExactTimeline } from "../time/timeline.ts";

export interface AudioBufferCue {
  id: string;
  buffer: AudioBuffer;
  startSample: bigint;
  bufferOffsetSample?: bigint;
  sampleCount?: bigint;
}

export interface ScheduledAudioCue {
  id: string;
  startSample: bigint;
  sampleCount: bigint;
  exactContextTime: Rational;
  platformContextTime: number;
  platformOffsetSeconds: number;
  platformDurationSeconds: number;
}

type AudioContextLike = Pick<BaseAudioContext, "currentTime" | "destination" | "createBufferSource">;

function decimalRational(value: number): Rational {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`audio context time must be finite and non-negative, got ${value}`);
  }
  return Rational.fromDecimal(value.toString());
}

/**
 * WebAudio scheduling is driven by absolute output sample indices. Only the
 * final `start(when, offset, duration)` call converts a rational time to a
 * number; no rounded buffer duration is accumulated from cue to cue.
 */
export class ExactAudioScheduler {
  readonly context: AudioContextLike;
  readonly timeline: ExactTimeline;
  readonly anchorContextTime: Rational;
  readonly anchorSample: bigint;
  readonly scheduled: ScheduledAudioCue[] = [];

  constructor(
    context: AudioContextLike,
    timeline: ExactTimeline,
    anchorSample: bigint | number = 0n,
  ) {
    this.context = context;
    this.timeline = timeline;
    this.anchorContextTime = decimalRational(context.currentTime);
    this.anchorSample = BigInt(anchorSample);
  }

  contextTimeForSample(sample: bigint | number): Rational {
    const target = BigInt(sample);
    const delta = target - this.anchorSample;
    return this.anchorContextTime.add(
      Rational.integer(delta).div(this.timeline.audioSampleRate),
    );
  }

  scheduleBuffer(cue: AudioBufferCue): ScheduledAudioCue {
    if (cue.startSample < 0n) throw new RangeError(`${cue.id} starts before sample zero`);
    const bufferRate = decimalRational(cue.buffer.sampleRate);
    if (bufferRate.compare(this.timeline.audioSampleRate) !== 0) {
      throw new RangeError(
        `${cue.id} buffer rate ${bufferRate.toString()} does not match timeline ` +
          this.timeline.audioSampleRate.toString(),
      );
    }
    const bufferOffset = cue.bufferOffsetSample ?? 0n;
    const sampleCount = cue.sampleCount ?? BigInt(cue.buffer.length) - bufferOffset;
    if (bufferOffset < 0n || sampleCount <= 0n) {
      throw new RangeError(`${cue.id} has an invalid buffer offset or sample count`);
    }
    if (bufferOffset + sampleCount > BigInt(cue.buffer.length)) {
      throw new RangeError(`${cue.id} exceeds its AudioBuffer length`);
    }

    const exactContextTime = this.contextTimeForSample(cue.startSample);
    const offset = Rational.integer(bufferOffset).div(this.timeline.audioSampleRate);
    const duration = Rational.integer(sampleCount).div(this.timeline.audioSampleRate);
    const source = this.context.createBufferSource();
    source.buffer = cue.buffer;
    source.connect(this.context.destination);
    source.start(
      exactContextTime.toPlatformNumber(),
      offset.toPlatformNumber(),
      duration.toPlatformNumber(),
    );

    const scheduled: ScheduledAudioCue = {
      id: cue.id,
      startSample: cue.startSample,
      sampleCount,
      exactContextTime,
      platformContextTime: exactContextTime.toPlatformNumber(),
      platformOffsetSeconds: offset.toPlatformNumber(),
      platformDurationSeconds: duration.toPlatformNumber(),
    };
    this.scheduled.push(scheduled);
    return scheduled;
  }
}
