import type { LoudnessMeasurement, PcmBuffer } from './types.ts';

/**
 * EBU R128 style loudness measurement implemented from scratch.
 * K-weighting uses two Direct-Form-I biquads (stage 1 high-shelf +4 dB,
 * stage 2 high-pass). Block energies use mean-square per channel averaged
 * across channels, then converted with the -0.691 dB monophonic offset.
 */

interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number;
  z1: number; z2: number;
}

/** RBJ cookbook biquad coefficients. */
function makeBiquad(
  type: 'highpass' | 'highshelf',
  freq: number,
  sampleRate: number,
  gainDb = 0,
  q = 0.70710678,
): Biquad {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * q);
  let b0 = 0, b1 = 0, b2 = 0, a0 = 0, a1 = 0, a2 = 0;

  if (type === 'highpass') {
    b0 = (1 + cosW) / 2;
    b1 = -(1 + cosW);
    b2 = (1 + cosW) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosW;
    a2 = 1 - alpha;
  } else {
    const a = Math.pow(10, gainDb / 40);
    const sqrtA = Math.sqrt(a);
    b0 = a * ((a + 1) + (a - 1) * cosW + 2 * sqrtA * alpha);
    b1 = -2 * a * ((a - 1) + (a + 1) * cosW);
    b2 = a * ((a + 1) + (a - 1) * cosW - 2 * sqrtA * alpha);
    a0 = (a + 1) - (a - 1) * cosW + 2 * sqrtA * alpha;
    a1 = 2 * ((a - 1) - (a + 1) * cosW);
    a2 = (a + 1) - (a - 1) * cosW - 2 * sqrtA * alpha;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1: 0, z2: 0 };
}

function processBiquad(filter: Biquad, input: Float32Array): Float32Array {
  const out = new Float32Array(input.length);
  let { z1, z2 } = filter;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = filter.b0 * x + z1;
    z1 = filter.b1 * x - filter.a1 * y + z2;
    z2 = filter.b2 * x - filter.a2 * y;
    out[i] = y;
  }
  filter.z1 = z1;
  filter.z2 = z2;
  return out;
}

/** Apply the K-weighting chain to every channel and return new buffers. */
function kWeight(pcm: PcmBuffer): Float32Array[] {
  const { sampleRate, channels } = pcm;
  return channels.map((channel) => {
    const shelf = makeBiquad('highshelf', 1681.97445, sampleRate, 4.0);
    const highpass = makeBiquad('highpass', 38.13547, sampleRate, 0, 0.5);
    const staged = processBiquad(shelf, channel);
    return processBiquad(highpass, staged);
  });
}

/** Mean-square energy across channels for a sample range. */
function blockEnergy(channels: Float32Array[], start: number, end: number): number {
  let sum = 0;
  const length = end - start;
  for (const channel of channels) {
    let acc = 0;
    for (let i = start; i < end; i++) acc += channel[i] * channel[i];
    sum += acc / length;
  }
  return sum / channels.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

/** 4x linear-oversampled true peak in dBTP. */
function truePeak(pcm: PcmBuffer): number {
  let peak = 0;
  for (const channel of pcm.channels) {
    for (let i = 0; i < channel.length - 1; i++) {
      const x0 = channel[i];
      const x1 = channel[i + 1];
      for (let sub = 0; sub < 4; sub++) {
        const t = sub / 4;
        const interpolated = x0 + (x1 - x0) * t;
        const magnitude = Math.abs(interpolated);
        if (magnitude > peak) peak = magnitude;
      }
    }
    const last = Math.abs(channel[channel.length - 1] ?? 0);
    if (last > peak) peak = last;
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

function rmsDbfs(pcm: PcmBuffer): number {
  let sum = 0;
  let samples = 0;
  for (const channel of pcm.channels) {
    for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
    samples += channel.length;
  }
  const mean = samples > 0 ? sum / samples : 0;
  return mean > 0 ? 10 * Math.log10(mean) : -Infinity;
}

const LUFS_OFFSET = 0.691;
const ABSOLUTE_GATE = -70;
const RELATIVE_GATE_DELTA = -10;

/** Full R128 measurement of a PCM buffer. */
export function measureLoudness(pcm: PcmBuffer): LoudnessMeasurement {
  const { sampleRate } = pcm;
  const weighted = kWeight(pcm);
  const totalFrames = weighted[0].length;

  // Momentary 400 ms blocks, 75% overlap -> 100 ms hop.
  const momentaryHop = Math.floor(sampleRate * 0.1);
  const momentarySize = Math.floor(sampleRate * 0.4);
  const momentaryEnergies: number[] = [];
  for (let start = 0; start + momentarySize <= totalFrames; start += momentaryHop) {
    momentaryEnergies.push(blockEnergy(weighted, start, start + momentarySize));
  }

  const toLufs = (energy: number) => (energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity);
  const absolutePass = momentaryEnergies.filter((e) => toLufs(e) > ABSOLUTE_GATE);
  let integrated = -Infinity;
  if (absolutePass.length > 0) {
    const firstMean = absolutePass.reduce((a, b) => a + b, 0) / absolutePass.length;
    const relativeThreshold = toLufs(firstMean) + RELATIVE_GATE_DELTA;
    const gated = absolutePass.filter((e) => toLufs(e) > relativeThreshold);
    const finalMean = (gated.length ? gated : absolutePass).reduce((a, b) => a + b, 0) /
      (gated.length || absolutePass.length);
    integrated = toLufs(finalMean);
  }

  // Short-term 3 s blocks for loudness range (LRA), 100 ms hop.
  const shortSize = Math.floor(sampleRate * 3);
  const shortEnergies: number[] = [];
  for (let start = 0; start + shortSize <= totalFrames; start += momentaryHop) {
    const energy = blockEnergy(weighted, start, start + shortSize);
    if (toLufs(energy) > ABSOLUTE_GATE) shortEnergies.push(energy);
  }
  let lra = 0;
  if (shortEnergies.length >= 2) {
    const sorted = [...shortEnergies].sort((a, b) => a - b);
    const p10 = percentile(sorted, 10);
    const p95 = percentile(sorted, 95);
    lra = toLufs(p95) - toLufs(p10);
  }

  return {
    integratedLufs: Number.isFinite(integrated) ? integrated : -Infinity,
    loudnessRange: Math.max(0, lra),
    truePeakDbfs: truePeak(pcm),
    rmsDbfs: rmsDbfs(pcm),
  };
}

/** Gain in linear amplitude required to move a track to the target loudness. */
export function loudnessAlignGain(measuredLufs: number, targetLufs: number): number {
  if (!Number.isFinite(measuredLufs)) return 1;
  return Math.pow(10, (targetLufs - measuredLufs) / 20);
}
