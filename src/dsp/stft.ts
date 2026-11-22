// STFT / ISTFT with Hann window and weighted overlap-add (COLA-normalised).
import { fft } from "./fft.ts";

export interface Spectrogram {
  // frames[t] holds interleaved re/im of length frameSize
  frames: Float64Array[];
  frameSize: number;
  hop: number;
  sampleRate: number;
  frameCount: number;
}

export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

export function stft(
  samples: Float32Array,
  frameSize: number,
  hop: number,
  sampleRate: number,
): Spectrogram {
  const win = hannWindow(frameSize);
  const frameCount = Math.max(1, Math.ceil((samples.length - frameSize) / hop) + 1);
  const frames: Float64Array[] = new Array(frameCount);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  for (let t = 0; t < frameCount; t++) {
    const off = t * hop;
    re.fill(0);
    im.fill(0);
    const end = Math.min(frameSize, samples.length - off);
    for (let i = 0; i < end; i++) re[i] = samples[off + i] * win[i];
    fft(re, im, false);
    const packed = new Float64Array(frameSize * 2);
    packed.set(re, 0);
    packed.set(im, frameSize);
    frames[t] = packed;
  }
  return { frames, frameSize, hop, sampleRate, frameCount };
}

export function istft(spec: Spectrogram, length: number): Float32Array {
  const { frames, frameSize, hop } = spec;
  const win = hannWindow(frameSize);
  const out = new Float64Array(length);
  const norm = new Float64Array(length);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  for (let t = 0; t < frames.length; t++) {
    const packed = frames[t];
    re.set(packed.subarray(0, frameSize));
    im.set(packed.subarray(frameSize, frameSize * 2));
    fft(re, im, true);
    const off = t * hop;
    const end = Math.min(frameSize, length - off);
    for (let i = 0; i < end; i++) {
      out[off + i] += re[i] * win[i];
      norm[off + i] += win[i] * win[i];
    }
  }
  const result = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    result[i] = norm[i] > 1e-8 ? out[i] / norm[i] : 0;
  }
  return result;
}

export function magnitudes(frame: Float64Array, frameSize: number): Float64Array {
  const half = frameSize / 2 + 1;
  const mag = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const re = frame[k];
    const im = frame[frameSize + k];
    mag[k] = Math.hypot(re, im);
  }
  return mag;
}
