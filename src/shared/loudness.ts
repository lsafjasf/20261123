import type { BlockMetric } from './types.ts';

export const SILENCE_LUFS = -70;
export const LUFS_OFFSET = -0.691;

export function energyToLufs(energy: number): number {
  if (!(energy > 0)) return Number.NEGATIVE_INFINITY;
  const loudness = LUFS_OFFSET + 10 * Math.log10(energy);
  return loudness < -120 ? Number.NEGATIVE_INFINITY : loudness;
}

export function amplitudeToDb(value: number): number {
  return value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY;
}

interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function kWeightingCoefficients(sampleRate: number): [BiquadCoefficients, BiquadCoefficients] {
  const shelfFrequency = 1681.974450955533;
  const shelfGain = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  const shelfK = Math.tan(Math.PI * shelfFrequency / sampleRate);
  const vh = Math.pow(10, shelfGain / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const shelfA0 = 1 + shelfK / shelfQ + shelfK * shelfK;
  const shelf: BiquadCoefficients = {
    b0: (vh + vb * shelfK / shelfQ + shelfK * shelfK) / shelfA0,
    b1: 2 * (shelfK * shelfK - vh) / shelfA0,
    b2: (vh - vb * shelfK / shelfQ + shelfK * shelfK) / shelfA0,
    a1: 2 * (shelfK * shelfK - 1) / shelfA0,
    a2: (1 - shelfK / shelfQ + shelfK * shelfK) / shelfA0
  };

  const highPassFrequency = 38.13547087602444;
  const highPassQ = 0.5003270373238773;
  const highPassK = Math.tan(Math.PI * highPassFrequency / sampleRate);
  const highPassA0 = 1 + highPassK / highPassQ + highPassK * highPassK;
  const highPass: BiquadCoefficients = {
    b0: 1 / highPassA0,
    b1: -2 / highPassA0,
    b2: 1 / highPassA0,
    a1: 2 * (highPassK * highPassK - 1) / highPassA0,
    a2: (1 - highPassK / highPassQ + highPassK * highPassK) / highPassA0
  };
  return [shelf, highPass];
}

class Biquad {
  private readonly coefficients: BiquadCoefficients;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(coefficients: BiquadCoefficients) {
    this.coefficients = coefficients;
  }

  process(input: number): number {
    const c = this.coefficients;
    const output = c.b0 * input + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = input;
    this.y2 = this.y1;
    this.y1 = output;
    return output;
  }
}

class KWeightingChannel {
  private readonly shelf: Biquad;
  private readonly highPass: Biquad;

  constructor(sampleRate: number) {
    const [shelf, highPass] = kWeightingCoefficients(sampleRate);
    this.shelf = new Biquad(shelf);
    this.highPass = new Biquad(highPass);
  }

  process(sample: number): number {
    return this.highPass.process(this.shelf.process(sample));
  }
}

const TRUE_PEAK_TAPS = 16;
const TRUE_PEAK_PHASES = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];
const TRUE_PEAK_CENTER = (TRUE_PEAK_TAPS - 1) / 2;

function makeFractionalCoefficients(phase: number): Float64Array {
  const coefficients = new Float64Array(TRUE_PEAK_TAPS);
  let sum = 0;
  for (let index = 0; index < TRUE_PEAK_TAPS; index += 1) {
    const distance = TRUE_PEAK_CENTER - index - phase;
    const sinc = Math.abs(distance) < 1e-12 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance);
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * (index + 0.5) / TRUE_PEAK_TAPS);
    coefficients[index] = sinc * window;
    sum += coefficients[index];
  }
  if (Math.abs(sum) > 1e-12) {
    for (let index = 0; index < coefficients.length; index += 1) {
      coefficients[index] /= sum;
    }
  }
  return coefficients;
}

const TRUE_PEAK_COEFFICIENTS = TRUE_PEAK_PHASES.map(makeFractionalCoefficients);

