// Soft spectral de-reverberation for speech interviews. Two cooperating
// per-band detectors:
//  1. Tail expander: a slow-release peak follower; when a bin falls below
//     its held peak it is treated as reverb-tail-dominated and suppressed
//     proportionally (handles phrase/word offsets).
//  2. Haze subtractor: a slow minimum tracker estimates the steady diffuse
//     reverb floor (it persists under sustained vowels where detector 1 is
//     blind) and subtracts a bounded share of it.
// The combined gain is:
//   - floored (never mutes: word tails and pauses are attenuated, not cut)
//   - smoothed in time (fast attack, slow release) and frequency
//   - relaxed in the high band so the voice keeps its air (no "muffling")
import { stft, istft, magnitudes, type Spectrogram } from "./stft.ts";

export interface DereverbOptions {
  sampleRate: number;
  // Global strength 0..1, or a function of time in seconds for per-sentence
  // control. A bypassed sentence simply returns 0 here.
  strength: number | ((timeSec: number) => number);
  // Assumed room reverberation time in seconds.
  t60?: number;
  frameSize?: number;
  hop?: number;
  // Minimum gain: 0.12 ~= -18 dB. Guarantees no hard gating.
  gainFloor?: number;
  // Detector tuning: suppression starts marginDb below the held peak and
  // reaches full strength rangeDb below it; peakT60Sec controls how slowly
  // the peak follower releases.
  marginDb?: number;
  rangeDb?: number;
  peakT60Sec?: number;
  // Haze subtraction: Wiener-style subtraction of the tracked reverb floor,
  // gated by how "wet" the bin is (floor vs held peak) so dry speech is
  // left untouched; bounded so speech is never hollowed out.
  hazeAmount?: number;
  hazeFloor?: number;
  // Above hfStartHz the suppression amount ramps down to hfMinScale at
  // hfEndHz, protecting brightness.
  hfStartHz?: number;
  hfEndHz?: number;
  hfMinScale?: number;
}

export interface DereverbResult {
  output: Float32Array;
  residual: Float32Array; // input - output: the removed tail, for auditioning
  gains: Float32Array[]; // per-frame averaged gain (for UI display)
  frameSize: number;
  hop: number;
}

