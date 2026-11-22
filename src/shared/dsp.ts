// Core DSP: framing, energy, VAD sentence segmentation, breath-valley cut points,
// pitch / spectral features. Pure functions on Float32Array — runs in Node and browser.

export interface Sentence {
  start: number; // seconds, speech onset
  end: number;   // seconds, speech offset
}

export interface Segmentation {
  sentences: Sentence[];
  // Quiet "valley" positions safe to cut at: sentences.length + 1 entries.
  // cutPoints[i] is the boundary before sentence i (breath preserved on both sides).
  cutPoints: number[];
  noiseFloorDb: number;
  frameDb: Float32Array; // short-time energy per frame, dB
  framesPerSecond: number;
  duration: number; // seconds
}

export interface SegmentOptions {
  frameMs?: number;
  hopMs?: number;
  thresholdDb?: number;    // speech = noiseFloor + thresholdDb
  minSilenceMs?: number;   // gaps shorter than this are merged into one sentence
  minSpeechMs?: number;    // runs shorter than this are dropped
  minVoicedRatio?: number; // runs below this harmonicity are breaths, not speech
  headPadMs?: number;      // fallback handle before first sentence
  tailPadMs?: number;      // fallback handle after last sentence
}

const DEFAULTS: Required<SegmentOptions> = {
  frameMs: 25,
  hopMs: 10,
  thresholdDb: 16,
  minSilenceMs: 220,
  minSpeechMs: 120,
  minVoicedRatio: 0.4,
  headPadMs: 350,
  tailPadMs: 500,
};

export function frameEnergiesDb(
  samples: Float32Array,
  sampleRate: number,
  frameMs = 25,
  hopMs = 10,
): { db: Float32Array; framesPerSecond: number } {
  const frame = Math.max(8, Math.round((frameMs / 1000) * sampleRate));
  const hop = Math.max(4, Math.round((hopMs / 1000) * sampleRate));
  const count = Math.max(1, Math.floor((samples.length - frame) / hop) + 1);
  const db = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const off = i * hop;
    let sum = 0;
    for (let j = 0; j < frame; j++) {
      const v = samples[off + j];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / frame);
    db[i] = 20 * Math.log10(Math.max(rms, 1e-8));
  }
  return { db, framesPerSecond: 1000 / hopMs };
}

export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const idx = Math.min(n - 1, Math.max(0, Math.floor((p / 100) * n)));
  return sorted[idx];
}

export function estimateNoiseFloorDb(db: Float32Array): number {
  const sorted = Float32Array.from(db).sort();
  return percentile(sorted, 10);
}

function valleyInRange(db: Float32Array, fromFrame: number, toFrame: number): number {
  const lo = Math.max(0, Math.min(fromFrame, toFrame));
  const hi = Math.min(db.length - 1, Math.max(fromFrame, toFrame));
  let best = lo;
  let bestVal = Infinity;
  for (let i = lo; i <= hi; i++) {
    if (db[i] < bestVal) {
      bestVal = db[i];
      best = i;
    }
  }
  return best;
}

