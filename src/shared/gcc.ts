import { Fft, nextPowerOfTwo } from "./fft.ts";

export interface CorrelationResult {
  lagSamples: number;
  peak: number;
  zScore: number;
}

export function gccPhat(
  reference: Float32Array | Float64Array,
  recorded: Float32Array | Float64Array,
  maxLag: number,
): CorrelationResult {
  const n = nextPowerOfTwo(reference.length + recorded.length - 1);
  const fft = new Fft(n);
  const refRe = new Float64Array(n);
  const refIm = new Float64Array(n);
  const recRe = new Float64Array(n);
  const recIm = new Float64Array(n);
  refRe.set(reference);
  recRe.set(recorded);
  fft.forward(refRe, refIm);
  fft.forward(recRe, recIm);

  const crossRe = new Float64Array(n);
  const crossIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const re = refRe[k]! * recRe[k]! + refIm[k]! * recIm[k]!;
    const im = refRe[k]! * recIm[k]! - refIm[k]! * recRe[k]!;
    const mag = Math.hypot(re, im);
    const weight = mag > 1e-12 ? 1 / mag : 0;
    crossRe[k] = re * weight;
    crossIm[k] = im * weight;
  }
  fft.inverse(crossRe, crossIm);

  const corr = new Float64Array(2 * maxLag + 1);
  for (let d = -maxLag; d <= maxLag; d++) {
    const idx = d < 0 ? n + d : d;
    corr[d + maxLag] = crossRe[idx]!;
  }
  let peakIndex = 0;
  for (let i = 1; i < corr.length; i++) {
    if (corr[i]! > corr[peakIndex]!) peakIndex = i;
  }
  let refined = peakIndex;
  let peak = corr[peakIndex]!;
  if (peakIndex > 0 && peakIndex < corr.length - 1) {
    const left = corr[peakIndex - 1]!;
    const right = corr[peakIndex + 1]!;
    const denom = left - 2 * peak + right;
    if (Math.abs(denom) > 1e-12) {
      const shift = 0.5 * (left - right) / denom;
      if (Number.isFinite(shift) && Math.abs(shift) <= 1) {
        refined = peakIndex + shift;
        peak = peak - 0.25 * (left - right) * shift;
      }
    }
  }
  let sum = 0;
  let sumSq = 0;
  for (const value of corr) {
    sum += value;
    sumSq += value * value;
  }
  const mean = sum / corr.length;
  const std = Math.max(1e-12, Math.sqrt(sumSq / corr.length - mean * mean));
  return {
    lagSamples: refined - maxLag,
    peak,
    zScore: (peak - mean) / std,
  };
}