export function dereverb(
  input: Float32Array,
  opts: DereverbOptions,
): DereverbResult {
  const sr = opts.sampleRate;
  const frameSize = opts.frameSize ?? (sr >= 32000 ? 2048 : 1024);
  const hop = opts.hop ?? frameSize / 4;
  const t60 = Math.max(0.1, opts.t60 ?? 0.7);
  const floor = opts.gainFloor ?? 0.12;
  const spec: Spectrogram = stft(input, frameSize, hop, sr);
  const half = frameSize / 2 + 1;
  const T = spec.frameCount;
  const hopSec = hop / sr;
  // Peak follower must release *slower* than the room tail so suppression
  // holds through the whole decay instead of letting go halfway.
  const peakT60 = opts.peakT60Sec ?? Math.max(2.5, t60 * 3);
  const peakDecay = Math.exp((-6.9078 * hopSec) / peakT60);
  const marginDb = opts.marginDb ?? 6;
  const rangeDb = opts.rangeDb ?? 20;
  const hazeAmount = opts.hazeAmount ?? 1.0;
  // Deepest haze gain in the low band (ramps up to 0.55 above ~2.5 kHz).
  const hazeFloor = opts.hazeFloor ?? 0.28;
  const hfStartHz = opts.hfStartHz ?? 6000;
  const hfEndHz = opts.hfEndHz ?? Math.min(12000, sr / 2);
  const hfMinScale = opts.hfMinScale ?? 0.45;

  // Per-frame magnitudes, smoothed across frequency (+-3 bins) and time so
  // that vibrato/harmonic flutter is not mistaken for a decaying tail.
  const mags: Float64Array[] = new Array(T);
  for (let t = 0; t < T; t++) {
    const raw = magnitudes(spec.frames[t], frameSize);
    const sm = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      let acc = 0;
      let cnt = 0;
      for (let d = -3; d <= 3; d++) {
        const j = k + d;
        if (j >= 0 && j < half) {
          acc += raw[j];
          cnt++;
        }
      }
      sm[k] = acc / cnt;
    }
    const prev = t > 0 ? mags[t - 1] : null;
    if (prev !== null) {
      for (let k = 0; k < half; k++) {
        const v = sm[k];
        sm[k] = v > prev[k] ? 0.6 * v + 0.4 * prev[k] : 0.35 * v + 0.65 * prev[k];
      }
    }
    mags[t] = sm;
  }

  const strengthAt = (timeSec: number): number => {
    const s = typeof opts.strength === "function"
      ? opts.strength(timeSec)
      : opts.strength;
    return Math.min(1, Math.max(0, s));
  };

  // Reverb floor estimate: forward minimum tracker over the whole signal.
  // Inside pauses and tails it hugs the decaying reverb (hazeRatio -> 1,
  // strong suppression); under sustained vowels it holds the level of the
  // most recent pause — a conservative estimate of the steady-state haze.
  const floorTrack: Float64Array[] = new Array(T);
  {
    let fl: Float64Array | null = null;
    for (let t = 0; t < T; t++) {
      const mag = mags[t];
      const cur = new Float64Array(half);
      for (let k = 0; k < half; k++) {
        const prev = fl === null ? mag[k] : fl[k] * 1.004;
        cur[k] = Math.min(mag[k], prev);
      }
      floorTrack[t] = cur;
      fl = cur;
    }
  }
  const floorAt = (t: number): Float64Array => floorTrack[t];

  const binHz = sr / frameSize;
  const gains: Float32Array[] = new Array(T);
  let prevGain: Float64Array | null = null;
  let peak: Float64Array | null = null;
  const attack = 0.6; // toward lower gains: fast
  // Back toward 1: quick enough that word onsets after a pause are not
  // clipped by the previous gap's suppression; the floor + soft mapping
  // (not the release) is what keeps tails natural.
  const release = 0.3;

  for (let t = 0; t < T; t++) {
    const timeSec = (t * hop) / sr;
    const s = strengthAt(timeSec);
    const alpha = 1.2 * s;
    const raw = new Float64Array(half);
    const mag = mags[t];
    const pk = new Float64Array(half);
    const fl = floorAt(t);
    for (let k = 0; k < half; k++) {
      const prev = peak === null ? 0 : peak[k] * peakDecay;
      pk[k] = Math.max(mag[k], prev);
      // How far below the held peak this bin sits, mapped to 0..1:
      // 0 while speech sustains, -> 1 deep inside the reverb tail.
      const dropDb = 20 * Math.log10((pk[k] + 1e-12) / (mag[k] + 1e-12));
      const tailFrac = Math.min(1, Math.max(0, (dropDb - marginDb) / rangeDb));
      const gTail = 1 - alpha * tailFrac;
      // Wiener-style subtraction of the tracked haze floor, engaged only
      // when the floor is significant relative to the held peak (i.e. the
      // material is actually reverberant). Low bands may subtract deeper:
      // room rumble accumulates there and the ear tolerates it.
      const hazeRatio = fl[k] / (mag[k] + 1e-12);
      const hazeRel = fl[k] / (pk[k] + 1e-12);
      const wetness = Math.min(1, Math.max(0, (hazeRel - 0.03) / 0.1));
      const fNow = k * binHz;
      const lfT = Math.min(1, Math.max(0, (fNow - 300) / 2200));
      const hazeFloorF = hazeFloor + (0.55 - hazeFloor) * lfT;
      const gHazeRaw = Math.max(hazeFloorF, 1 - hazeAmount * s * hazeRatio);
      const gHaze = 1 - wetness * (1 - gHazeRaw);
      let g = gTail * gHaze;
      // High-frequency protection: scale the *suppression* down.
      if (fNow > hfStartHz && hfEndHz > hfStartHz) {
        const r = Math.min(1, (fNow - hfStartHz) / (hfEndHz - hfStartHz));
        const scale = 1 - (1 - hfMinScale) * r;
        g = 1 - (1 - g) * scale;
      }
      raw[k] = Math.min(1, Math.max(floor, g));
    }
    peak = pk;
    // Frequency smoothing (3-tap) to avoid musical noise.
    const sm = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const a = raw[Math.max(0, k - 1)];
      const b = raw[k];
      const c = raw[Math.min(half - 1, k + 1)];
      sm[k] = 0.25 * a + 0.5 * b + 0.25 * c;
    }
    // Time smoothing: asymmetric attack/release.
    if (prevGain !== null) {
      for (let k = 0; k < half; k++) {
        const p = prevGain[k];
        const coeff = sm[k] < p ? attack : release;
        sm[k] = p + coeff * (sm[k] - p);
      }
    }
    prevGain = sm;
    gains[t] = Float32Array.from(sm);

    // Apply gain to the complex spectrum (conjugate-symmetric).
    const frame = spec.frames[t];
    for (let k = 0; k < half; k++) {
      frame[k] *= sm[k];
      frame[frameSize + k] *= sm[k];
    }
    for (let k = half; k < frameSize; k++) {
      const g = sm[frameSize - k];
      frame[k] *= g;
      frame[frameSize + k] *= g;
    }
  }

  const output = istft(spec, input.length);
  const residual = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) residual[i] = input[i] - output[i];
  return { output, residual, gains, frameSize, hop };
}