export function segmentSentences(
  samples: Float32Array,
  sampleRate: number,
  opts: SegmentOptions = {},
): Segmentation {
  const o = { ...DEFAULTS, ...opts };
  const { db, framesPerSecond: fps } = frameEnergiesDb(samples, sampleRate, o.frameMs, o.hopMs);
  const duration = samples.length / sampleRate;
  const floor = estimateNoiseFloorDb(db);
  const thresh = floor + o.thresholdDb;
  // Hysteresis: quiet syllables inside a sentence may dip below the main
  // threshold; a lower "hold" threshold keeps them attached to the run.
  const holdThresh = floor + o.thresholdDb * 0.45;
  const minSilenceFrames = Math.max(1, Math.round((o.minSilenceMs / 1000) * fps));
  const minSpeechFrames = Math.max(1, Math.round((o.minSpeechMs / 1000) * fps));

  // Candidate runs above the hold threshold...
  const candidates: Array<[number, number]> = [];
  let runStart = -1;
  for (let i = 0; i < db.length; i++) {
    if (db[i] >= holdThresh) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      candidates.push([runStart, i - 1]);
      runStart = -1;
    }
  }
  if (runStart >= 0) candidates.push([runStart, db.length - 1]);

  // ...kept only if they contain at least one frame above the main threshold.
  const runs = candidates.filter(([a, b]) => {
    for (let i = a; i <= b; i++) if (db[i] >= thresh) return true;
    return false;
  });

  // Classify raw runs: breaths are loud but aperiodic — drop them before
  // merging so a breath mid-gap neither becomes a sentence nor glues two
  // sentences together. The breath audio itself stays in the gap and is
  // preserved by the valley cut points.
  const voicedRuns = runs.filter(([a, b]) => {
    const ratio = voicedRatioOfRange(samples, sampleRate, a / fps, (b + 1) / fps);
    return ratio >= o.minVoicedRatio;
  });

  // Merge runs separated by short silences.
  const merged: Array<[number, number]> = [];
  for (const r of voicedRuns) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] <= minSilenceFrames) {
      last[1] = r[1];
    } else {
      merged.push([r[0], r[1]]);
    }
  }

  // Drop too-short runs, convert to seconds.
  const sentences: Sentence[] = merged
    .filter(([a, b]) => b - a + 1 >= minSpeechFrames)
    .map(([a, b]) => ({ start: a / fps, end: (b + 1) / fps }));

  // Cut points at the quietest frame of each inter-sentence gap (breath valley).
  const cutPoints: number[] = [];
  const headFrames = Math.round((o.headPadMs / 1000) * fps);
  const tailFrames = Math.round((o.tailPadMs / 1000) * fps);
  for (let i = 0; i <= sentences.length; i++) {
    if (sentences.length === 0) {
      cutPoints.push(i === 0 ? 0 : duration);
      continue;
    }
    if (i === 0) {
      const s0 = Math.round(sentences[0].start * fps);
      cutPoints.push(valleyInRange(db, Math.max(0, s0 - headFrames), s0) / fps);
    } else if (i === sentences.length) {
      const eN = Math.round(sentences[sentences.length - 1].end * fps);
      cutPoints.push(valleyInRange(db, eN - 1, Math.min(db.length - 1, eN + tailFrames)) / fps);
    } else {
      const gapFrom = Math.round(sentences[i - 1].end * fps) - 1;
      const gapTo = Math.round(sentences[i].start * fps);
      cutPoints.push(valleyInRange(db, gapFrom, gapTo) / fps);
    }
  }

  return { sentences, cutPoints, noiseFloorDb: floor, frameDb: db, framesPerSecond: fps, duration };
}

// RMS envelope of samples[start..end] resampled to n points (for rhythm comparison).
export function envelope(
  samples: Float32Array,
  sampleRate: number,
  start: number,
  end: number,
  n: number,
): Float32Array {
  const from = Math.max(0, Math.floor(start * sampleRate));
  const to = Math.min(samples.length, Math.ceil(end * sampleRate));
  const out = new Float32Array(n);
  const len = Math.max(1, to - from);
  for (let i = 0; i < n; i++) {
    const a = from + Math.floor((i / n) * len);
    const b = from + Math.floor(((i + 1) / n) * len);
    let sum = 0;
    const cnt = Math.max(1, b - a);
    for (let j = a; j < Math.max(b, a + 1) && j < to; j++) sum += samples[j] * samples[j];
    out[i] = Math.sqrt(sum / cnt);
  }
  return out;
}

// Normalized cross-correlation (zero-mean). 1 = identical rhythm shape.
export function ncc(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db2 = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db2 += xb * xb;
  }
  const den = Math.sqrt(da * db2);
  return den > 1e-12 ? num / den : 0;
}

export function rmsDbOfRange(
  samples: Float32Array,
  sampleRate: number,
  start: number,
  end: number,
): number {
  const from = Math.max(0, Math.floor(start * sampleRate));
  const to = Math.min(samples.length, Math.ceil(end * sampleRate));
  if (to <= from) return -160;
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return 20 * Math.log10(Math.max(Math.sqrt(sum / (to - from)), 1e-8));
}

export interface PitchStats {
  meanHz: number;
  p10Hz: number;
  p90Hz: number;
  voicedRatio: number;
}

