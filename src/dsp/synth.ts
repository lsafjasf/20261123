// Deterministic synthetic test material: speech-like voice, artificial and
// realistic-room impulse responses. Used by the regression tests.
import { convolve } from "./fft.ts";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number;
  x1: number; x2: number; y1: number; y2: number;
}

function resonator(freq: number, bw: number, sr: number): Biquad {
  const r = Math.exp((-Math.PI * bw) / sr);
  const w = (2 * Math.PI * freq) / sr;
  return {
    b0: 1 - r, b1: 0, b2: 0,
    a1: -2 * r * Math.cos(w), a2: r * r,
    x1: 0, x2: 0, y1: 0, y2: 0,
  };
}

function runBiquad(b: Biquad, x: number): number {
  const y = b.b0 * x + b.b1 * b.x1 + b.b2 * b.x2 - b.a1 * b.y1 - b.a2 * b.y2;
  b.x2 = b.x1; b.x1 = x;
  b.y2 = b.y1; b.y1 = y;
  return y;
}

// Speech-like signal: harmonic glottal source through three formant
// resonators, syllabic envelope with pauses (word gaps) and breath noise.
export function synthVoice(sr: number, seed = 7): { samples: Float32Array; speechEndSec: number } {
  const rand = mulberry32(seed);
  const vowels: Array<[number, number, number]> = [
    [700, 1220, 2600], // a
    [400, 2000, 2800], // i
    [500, 900, 2400], // o
    [300, 1600, 2500], // e
  ];
  const syllables = 14;
  const sylDur = 0.28;
  const gapDur = 0.22;
  const total = syllables * (sylDur + gapDur) + 1.0;
  const n = Math.floor(total * sr);
  const out = new Float32Array(n);
  const formants = vowels.map(([f1, f2, f3]) => [
    resonator(f1, 90, sr),
    resonator(f2, 110, sr),
    resonator(f3, 160, sr),
  ]);
  let t = 0;
  let phase = 0;
  for (let s = 0; s < syllables; s++) {
    const f0 = 105 + 25 * rand();
    const v = s % vowels.length;
    const dur = Math.floor(sylDur * sr);
    for (let i = 0; i < dur && t < n; i++, t++) {
      const env = Math.sin((Math.PI * i) / dur) ** 0.7;
      const vib = 1 + 0.01 * Math.sin((2 * Math.PI * 5 * i) / sr);
      phase += (2 * Math.PI * f0 * vib) / sr;
      // glottal-ish pulse train: sum of harmonics with 1/h rolloff
      let src = 0;
      for (let h = 1; h <= 24; h++) src += Math.sin(phase * h) / h;
      src *= 0.35;
      let y = 0;
      const gains = [1.0, 0.55, 0.3];
      for (let f = 0; f < 3; f++) y += gains[f] * runBiquad(formants[v][f], src);
      y += 0.01 * (rand() * 2 - 1); // breath
      out[t] = 0.5 * env * y;
    }
    t += Math.floor(gapDur * sr); // pause between words
  }
  const speechEndSec = t / sr;
  return { samples: out, speechEndSec };
}

// Artificial reverb IR: direct + exponentially decaying noise, fixed T60.
// The tail is band-limited (70 Hz high-pass) like any real room.
export function artificialIr(sr: number, t60 = 0.8, seed = 11): Float32Array {
  const rand = mulberry32(seed);
  const len = Math.floor(sr * Math.max(0.4, t60 * 1.6));
  const ir = new Float32Array(len);
  ir[0] = 1;
  let hp = 0;
  const hpCoeff = Math.exp((-2 * Math.PI * 70) / sr);
  for (let i = 1; i < len; i++) {
    const t = i / sr;
    const noise = rand() * 2 - 1;
    hp = hpCoeff * hp + (1 - hpCoeff) * noise; // low-pass state
    ir[i] = 0.6 * (noise - hp) * Math.exp((-6.9078 * t) / t60); // high-passed
  }
  return ir;
}

// Realistic room IR: direct sound, discrete early reflections, and a diffuse
// tail with frequency-dependent decay (lows ring longer, highs die fast),
// mimicking a real empty room.
export function roomIr(sr: number, seed = 23): Float32Array {
  const rand = mulberry32(seed);
  const len = Math.floor(sr * 1.4);
  const ir = new Float32Array(len);
  ir[0] = 1;
  // early reflections 6..70 ms
  const early = [0.006, 0.011, 0.017, 0.026, 0.038, 0.052, 0.069];
  early.forEach((sec, idx) => {
    const at = Math.floor(sec * sr);
    ir[at] += (idx % 2 === 0 ? 1 : -1) * 0.28 * Math.exp(-idx * 0.3);
  });
  // diffuse tail: noise through three stacked one-pole lowpasses gives a
  // rough band-split; each band decays at its own T60.
  const bands = [
    { t60: 1.1, gain: 0.35, lp: 0.15 }, // lows ring longest (~500 Hz)
    { t60: 0.8, gain: 0.35, lp: 0.4 },
    { t60: 0.45, gain: 0.3, lp: 1.0 }, // unfiltered = bright, decays fast
  ];
  const start = Math.floor(0.02 * sr);
  for (const band of bands) {
    let lpState = 0;
    for (let i = start; i < len; i++) {
      const t = i / sr;
      const noise = rand() * 2 - 1;
      lpState += band.lp * (noise - lpState);
      ir[i] += band.gain * lpState * Math.exp((-6.9078 * t) / band.t60);
    }
  }
  return ir;
}

export function applyReverb(dry: Float32Array, ir: Float32Array, wetMix = 1): Float32Array {
  const wet = convolve(dry, ir);
  const out = new Float32Array(wet.length);
  for (let i = 0; i < wet.length; i++) {
    const d = i < dry.length ? dry[i] : 0;
    out[i] = (1 - wetMix) * d + wetMix * wet[i];
  }
  return out;
}