class TruePeakChannel {
  private readonly history = new Float64Array(TRUE_PEAK_TAPS);
  private head = 0;

  process(sample: number): number {
    this.history[this.head] = sample;
    this.head = (this.head + 1) % TRUE_PEAK_TAPS;
    let peak = Math.abs(sample);
    for (const coefficients of TRUE_PEAK_COEFFICIENTS) {
      let interpolated = 0;
      let cursor = this.head - 1;
      for (let tap = 0; tap < TRUE_PEAK_TAPS; tap += 1) {
        if (cursor < 0) cursor += TRUE_PEAK_TAPS;
        interpolated += this.history[cursor] * coefficients[tap];
        cursor -= 1;
      }
      const magnitude = Math.abs(interpolated);
      if (magnitude > peak) peak = magnitude;
    }
    return peak;
  }
}

export class LoudnessMeter {
  readonly hopFrames: number;
  private readonly channelCount: number;
  private readonly kWeighting: KWeightingChannel[];
  private readonly truePeak: TruePeakChannel[];
  private readonly hopEnergies: number[] = [];
  private readonly histogramCounts = new Uint32Array(801);
  private readonly histogramEnergy = new Float64Array(801);
  private hopIndex = 0;
  private currentFrames = 0;
  private currentEnergy = 0;
  private currentSamplePeak = 0;
  private currentTruePeak = 0;
  private processedFrames = 0;
  private samplePeak = 0;
  private truePeakValue = 0;
  private integrated = Number.NEGATIVE_INFINITY;
  private gatedBlocks = 0;
  readonly blocks: BlockMetric[] = [];

  constructor(sampleRate: number, channelCount: number) {
    this.channelCount = channelCount;
    this.hopFrames = Math.max(1, Math.round(sampleRate * 0.1));
    this.kWeighting = Array.from({ length: channelCount }, () => new KWeightingChannel(sampleRate));
    this.truePeak = Array.from({ length: channelCount }, () => new TruePeakChannel());
  }

  push(channels: Float32Array[], frameCount: number): void {
    for (let frame = 0; frame < frameCount; frame += 1) {
      let energy = 0;
      let truePeak = 0;
      for (let channel = 0; channel < this.channelCount; channel += 1) {
        const sample = channels[channel][frame] || 0;
        const magnitude = Math.abs(sample);
        if (magnitude > this.currentSamplePeak) this.currentSamplePeak = magnitude;
        if (magnitude > this.samplePeak) this.samplePeak = magnitude;
        const weighted = this.kWeighting[channel].process(sample);
        energy += weighted * weighted;
        const interpolated = this.truePeak[channel].process(sample);
        if (interpolated > truePeak) truePeak = interpolated;
      }
      if (truePeak > this.currentTruePeak) this.currentTruePeak = truePeak;
      if (truePeak > this.truePeakValue) this.truePeakValue = truePeak;
      this.currentEnergy += energy;
      this.currentFrames += 1;
      if (this.currentFrames >= this.hopFrames) this.commitHop();
    }
  }

  finish(): void {
    if (this.currentFrames > 0) this.commitHop();
    const tailFrames = TRUE_PEAK_TAPS + 1;
    for (let frame = 0; frame < tailFrames; frame += 1) {
      for (const meter of this.truePeak) {
        const value = meter.process(0);
        if (value > this.truePeakValue) this.truePeakValue = value;
      }
    }
  }

  get samplePeakLinear(): number {
    return this.samplePeak;
  }

  get truePeakLinear(): number {
    return this.truePeakValue;
  }

  get integratedLufs(): number {
    return this.integrated;
  }

  get integratedBlockCount(): number {
    return this.gatedBlocks;
  }