// Autocorrelation periodicity of one frame: returns [f0Hz, strength 0..1].
function framePeriodicity(
  samples: Float32Array,
  sampleRate: number,
  off: number,
  frame: number,
): [number, number] {
  const minLag = Math.floor(sampleRate / 500);
  const maxLag = Math.ceil(sampleRate / 75);
  let energy = 0;
  for (let j = 0; j < frame; j++) energy += samples[off + j] * samples[off + j];
  const e = energy / frame;
  if (e < 1e-6) return [0, 0];
  let bestLag = -1;
  let bestVal = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const limit = frame - lag;
    for (let j = 0; j < limit; j++) sum += samples[off + j] * samples[off + j + lag];
    const norm = sum / limit;
    if (norm > bestVal) {
      bestVal = norm;
      bestLag = lag;
    }
  }
  if (bestLag <= 0) return [0, 0];
  return [sampleRate / bestLag, bestVal / e];
}

// Fraction of frames in the range that are harmonic (voiced speech vs breath).
export function voicedRatioOfRange(
  samples: Float32Array,
  sampleRate: number,
  start: number,
  end: number,
): number {
  const from = Math.max(0, Math.floor(start * sampleRate));
  const to = Math.min(samples.length, Math.ceil(end * sampleRate));
  const frame = Math.round(0.04 * sampleRate);
  const hop = Math.round(0.02 * sampleRate);
  let voiced = 0;
  let total = 0;
  for (let off = from; off + frame <= to; off += hop) {
    total++;
    const [, strength] = framePeriodicity(samples, sampleRate, off, frame);
    if (strength > 0.3) voiced++;
  }
  return total > 0 ? voiced / total : 0;
}

// Autocorrelation F0 tracker over the given range (75–500 Hz).
export function pitchTrack(
  samples: Float32Array,
  sampleRate: number,
  start: number,
  end: number,
): PitchStats {
  const from = Math.max(0, Math.floor(start * sampleRate));
  const to = Math.min(samples.length, Math.ceil(end * sampleRate));
  const frame = Math.round(0.04 * sampleRate);
  const hop = Math.round(0.01 * sampleRate);
  const f0s: number[] = [];
  for (let off = from; off + frame <= to; off += hop) {
    const [f0, strength] = framePeriodicity(samples, sampleRate, off, frame);
    if (strength > 0.3) f0s.push(f0);
  }
  const total = Math.max(1, Math.floor((to - from - frame) / hop) + 1);
  if (f0s.length === 0) return { meanHz: 0, p10Hz: 0, p90Hz: 0, voicedRatio: 0 };
  f0s.sort((a, b) => a - b);
  const mean = f0s.reduce((a, b) => a + b, 0) / f0s.length;
  return {
    meanHz: mean,
    p10Hz: percentile(f0s, 10),
    p90Hz: percentile(f0s, 90),
    voicedRatio: f0s.length / total,
  };
}

// Iterative radix-2 FFT (in-place). re/im length must be a power of two.
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cwr - im[i + j + len / 2] * cwi;
        const vi = re[i + j + len / 2] * cwi + im[i + j + len / 2] * cwr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

// Mean spectral centroid (Hz) over the range — brightness proxy for emotion.
export function spectralCentroid(
  samples: Float32Array,
  sampleRate: number,
  start: number,
  end: number,
): number {
  const from = Math.max(0, Math.floor(start * sampleRate));
  const to = Math.min(samples.length, Math.ceil(end * sampleRate));
  const size = 1024;
  const hop = 512;
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  let sum = 0;
  let frames = 0;
  for (let off = from; off + size <= to; off += hop) {
    for (let j = 0; j < size; j++) {
      // Hann window
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (size - 1));
      re[j] = samples[off + j] * w;
      im[j] = 0;
    }
    fft(re, im);
    let num = 0;
    let den = 0;
    for (let k = 1; k < size / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      num += ((k * sampleRate) / size) * mag;
      den += mag;
    }
    if (den > 1e-9) {
      sum += num / den;
      frames++;
    }
  }
  return frames > 0 ? sum / frames : 0;
}
