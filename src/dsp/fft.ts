// Iterative radix-2 FFT over interleaved re/im arrays. Pure TypeScript, no deps.

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new Error("fft: length must be a power of two");
  }
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
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j;
        const b = a + half;
        const vr = re[b] * cwr - im[b] * cwi;
        const vi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

// FFT-based linear convolution (full length a.length + b.length - 1).
export function convolve(a: Float32Array, b: Float32Array): Float32Array {
  const n = nextPow2(a.length + b.length - 1);
  const are = new Float64Array(n);
  const aim = new Float64Array(n);
  const bre = new Float64Array(n);
  const bim = new Float64Array(n);
  are.set(a);
  bre.set(b);
  fft(are, aim, false);
  fft(bre, bim, false);
  for (let i = 0; i < n; i++) {
    const tr = are[i] * bre[i] - aim[i] * bim[i];
    aim[i] = are[i] * bim[i] + aim[i] * bre[i];
    are[i] = tr;
  }
  fft(are, aim, true);
  const out = new Float32Array(a.length + b.length - 1);
  for (let i = 0; i < out.length; i++) out[i] = are[i];
  return out;
}
