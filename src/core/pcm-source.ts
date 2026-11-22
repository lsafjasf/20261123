import type { Fraction } from "./fraction.ts";
import { floorFraction, toNumber } from "./fraction.ts";
import type { PcmChunk } from "./types.ts";

interface IndexedChunk extends PcmChunk {
  readonly endFrame: number;
}

function assertChunk(chunk: PcmChunk): void {
  if (!Number.isInteger(chunk.startFrame) || chunk.startFrame < 0) {
    throw new RangeError("chunk.startFrame must be a non-negative integer");
  }
  if (!Number.isInteger(chunk.frameCount) || chunk.frameCount <= 0) {
    throw new RangeError("chunk.frameCount must be a positive integer");
  }
  if (!Number.isInteger(chunk.sampleRate) || chunk.sampleRate <= 0) {
    throw new RangeError("chunk.sampleRate must be a positive integer");
  }
  if (!Number.isInteger(chunk.channelCount) || chunk.channelCount <= 0) {
    throw new RangeError("chunk.channelCount must be a positive integer");
  }
  if (chunk.channels.length < chunk.channelCount) {
    throw new RangeError("chunk does not contain all declared channels");
  }
  for (const channel of chunk.channels) {
    if (channel.length < chunk.frameCount) {
      throw new RangeError("channel has fewer frames than chunk.frameCount");
    }
  }
}

export class PcmSource {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly startFrame: number;
  readonly endFrame: number;
  private readonly chunks: IndexedChunk[];

  constructor(chunks: readonly PcmChunk[]) {
    if (chunks.length === 0) {
      throw new RangeError("PcmSource requires at least one chunk");
    }
    const sampleRate = chunks[0].sampleRate;
    const channelCount = chunks[0].channelCount;
    const indexed: IndexedChunk[] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      assertChunk(chunk);
      if (chunk.sampleRate !== sampleRate || chunk.channelCount !== channelCount) {
        throw new RangeError("all chunks must use the same source format");
      }
      if (index > 0) {
        const previous = indexed[index - 1];
        if (chunk.startFrame !== previous.endFrame) {
          throw new RangeError("source chunks must form one contiguous timeline");
        }
      }
      indexed.push({ ...chunk, endFrame: chunk.startFrame + chunk.frameCount });
    }

    this.sampleRate = sampleRate;
    this.channelCount = channelCount;
    this.startFrame = indexed[0].startFrame;
    this.endFrame = indexed[indexed.length - 1].endFrame;
    this.chunks = indexed;
  }

  get durationFrames(): number {
    return this.endFrame - this.startFrame;
  }

  getChunks(): readonly PcmChunk[] {
    return this.chunks;
  }

  sampleAt(position: number, channel: number): number {
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const lowerSample = this.frameSample(lower, channel);
    if (upper === lower) {
      return lowerSample;
    }
    const upperSample = this.frameSample(upper, channel);
    return lowerSample + (upperSample - lowerSample) * (position - lower);
  }

  sampleAtFraction(position: Fraction, channel: number): number {
    return this.sampleAt(toNumber(position), channel);
  }

  frameSample(frame: number, channel: number): number {
    if (
      !Number.isInteger(frame) ||
      frame < this.startFrame ||
      frame >= this.endFrame ||
      channel < 0 ||
      channel >= this.channelCount
    ) {
      return 0;
    }
    const chunk = this.findChunk(frame);
    if (chunk === null) {
      return 0;
    }
    const channelData = chunk.channels[channel];
    return channelData[frame - chunk.startFrame] ?? 0;
  }

  frameAt(position: Fraction): number {
    return floorFraction(position);
  }

  private findChunk(frame: number): IndexedChunk | null {
    let low = 0;
    let high = this.chunks.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const chunk = this.chunks[middle];
      if (frame < chunk.startFrame) {
        high = middle - 1;
      } else if (frame >= chunk.endFrame) {
        low = middle + 1;
      } else {
        return chunk;
      }
    }
    return null;
  }
}

export function mapChannels(
  source: readonly number[],
  targetChannelCount: number,
): number[] {
  const output = new Array<number>(targetChannelCount).fill(0);
  if (targetChannelCount <= 0) {
    return output;
  }
  if (source.length === 0) {
    return output;
  }
  if (source.length === 1) {
    return output.fill(source[0]);
  }
  if (targetChannelCount === 1) {
    const sum = source.reduce((total, sample) => total + sample, 0);
    output[0] = sum / source.length;
    return output;
  }
  const copied = Math.min(source.length, targetChannelCount);
  for (let channel = 0; channel < copied; channel += 1) {
    output[channel] = source[channel];
  }
  return output;
}
