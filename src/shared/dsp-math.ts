// Small, dependency-free DSP primitives shared by CLI and browser builds.

export const EPS = 1e-12;

export const gainToDb = (gain: number): number =>
  20 * Math.log10(Math.max(gain, EPS));

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

export const powerToDb = (power: number): number =>
  10 * Math.log10(Math.max(power, EPS));

export const dbToPower = (db: number): number => Math.pow(10, db / 10);

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const hannWindow = (size: number): Float32Array => {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
};

// Iterative radix-2 Cooley-Tukey FFT. Inputs are separate real/imag arrays.
export const fftRadix2 = (real: Float32Array, imag: Float32Array): void => {
  const n = real.length;
  if ((n & (n - 1)) !== 0) {
    throw new Error(`FFT size must be a power of two, got ${n}`);
  }
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      const ti = imag[i];
      real[i] = real[j];
      imag[i] = imag[j];
      real[j] = tr;
      imag[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let start = 0; start < n; start += len) {
      let curReal = 1;
      let curImag = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k += 1) {
        const even = start + k;
        const odd = even + half;
        const xr = curReal * real[odd] - curImag * imag[odd];
        const xi = curReal * imag[odd] + curImag * real[odd];
        real[odd] = real[even] - xr;
        imag[odd] = imag[even] - xi;
        real[even] += xr;
        imag[even] += xi;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
};

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

// RBJ audio EQ cookbook coefficients, transposed direct form II usage.
const safeCutoff = (sampleRate: number, cutoffHz: number): number =>
  clamp(cutoffHz, sampleRate * 0.0005, sampleRate * 0.49);

export const lowpassCoeffs = (sampleRate: number, cutoffHz: number): BiquadCoeffs => {
  const q = 0.7071;
  const w0 = (2 * Math.PI * safeCutoff(sampleRate, cutoffHz)) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cosw) / 2 / a0,
    b1: (1 - cosw) / a0,
    b2: (1 - cosw) / 2 / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
};

export const highpassCoeffs = (sampleRate: number, cutoffHz: number): BiquadCoeffs => {
  const q = 0.7071;
  const w0 = (2 * Math.PI * safeCutoff(sampleRate, cutoffHz)) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cosw) / 2 / a0,
    b1: (-1 - cosw) / a0,
    b2: (1 + cosw) / 2 / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
};

// Pre-filter (boost) shelf used by the BS.1770 K-weighting stage.
export const highShelfCoeffs = (
  sampleRate: number,
  cutoffHz: number,
  gainDb: number,
): BiquadCoeffs => {
  const a = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / 2 * Math.sqrt((a + 1 / a) * (1 / 0.7071 - 1) + 2);
  const sqrtA = 2 * Math.sqrt(a) * alpha;
  const a0 = (a + 1) + (a - 1) * cosw + sqrtA;
  return {
    b0: (a * ((a + 1) + (a - 1) * cosw - sqrtA)) / a0,
    b1: (2 * a * ((a - 1) - (a + 1) * cosw)) / a0,
    b2: (a * ((a + 1) + (a - 1) * cosw - sqrtA)) / a0,
    a1: (-2 * ((a - 1) + (a + 1) * cosw)) / a0,
    a2: ((a + 1) - (a - 1) * cosw + sqrtA) / a0,
  };
};

// Applies a cascade of biquads to a mono signal and returns a new buffer.
export const applyBiquadCascade = (
  input: Float32Array,
  stages: BiquadCoeffs[],
): Float32Array => {
  let current = input;
  for (const coeffs of stages) {
    const output = new Float32Array(current.length);
    let z1 = 0;
    let z2 = 0;
    for (let i = 0; i < current.length; i += 1) {
      const x = current[i];
      const y = coeffs.b0 * x + z1;
      z1 = coeffs.b1 * x - coeffs.a1 * y + z2;
      z2 = coeffs.b2 * x - coeffs.a2 * y;
      output[i] = y;
    }
    current = output;
  }
  return current;
};

// Deterministic PRNG so the modelled ambient noise is reproducible.
export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
