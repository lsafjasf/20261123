import type { AudioFeatures, PitchFrame } from "../shared/types.ts";
import { clamp, dbFromRms, fftReal, hannWindow, median } from "./dsp.ts";

export const ANALYSIS_RATE = 8000;
export const FRAME_SIZE = 1024;
export const HOP_SIZE = 400;
export const HOP_SEC = HOP_SIZE / ANALYSIS_RATE;
const MIN_HZ = 65;
const MAX_HZ = 1000;

interface PitchEstimate {
  hz: number;
  confidence: number;
}

function interpolateMagnitude(
  magnitudes: Float64Array,
  position: number,
): number {
  const index = Math.floor(position);
  if (index < 0 || index + 1 >= magnitudes.length) return 0;
  const fraction = position - index;
  return (
    magnitudes[index] * (1 - fraction) + magnitudes[index + 1] * fraction
  );
}

export function estimatePitch(
  magnitudes: Float64Array,
  binHz: number,
): PitchEstimate {
  const highestBin = Math.min(
    magnitudes.length - 2,
    Math.floor(MAX_HZ / binHz),
  );
  const lowestBin = Math.max(2, Math.ceil(MIN_HZ / binHz));
  const scores = new Float64Array(highestBin - lowestBin + 1);
  let bestBin = lowestBin;
  let bestScore = 0;

  for (let candidate = lowestBin; candidate <= highestBin; candidate++) {
    const maxHarmonic = Math.min(8, Math.floor(highestBin / candidate));
    let weighted = 0;
    let weights = 0;
    for (let harmonic = 1; harmonic <= maxHarmonic; harmonic++) {
      const position = candidate * harmonic;
      const weight = harmonic === 1 ? 1.65 : 1 / Math.sqrt(harmonic);
      weighted += Math.sqrt(interpolateMagnitude(magnitudes, position)) * weight;
      weights += weight;
    }
    const score = weighted / weights;
    scores[candidate - lowestBin] = score;
    if (score > bestScore) {
      bestScore = score;
      bestBin = candidate;
    }
  }

  let average = 0;
  for (const score of scores) average += score;
  average /= Math.max(1, scores.length);
  const contrast = bestScore / Math.max(average, 1e-9);
  const confidence = clamp((contrast - 1.15) / 2.2, 0, 1);
  return { hz: bestBin * binHz, confidence };
}

function spectralFlatness(magnitudes: Float64Array, binHz: number): number {
  const start = Math.max(1, Math.floor(120 / binHz));
  const end = Math.min(magnitudes.length - 1, Math.floor(3400 / binHz));
  let logSum = 0;
  let sum = 0;
  let count = 0;
  for (let i = start; i <= end; i++) {
    const value = magnitudes[i] + 1e-12;
    logSum += Math.log(value);
    sum += value;
    count++;
  }
  if (!count || sum <= 0) return 1;
  return clamp(Math.exp(logSum / count) / (sum / count), 0, 1);
}

function readFrame(
  samples: Float32Array,
  sourceRate: number,
  startSec: number,
  target: Float64Array,
): number {
  let energy = 0;
  const step = sourceRate / ANALYSIS_RATE;
  const sourceStart = startSec * sourceRate;
  for (let i = 0; i < FRAME_SIZE; i++) {
    const sourcePosition = sourceStart + i * step;
    const left = Math.floor(sourcePosition);
    const fraction = sourcePosition - left;
    const value =
      left + 1 < samples.length
        ? samples[left] * (1 - fraction) + samples[left + 1] * fraction
        : 0;
    target[i] = value;
    energy += value * value;
  }
  return Math.sqrt(energy / FRAME_SIZE);
}

function smoothPitch(frames: PitchFrame[]): void {
  const copy = frames.map((frame) => frame.midi);
  for (let i = 1; i < frames.length - 1; i++) {
    if (!frames[i].voiced) continue;
    const near = [copy[i - 1], copy[i], copy[i + 1]].filter(
      (value): value is number => value !== null,
    );
    if (near.length >= 2) frames[i].midi = median(near);
  }
  for (let i = 1; i < frames.length; i++) {
    const current = frames[i].midi;
    const previous = frames[i - 1].midi;
    if (current === null || previous === null) continue;
    if (Math.abs(current - previous) > 8) {
      const folded = current - Math.round((current - previous) / 12) * 12;
      if (Math.abs(folded - previous) < Math.abs(current - previous)) {
        frames[i].midi = folded;
      }
    }
  }
}

