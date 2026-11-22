import type { ConcealmentOptions } from "./types.ts";

export const DEFAULT_OPTIONS: ConcealmentOptions = {
  maxConcealMs: 120,
  edgeBlendMs: 8,
  pauseRms: 0.008,
  activeRms: 0.018,
  boundaryCorrelation: 0.42,
  minPeriodHz: 70,
  maxPeriodHz: 420,
  analysisMs: 24,
  silentChannelDb: -45
};

export function resolveOptions(
  overrides: Partial<ConcealmentOptions> = {}
): ConcealmentOptions {
  return { ...DEFAULT_OPTIONS, ...overrides };
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function rms(channels: readonly Float32Array[], start = 0, length?: number): number {
  let energy = 0;
  let count = 0;
  for (const channel of channels) {
    const end = Math.min(channel.length, start + (length ?? channel.length - start));
    for (let index = Math.max(0, start); index < end; index += 1) {
      const sample = channel[index];
      energy += sample * sample;
      count += 1;
    }
  }
  return count > 0 ? Math.sqrt(energy / count) : 0;
}

export function channelRms(channel: Float32Array): number {
  return rms([channel]);
}

export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  const length = Math.min(...channels.map((channel) => channel.length));
  const output = new Float32Array(Math.max(0, length));
  for (let index = 0; index < output.length; index += 1) {
    let sample = 0;
    for (const channel of channels) sample += channel[index];
    output[index] = sample / channels.length;
  }
  return output;
}

export function tail(samples: Float32Array, count: number): Float32Array {
  return samples.slice(Math.max(0, samples.length - count));
}

export function head(samples: Float32Array, count: number): Float32Array {
  return samples.slice(0, Math.min(count, samples.length));
}

export function resampleLinear(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number
): Float32Array {
  if (sourceRate === targetRate || samples.length === 0) return samples.slice();
  const ratio = targetRate / sourceRate;
  const length = Math.max(1, Math.round(samples.length * ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index / ratio;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
}

export function resampleChannels(
  channels: readonly Float32Array[],
  sourceRate: number,
  targetRate: number
): Float32Array[] {
  return channels.map((channel) => resampleLinear(channel, sourceRate, targetRate));
}

export function fitChannels(channels: readonly Float32Array[], count: number): Float32Array[] {
  if (channels.length === 0) {
    return Array.from({ length: count }, () => new Float32Array(0));
  }
  const output: Float32Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const source = channels[Math.min(index, channels.length - 1)];
    output.push(source.slice());
  }
  return output;
}

export function zeroCrossingRate(samples: Float32Array): number {
  if (samples.length < 2) return 0;
  let crossings = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if ((samples[index - 1] < 0 && samples[index] >= 0) ||
        (samples[index - 1] >= 0 && samples[index] < 0)) {
      crossings += 1;
    }
  }
  return crossings / (samples.length - 1);
}

export function estimatePeriod(
  samples: Float32Array,
  sampleRate: number,
  minPeriodHz: number,
  maxPeriodHz: number
): number {
  if (samples.length < 8) return 0;
  const minLag = Math.max(2, Math.floor(sampleRate / maxPeriodHz));
  const maxLag = Math.min(
    Math.floor(sampleRate / minPeriodHz),
    Math.floor(samples.length / 2)
  );
  if (maxLag <= minLag) return 0;

  let bestLag = 0;
  let bestScore = 0;
  const analyzed = samples.subarray(0, Math.min(samples.length, 2048));
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let numerator = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = 0; index + lag < analyzed.length; index += 1) {
      const left = analyzed[index];
      const right = analyzed[index + lag];
      numerator += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const denominator = Math.sqrt(leftEnergy * rightEnergy);
    const score = denominator > 1e-12 ? numerator / denominator : 0;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return bestScore >= 0.18 ? bestLag : 0;
}

function normalizedCorrelation(a: Float32Array, b: Float32Array, lag: number): number {
  const count = Math.min(a.length, b.length - lag);
  if (count < 8) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let index = 0; index < count; index += 1) {
    meanA += a[index];
    meanB += b[index + lag];
  }
  meanA /= count;
  meanB /= count;
  let numerator = 0;
  let energyA = 0;
  let energyB = 0;
  for (let index = 0; index < count; index += 1) {
    const left = a[index] - meanA;
    const right = b[index + lag] - meanB;
    numerator += left * right;
    energyA += left * left;
    energyB += right * right;
  }
  const denominator = Math.sqrt(energyA * energyB);
  return denominator > 1e-12 ? numerator / denominator : 0;
}

export function bestCorrelation(
  previous: Float32Array,
  next: Float32Array,
  maxLag: number
): number {
  const limit = Math.min(maxLag, Math.max(0, next.length - 8));
  let best = normalizedCorrelation(previous, next, 0);
  for (let lag = 1; lag <= limit; lag += 1) {
    best = Math.max(best, normalizedCorrelation(previous, next, lag));
  }
  return best;
}

export function levelDeltaDb(previous: number, next: number): number {
  const floor = 1e-7;
  return 20 * Math.log10(Math.max(floor, next) / Math.max(floor, previous));
}

export function interleave(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  const frames = Math.min(...channels.map((channel) => channel.length));
  const output = new Float32Array(frames * channels.length);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels.length; channel += 1) {
      output[frame * channels.length + channel] = channels[channel][frame];
    }
  }
  return output;
}

export function updateRms(previous: number, sample: number, count: number): number {
  return Math.sqrt((previous * previous * count + sample * sample) / (count + 1));
}
