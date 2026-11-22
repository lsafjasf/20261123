// 基础 DSP：全部在原始 PCM 上计算，不做任何降噪/滤波预处理，
// 避免把底噪阶跃、相位断裂等证据一并抹掉。

export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

// 迭代基-2 FFT，就地计算。re/im 长度须为 2 的幂。
export function fft(re: Float32Array, im: Float32Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((2 * Math.PI) / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

export interface Frames {
  mags: Float32Array[];   // 每帧幅度谱（半谱）
  phases: Float32Array[]; // 每帧相位谱（半谱）
  rms: Float32Array;      // 每帧时域 RMS
  times: Float32Array;    // 每帧中心时间（秒）
  frameSize: number;
  hop: number;
  sampleRate: number;
}

export function frameSignal(pcm: Float32Array, sampleRate: number, frameSize = 2048, hop = 512): Frames {
  const win = hannWindow(frameSize);
  const count = Math.max(0, Math.floor((pcm.length - frameSize) / hop) + 1);
  const half = frameSize / 2;
  const mags: Float32Array[] = new Array(count);
  const phases: Float32Array[] = new Array(count);
  const rms = new Float32Array(count);
  const times = new Float32Array(count);
  const re = new Float32Array(frameSize);
  const im = new Float32Array(frameSize);
  for (let f = 0; f < count; f++) {
    const off = f * hop;
    let acc = 0;
    for (let i = 0; i < frameSize; i++) {
      const s = pcm[off + i];
      re[i] = s * win[i];
      im[i] = 0;
      acc += s * s;
    }
    rms[f] = Math.sqrt(acc / frameSize);
    times[f] = (off + frameSize / 2) / sampleRate;
    fft(re, im);
    const mag = new Float32Array(half);
    const ph = new Float32Array(half);
    for (let k = 0; k < half; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      ph[k] = Math.atan2(im[k], re[k]);
    }
    mags[f] = mag;
    phases[f] = ph;
  }
  return { mags, phases, rms, times, frameSize, hop, sampleRate };
}

export function median(x: ArrayLike<number>): number {
  const a = Float64Array.from(x as ArrayLike<number>).sort();
  const n = a.length;
  if (n === 0) return 0;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

// 中位数 + MAD 的稳健 z 分数，抗离群点，避免被单次衣料摩擦带偏。
export function robustZ(x: ArrayLike<number>): Float64Array {
  const med = median(x);
  const dev = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) dev[i] = Math.abs(x[i] - med);
  const mad = Math.max(median(dev), 1e-9);
  const z = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) z[i] = (x[i] - med) / (1.4826 * mad);
  return z;
}
