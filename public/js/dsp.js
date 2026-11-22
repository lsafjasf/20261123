// 纯 TS 数字信号处理：radix-2 FFT、Hann 窗、线性重采样、电平换算。

const FFT_N = 512;
const cosTable = new Float64Array(FFT_N / 2);
const sinTable = new Float64Array(FFT_N / 2);
for (let i = 0; i < FFT_N / 2; i++) {
  cosTable[i] = Math.cos((2 * Math.PI * i) / FFT_N);
  sinTable[i] = Math.sin((2 * Math.PI * i) / FFT_N);
}
const hann = new Float32Array(FFT_N);
for (let i = 0; i < FFT_N; i++) {
  hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_N - 1)));
}

const revCache = new Map                     ();
function bitRev(n        )              {
  let r = revCache.get(n);
  if (r) return r;
  r = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let b = 0; b < bits; b++) v |= ((i >> b) & 1) << (bits - 1 - b);
    r[i] = v;
  }
  revCache.set(n, r);
  return r;
}

// 就地迭代 FFT。re/im 长度须为 2 的幂。
export function fft(re              , im              )       {
  const n = re.length;
  const rev = bitRev(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = n / size;
    for (let base = 0; base < n; base += size) {
      for (let k = 0; k < half; k++) {
        const t = k * step * (FFT_N / n);
        const wr = cosTable[t];
        const wi = -sinTable[t];
        const a = base + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

// 计算一帧的功率谱（前半），输入时域帧（长度 <= FFT_N），自动加窗补零。
// 复用模块级缓冲，避免逐帧分配（2 小时音频约 72 万帧）。
const scratchRe = new Float64Array(FFT_N);
const scratchIm = new Float64Array(FFT_N);
export function powerSpectrum(
  frame              , offset        , len        , out              ,
)       {
  scratchRe.fill(0);
  scratchIm.fill(0);
  for (let i = 0; i < len; i++) scratchRe[i] = frame[offset + i] * hann[i];
  fft(scratchRe, scratchIm);
  const half = FFT_N / 2;
  for (let i = 0; i < half; i++) {
    out[i] = scratchRe[i] * scratchRe[i] + scratchIm[i] * scratchIm[i];
  }
}

export const FFT_SIZE = FFT_N;

// 线性插值重采样（分析用途足够；2 小时 48k 立体声 -> 16k 单声道时内存有界）。
export function resampleLinear(
  input              , fromRate        , toRate        ,
)               {
  if (fromRate === toRate) return input.slice();
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = input[i0];
    const b = i0 + 1 < input.length ? input[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export function toDb(x        )         {
  return 20 * Math.log10(Math.max(x, 1e-8));
}

export function fromDb(db        )         {
  return Math.pow(10, db / 20);
}

// 流式线性重采样器：跨块保持相位连续，用于解码输出 -> 16kHz 分析率。
export class StreamingResampler {
          ratio        ;
          pos = 0;          // 输入流中的小数位置
          prev = 0;         // 上一块最后一个采样
          hasPrev = false;

  constructor(fromRate        , toRate        ) {
    this.ratio = fromRate / toRate;
  }

  push(input              )               {
    if (input.length === 0) return new Float32Array(0);
    const out           = [];
    let pos = this.pos;
    const get = (i        )         =>
      i < 0 ? this.prev : input[i];
    // pos 是相对于本块起点的位置，可能为负（表示上一块尾部）
    while (pos < input.length - 1) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = get(i0);
      const b = get(i0 + 1);
      out.push(a + (b - a) * frac);
      pos += this.ratio;
    }
    this.prev = input[input.length - 1];
    this.hasPrev = true;
    // 记录到下一块起点时的相位
    this.pos = pos - input.length;
    void this.hasPrev;
    return Float32Array.from(out);
  }
}
