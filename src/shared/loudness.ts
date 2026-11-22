import {
  applyBiquadCascade,
  highShelfCoeffs,
  highpassCoeffs,
  powerToDb,
} from './dsp-math.ts';
import { mixToMono } from './signal-processing.ts';
import type { AudioBufferData, LoudnessSummary } from './types.ts';
import { truePeakDb } from './signal-processing.ts';

// BS.1770-4 style K-weighting approximated by two biquad stages:
// a +4 dB high shelf near 1680 Hz followed by a 38 Hz high-pass.
export const kWeight = (mono: Float32Array, sampleRate: number): Float32Array => {
  const shelf = highShelfCoeffs(sampleRate, 1681.97, 4);
  const highpass = highpassCoeffs(sampleRate, 38.13);
  return applyBiquadCascade(mono, [shelf, highpass]);
};

const meanSquare = (signal: Float32Array, start: number, end: number): number => {
  let total = 0;
  for (let i = start; i < end; i += 1) {
    total += signal[i] * signal[i];
  }
  return total / Math.max(1, end - start);
};

const EPS_POWER = 1e-12;

// Gated integrated loudness plus the maximum 400 ms short-term window.
export const measureLoudness = (buffer: AudioBufferData): LoudnessSummary => {
  const mono = mixToMono(buffer);
  const weighted = kWeight(mono, buffer.sampleRate);
  const windowSamples = Math.max(1, Math.round(buffer.sampleRate * 0.4));
  const hopSamples = Math.max(1, Math.round(buffer.sampleRate * 0.1));
  const blockPowers: number[] = [];
  let shortTermMax = -Infinity;
  let rawRmsPower = 0;
  for (let i = 0; i < mono.length; i += 1) {
    rawRmsPower += mono[i] * mono[i];
  }
  rawRmsPower /= Math.max(1, mono.length);

  for (let start = 0; start + windowSamples <= weighted.length; start += hopSamples) {
    const power = meanSquare(weighted, start, start + windowSamples);
    blockPowers.push(power);
    shortTermMax = Math.max(shortTermMax, power);
  }
  if (blockPowers.length === 0) {
    blockPowers.push(meanSquare(weighted, 0, weighted.length));
  }
  const absoluteGate = Math.pow(10, -70 / 10);
  const passedAbsolute = blockPowers.filter((power) => power > absoluteGate);
  let gated = passedAbsolute;
  if (passedAbsolute.length > 0) {
    const mean =
      passedAbsolute.reduce((sum, value) => sum + value, 0) / passedAbsolute.length;
    const relativeGate = mean * Math.pow(10, -10 / 10);
    const passedRelative = passedAbsolute.filter((power) => power >= relativeGate);
    if (passedRelative.length > 0) gated = passedRelative;
  }
  const integratedPower =
    gated.reduce((sum, value) => sum + value, 0) / Math.max(1, gated.length);
  const peak = truePeakDb(mono);
  const rmsDb = powerToDb(rawRmsPower);
  return {
    integratedLufs: powerToDb(integratedPower),
    shortTermMaxLufs: powerToDb(shortTermMax === -Infinity ? EPS_POWER : shortTermMax),
    truePeakDb: peak,
    crestFactorDb: peak - rmsDb,
  };
};