export interface AnalyzeFeatureOptions {
  onProgress?: (value: number) => void;
}

export function analyzeMonoFeatures(
  samples: Float32Array,
  sourceRate: number,
  durationSec: number,
  options: AnalyzeFeatureOptions = {},
): AudioFeatures {
  const frameCount = Math.max(
    1,
    Math.floor((Math.max(0, durationSec - FRAME_SIZE / ANALYSIS_RATE)) / HOP_SEC) +
      1,
  );
  const frames: PitchFrame[] = [];
  const frame = new Float64Array(FRAME_SIZE);
  const real = new Float64Array(FRAME_SIZE);
  const imag = new Float64Array(FRAME_SIZE);
  const magnitude = new Float64Array(FRAME_SIZE / 2);
  const window = hannWindow(FRAME_SIZE);
  const binHz = ANALYSIS_RATE / FRAME_SIZE;

  for (let index = 0; index < frameCount; index++) {
    const time = index * HOP_SEC;
    const rms = readFrame(samples, sourceRate, time, frame);
    let mean = 0;
    for (const sample of frame) mean += sample;
    mean /= FRAME_SIZE;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const value = (frame[i] - mean) * window[i];
      real[i] = value;
      imag[i] = 0;
    }
    fftReal(real, imag);
    for (let i = 0; i < magnitude.length; i++) {
      magnitude[i] = Math.hypot(real[i], imag[i]);
    }
    const flatness = spectralFlatness(magnitude, binHz);
    const rmsDb = dbFromRms(rms);
    const pitch =
      rmsDb > -58 && flatness < 0.62
        ? estimatePitch(magnitude, binHz)
        : { hz: 0, confidence: 0 };
    const voiced =
      rmsDb > -46 &&
      flatness < 0.48 &&
      pitch.confidence > 0.22 &&
      pitch.hz >= MIN_HZ;
    frames.push({
      time,
      midi: pitch.hz > 0 ? 69 + 12 * Math.log2(pitch.hz / 440) : null,
      confidence: pitch.confidence,
      rms,
      flatness,
      voiced,
    });
    if (index % 160 === 0) {
      options.onProgress?.((index + 1) / frameCount);
    }
  }
  smoothPitch(frames);

  const midi = new Float32Array(frameCount);
  const confidence = new Float32Array(frameCount);
  const rms = new Float32Array(frameCount);
  const flatness = new Float32Array(frameCount);
  const voiced = new Uint8Array(frameCount);
  let voicedFrames = 0;
  let silentFrames = 0;
  let noisyFrames = 0;
  for (let i = 0; i < frameCount; i++) {
    const item = frames[i];
    midi[i] = item.midi ?? Number.NaN;
    confidence[i] = item.confidence;
    rms[i] = item.rms;
    flatness[i] = item.flatness;
    voiced[i] = item.voiced ? 1 : 0;
    if (item.voiced) voicedFrames++;
    else if (item.rms < 0.006) silentFrames++;
    else noisyFrames++;
  }
  return {
    durationSec,
    sampleRate: ANALYSIS_RATE,
    hopSec: HOP_SEC,
    frameCount,
    midi,
    confidence,
    rms,
    flatness,
    voiced,
    stats: {
      voicedSec: voicedFrames * HOP_SEC,
      silentSec: silentFrames * HOP_SEC,
      noisySec: noisyFrames * HOP_SEC,
      rejectedRegions: 0,
    },
  };
}

export function frameRange(
  features: AudioFeatures,
  startSec: number,
  endSec: number,
): [number, number] {
  return [
    clamp(Math.floor(startSec / features.hopSec), 0, features.frameCount),
    clamp(Math.ceil(endSec / features.hopSec), 0, features.frameCount),
  ];
}
