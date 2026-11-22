import type { Fraction } from "./fraction.ts";
import { ZERO, add, fraction } from "./fraction.ts";
import { PcmSource, mapChannels } from "./pcm-source.ts";

export interface RenderedBlock {
  readonly start: Fraction;
  readonly end: Fraction;
  readonly channels: readonly Float32Array[];
}

export class SourceRenderer {
  readonly source: PcmSource;
  readonly outputRate: number;
  readonly outputChannelCount: number;
  position: Fraction;

  constructor(
    source: PcmSource,
    outputRate: number,
    outputChannelCount: number,
    startPosition: Fraction = ZERO,
  ) {
    if (!Number.isInteger(outputRate) || outputRate <= 0) {
      throw new RangeError("outputRate must be a positive integer");
    }
    if (!Number.isInteger(outputChannelCount) || outputChannelCount <= 0) {
      throw new RangeError("outputChannelCount must be a positive integer");
    }
    this.source = source;
    this.outputRate = outputRate;
    this.outputChannelCount = outputChannelCount;
    this.position = startPosition;
  }

  get step(): Fraction {
    return fraction(this.source.sampleRate, this.outputRate);
  }

  render(frameCount: number): RenderedBlock {
    if (!Number.isInteger(frameCount) || frameCount < 0) {
      throw new RangeError("frameCount must be a non-negative integer");
    }
    const start = this.position;
    const channels = Array.from(
      { length: this.outputChannelCount },
      () => new Float32Array(frameCount),
    );
    const sourceSamples = new Array<number>(this.source.channelCount).fill(0);
    const step = this.step;

    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < this.source.channelCount; channel += 1) {
        sourceSamples[channel] = this.source.sampleAtFraction(this.position, channel);
      }
      const mapped = mapChannels(sourceSamples, this.outputChannelCount);
      for (let channel = 0; channel < this.outputChannelCount; channel += 1) {
        channels[channel][frame] = mapped[channel];
      }
      this.position = add(this.position, step);
    }

    return { start, end: this.position, channels };
  }
}
