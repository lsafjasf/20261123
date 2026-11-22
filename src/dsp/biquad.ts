export interface BiquadCoeffs {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

export function lowpass(fs: number, fc: number, q: number): BiquadCoeffs {
  const w0 = 2 * Math.PI * fc / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cosw) / 2 / a0,
    b1: (1 - cosw) / a0,
    b2: (1 - cosw) / 2 / a0,
    a1: -2 * cosw / a0,
    a2: (1 - alpha) / a0,
  };
}

export function highpass(fs: number, fc: number, q: number): BiquadCoeffs {
  const w0 = 2 * Math.PI * fc / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cosw) / 2 / a0,
    b1: -(1 + cosw) / a0,
    b2: (1 + cosw) / 2 / a0,
    a1: -2 * cosw / a0,
    a2: (1 - alpha) / a0,
  };
}

export function highshelf(fs: number, fc: number, gainDb: number, s: number): BiquadCoeffs {
  const a = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * fc / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / 2 * Math.sqrt((a + 1 / a) * (1 / s - 1) + 2);
  const sq = 2 * Math.sqrt(a) * alpha;
  const a0 = (a + 1) - (a - 1) * cosw + sq;
  return {
    b0: a * ((a + 1) + (a - 1) * cosw + sq) / a0,
    b1: -2 * a * ((a - 1) + (a + 1) * cosw) / a0,
    b2: a * ((a + 1) + (a - 1) * cosw - sq) / a0,
    a1: 2 * ((a - 1) - (a + 1) * cosw) / a0,
    a2: ((a + 1) - (a - 1) * cosw - sq) / a0,
  };
}

export class Biquad {
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  c: BiquadCoeffs;
  constructor(c: BiquadCoeffs) { this.c = c; }
  reset(): void { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  process(x: number): number {
    const c = this.c;
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
  processBlock(input: Float32Array, output: Float32Array): void {
    for (let i = 0; i < input.length; i++) output[i] = this.process(input[i]);
  }
}

export function filterBlock(c: BiquadCoeffs, input: Float32Array, output: Float32Array): void {
  new Biquad(c).processBlock(input, output);
}
