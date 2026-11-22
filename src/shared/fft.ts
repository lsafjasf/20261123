export class Fft {
  readonly size: number;
  private readonly rev: Int32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error("FFT size must be a power of two");
    this.size = size;
    const bits = Math.log2(size);
    this.rev = new Int32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let k = 0; k < size / 2; k++) {
      const angle = (-2 * Math.PI * k) / size;
      this.cos[k] = Math.cos(angle);
      this.sin[k] = Math.sin(angle);
    }
  }

  forward(real: Float64Array | Float32Array, imag: Float64Array | Float32Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]!;
      if (j > i) {
        const tr = real[i];
        real[i] = real[j]!;
        real[j] = tr;
        const ti = imag[i];
        imag[i] = imag[j]!;
        imag[j] = ti;
      }
    }
    for (let len = 2; len <= n; len *= 2) {
      const half = len / 2;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step]!;
          const s = this.sin[k * step]!;
          const a = start + k;
          const b = a + half;
          const vr = real[b]! * c - imag[b]! * s;
          const vi = real[b]! * s + imag[b]! * c;
          real[b] = real[a]! - vr;
          imag[b] = imag[a]! - vi;
          real[a] = real[a]! + vr;
          imag[a] = imag[a]! + vi;
        }
      }
    }
  }

  inverse(real: Float64Array | Float32Array, imag: Float64Array | Float32Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) imag[i] = -imag[i]!;
    this.forward(real, imag);
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      real[i] = real[i]! * inv;
      imag[i] = -imag[i]! * inv;
    }
  }
}

export function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(2, value)));
}
