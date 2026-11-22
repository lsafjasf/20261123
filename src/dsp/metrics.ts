// Objective metrics used by the regression tests.
import { stft, magnitudes } from "./stft.ts";

export function rmsDb(x: Float32Array, start = 0, end = x.length): number {
  let sum = 0;
  const s = Math.max(0, start);
  const e = Math.min(x.length, end);
  for (let i = s; i < e; i++) sum += x[i] * x[i];
  return 10 * Math.log10(sum / Math.max(1, e - s) + 1e-12);
}

// Energy in the tail window after speech offset relative to the last
// 200 ms of speech. Lower = drier.
export function tailRatioDb(
  x: Float32Array,
  sr: number,
  speechEndSec: number,
  tailStartSec = 0.15,
  tailLenSec = 0.5,
): number {
  const end = Math.floor(speechEndSec * sr);
  const speech = rmsDb(x, end - Math.floor(0.2 * sr), end);
  const tail = rmsDb(
    x,
    end + Math.floor(tailStartSec * sr),
    end + Math.floor((tailStartSec + tailLenSec) * sr),
  );
  return tail - speech;
}

// Average spectral centroid over voiced frames (Hz). Guards "not muffled".
export function spectralCentroid(x: Float32Array, sr: number): number {
  const frame = 1024;
  const hop = 512;
  const spec = stft(x, frame, hop, sr);
  const binHz = sr / frame;
  let wSum = 0;
  let cSum = 0;
  for (let t = 0; t < spec.frameCount; t++) {
    const mag = magnitudes(spec.frames[t], frame);
    let e = 0;
    for (let k = 0; k < mag.length; k++) e += mag[k];
    if (e < 1e-6) continue; // skip silence
    let c = 0;
    for (let k = 0; k < mag.length; k++) c += k * binHz * mag[k];
    wSum += e;
    cSum += (c / e) * e; // energy-weighted centroid
  }
  return wSum > 0 ? cSum / wSum : 0;
}

// Mean log-spectral distance (dB) between two signals over voiced frames
// (reference energy within 30 dB of the peak frame). Measures spectral
// distortion of the direct sound, ignoring silence/breath frames.
export function logSpectralDistanceDb(a: Float32Array, b: Float32Array, sr: number): number {
  const frame = 1024;
  const hop = 512;
  const n = Math.min(a.length, b.length);
  const sa = stft(a.subarray(0, n), frame, hop, sr);
  const sb = stft(b.subarray(0, n), frame, hop, sr);
  const energies: number[] = [];
  let peak = 0;
  for (let t = 0; t < sa.frameCount; t++) {
    const ma = magnitudes(sa.frames[t], frame);
    let e = 0;
    for (let k = 0; k < ma.length; k++) e += ma[k] * ma[k];
    energies.push(e);
    if (e > peak) peak = e;
  }
  let sum = 0;
  let count = 0;
  for (let t = 0; t < sa.frameCount; t++) {
    if (energies[t] < peak * 1e-3) continue;
    const ma = magnitudes(sa.frames[t], frame);
    const mb = magnitudes(sb.frames[t], frame);
    let d = 0;
    for (let k = 0; k < ma.length; k++) {
      const la = Math.log(ma[k] * ma[k] + 1e-10);
      const lb = Math.log(mb[k] * mb[k] + 1e-10);
      d += (la - lb) * (la - lb);
    }
    sum += Math.sqrt(d / ma.length);
    count++;
  }
  return count > 0 ? (sum / count) * 4.3429 : 0; // nepers -> dB
}

// Schroeder backwards integration on the tail after speechEndSec.
// Returns estimated T60 in seconds (from the -5..-35 dB slope).
export function estimateT60(x: Float32Array, sr: number, startSec: number): number {
  const start = Math.floor(startSec * sr);
  const win = Math.floor(0.01 * sr);
  const nE = Math.floor((x.length - start) / win);
  if (nE < 20) return 0;
  const e = new Float64Array(nE);
  for (let i = 0; i < nE; i++) {
    let s = 0;
    for (let j = 0; j < win; j++) {
      const v = x[start + i * win + j];
      s += v * v;
    }
    e[i] = s;
  }
  const sch = new Float64Array(nE);
  let acc = 0;
  for (let i = nE - 1; i >= 0; i--) {
    acc += e[i];
    sch[i] = acc;
  }
  const db = sch.map((v) => 10 * Math.log10(v / sch[0] + 1e-12));
  let i5 = -1;
  let i35 = -1;
  for (let i = 0; i < nE; i++) {
    if (i5 < 0 && db[i] <= -5) i5 = i;
    if (i35 < 0 && db[i] <= -35) {
      i35 = i;
      break;
    }
  }
  if (i5 < 0 || i35 < 0 || i35 <= i5) return 0;
  const slopeDbPerSec = 30 / (((i35 - i5) * win) / sr);
  return 60 / slopeDbPerSec;
}

// Longest run of (near-)zero samples: a hard gate produces long muted runs
// inside the tail; soft suppression must not.
export function longestZeroRun(x: Float32Array, eps = 1e-4): number {
  let best = 0;
  let cur = 0;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) < eps) {
      cur++;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}