  private commitHop(): void {
    const frames = this.currentFrames;
    if (frames === 0) return;
    const hopEnergy = this.currentEnergy / frames;
    this.hopEnergies.push(hopEnergy);
    if (this.hopEnergies.length > 30) this.hopEnergies.shift();
    this.hopIndex += 1;

    const end = (this.processedFrames + frames) / this.hopFrames * 0.1;
    this.processedFrames += frames;
    const momentaryHops = Math.min(this.hopIndex, 4);
    const shortTermHops = Math.min(this.hopIndex, 30);
    let momentarySum = 0;
    for (let index = this.hopEnergies.length - 1; index >= Math.max(0, this.hopEnergies.length - 4); index -= 1) {
      momentarySum += this.hopEnergies[index];
    }
    let shortTermSum = 0;
    for (const energy of this.hopEnergies) shortTermSum += energy;
    const momentaryEnergy = momentaryHops >= 4 ? momentarySum / 4 : Number.NaN;
    const shortTermEnergy = shortTermHops >= 30 ? shortTermSum / 30 : Number.NaN;
    const momentary = energyToLufs(momentaryEnergy);
    const shortTerm = energyToLufs(shortTermEnergy);

    let blockEnergy = 0;
    if (momentaryHops >= 4) {
      blockEnergy = momentaryEnergy;
      this.addToHistogram(blockEnergy);
      this.integrated = this.gateHistogram();
    }
    this.blocks.push({
      start: Math.max(0, end - 0.4),
      end,
      momentary,
      shortTerm,
      integrated: this.integrated,
      energy: blockEnergy,
      samplePeak: this.currentSamplePeak,
      truePeak: this.currentTruePeak
    });

    this.currentFrames = 0;
    this.currentEnergy = 0;
    this.currentSamplePeak = 0;
    this.currentTruePeak = 0;
  }

  private addToHistogram(energy: number): void {
    const loudness = energyToLufs(energy);
    if (!Number.isFinite(loudness) || loudness <= SILENCE_LUFS) return;
    const index = Math.max(0, Math.min(800, Math.round((loudness - SILENCE_LUFS) * 10)));
    this.histogramCounts[index] += 1;
    this.histogramEnergy[index] += energy;
  }

  private gateHistogram(): number {
    let absoluteCount = 0;
    let absoluteEnergy = 0;
    for (let index = 0; index < this.histogramCounts.length; index += 1) {
      const count = this.histogramCounts[index];
      if (count === 0) continue;
      absoluteCount += count;
      absoluteEnergy += this.histogramEnergy[index];
    }
    if (absoluteCount === 0) return Number.NEGATIVE_INFINITY;
    const relativeGate = energyToLufs(absoluteEnergy / absoluteCount) - 10;
    let gatedCount = 0;
    let gatedEnergy = 0;
    for (let index = 0; index < this.histogramCounts.length; index += 1) {
      const loudness = index / 10 + SILENCE_LUFS;
      if (loudness <= relativeGate) continue;
      gatedCount += this.histogramCounts[index];
      gatedEnergy += this.histogramEnergy[index];
    }
    this.gatedBlocks = gatedCount;
    return gatedEnergy > 0 ? energyToLufs(gatedEnergy / gatedCount) : Number.NEGATIVE_INFINITY;
  }
}

export function integratedFromBlocks(blocks: BlockMetric[]): { loudness: number; gatedBlocks: number } {
  const absolute: number[] = [];
  for (const block of blocks) {
    if (!(block.energy > 0)) continue;
    const loudness = energyToLufs(block.energy);
    if (loudness > SILENCE_LUFS) absolute.push(block.energy);
  }
  if (absolute.length === 0) return { loudness: Number.NEGATIVE_INFINITY, gatedBlocks: 0 };
  const absoluteMean = absolute.reduce((sum, value) => sum + value, 0) / absolute.length;
  const relativeGate = energyToLufs(absoluteMean) - 10;
  const gated = absolute.filter((energy) => energyToLufs(energy) > relativeGate);
  if (gated.length === 0) return { loudness: Number.NEGATIVE_INFINITY, gatedBlocks: 0 };
  return {
    loudness: energyToLufs(gated.reduce((sum, value) => sum + value, 0) / gated.length),
    gatedBlocks: gated.length
  };
}
