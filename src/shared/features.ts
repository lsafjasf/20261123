import { Fft, nextPowerOfTwo } from "./fft.ts";

export interface WindowFeatures {
  rms: number;
  peak: number;
  zcr: number;
  periodicity: number;
  onsetCount: number;
}

export function rmsDb(samples: Float32Array): number {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return 10 * Math.log10(Math.max(1e-12, sum / Math.max(1, samples.length)));
}

export function windowFeatures(samples: Float32Array, sampleRate: number): WindowFeatures {
  let sumSq = 0;
  let peak = 0;
  let crossings = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    sumSq += v * v;
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
    if (i > 0 && (samples[i - 1]! >= 0) !== (v >= 0)) crossings++;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, samples.length));
  const zcr = crossings / Math.max(1, samples.length - 1);
  return {
    rms,
    peak,
    zcr,
    periodicity: harmonicity(samples, sampleRate),
    onsetCount: onsetFluxCount(samples, sampleRate),
  };
}

function harmonicity(samples: Float32Array, sampleRate: number): number {
  const n = nextPowerOfTwo(samples.length);
  const fft = new Fft(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(samples);
  fft.forward(re, im);
  for (let k = 0; k < n; k++) {
    re[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    im[k] = 0;
  }
  fft.inverse(re, im);
  const zeroLag = re[0]!;
  if (zeroLag <= 1e-12) return 0;
  const minLag = Math.floor(sampleRate / 500);
  const maxLag = Math.min(Math.floor(sampleRate / 60), samples.length - 2);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (re[lag]! > best) best = re[lag]!;
  }
  return Math.max(0, Math.min(1, best / zeroLag));
}

function onsetFluxCount(samples: Float32Array, sampleRate: number): number {
  const frame = Math.max(256, Math.floor(sampleRate * 0.046));
  const hop = Math.floor(frame / 2);
  if (samples.length < frame * 3) return 0;
  const energies: number[] = [];
  for (let start = 0; start + frame <= samples.length; start += hop) {
    let sum = 0;
    for (let i = 0; i < frame; i++) sum += samples[start + i]! ** 2;
    energies.push(10 * Math.log10(Math.max(1e-12, sum / frame)));
  }
  const diffs: number[] = [];
  for (let i = 1; i < energies.length; i++) diffs.push(Math.max(0, energies[i]! - energies[i - 1]!));
  const mean = diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length);
  const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, diffs.length);
  const threshold = mean + 1.5 * Math.sqrt(variance);
  let count = 0;
  for (const d of diffs) if (d > threshold && d > 3) count++;
  return count;
}
