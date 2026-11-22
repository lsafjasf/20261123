// AudioWorklet 处理链：降噪(谱减法) / 清晰度(临场感EQ) / 限峰(前视限幅器)
// 顺序、旁路、参数全部由主线程通过 port 消息下发，本处理器常驻不重建，
// 因此输入设备断开重连不会造成链状态错位。

type ProcId = 'nr' | 'clarity' | 'limiter';

interface ChainConfig {
  order: ProcId[];
  bypass: Record<ProcId, boolean>;
  params: {
    nr: { strength: number };      // 0..1
    clarity: { amount: number };   // 0..1
    limiter: { ceiling: number };  // 线性 0.5..1
  };
}

// ---------- 迭代基-2 FFT ----------
class FFT {
  size: number;
  cos: Float32Array;
  sin: Float32Array;
  rev: Uint32Array;
  constructor(size: number) {
    this.size = size;
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    let bits = 0;
    while ((1 << bits) < size) bits++;
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }
  // 就地变换，inverse=true 时做逆变换并除以 N
  run(re: Float32Array, im: Float32Array, inverse: boolean): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          // 旋转因子查表：tw = k*step，范围 [0, n/2)
          const tw = k * step;
          const wr = this.cos[tw];
          let wi = this.sin[tw];
          if (inverse) wi = -wi;
          const a = i + k;
          const b = i + k + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }
}

// ---------- 双二阶滤波器（Direct Form I） ----------
class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  setPeak(freq: number, q: number, gainDb: number, sr: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * freq) / sr;
    const alpha = Math.sin(w0) / (2 * q);
    const c = Math.cos(w0);
    const a0 = 1 + alpha / A;
    this.b0 = (1 + alpha * A) / a0;
    this.b1 = (-2 * c) / a0;
    this.b2 = (1 - alpha * A) / a0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - alpha / A) / a0;
  }
  setHighShelf(freq: number, gainDb: number, sr: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * freq) / sr;
    const c = Math.cos(w0);
    const s = Math.sin(w0);
    const alpha = s / 2 * Math.sqrt((A + 1 / A) * (1 / 0.9 - 1) + 2);
    const sq = 2 * Math.sqrt(A) * alpha;
    const a0 = (A + 1) - (A - 1) * c + sq;
    this.b0 = (A * ((A + 1) + (A - 1) * c + sq)) / a0;
    this.b1 = (-2 * A * ((A - 1) + (A + 1) * c)) / a0;
    this.b2 = (A * ((A + 1) + (A - 1) * c - sq)) / a0;
    this.a1 = (2 * ((A - 1) - (A + 1) * c)) / a0;
    this.a2 = ((A + 1) - (A - 1) * c - sq) / a0;
  }
  setHighPass(freq: number, sr: number): void {
    const w0 = (2 * Math.PI * freq) / sr;
    const alpha = Math.sin(w0) / (2 * 0.7071);
    const c = Math.cos(w0);
    const a0 = 1 + alpha;
    this.b0 = ((1 + c) / 2) / a0;
    this.b1 = (-(1 + c)) / a0;
    this.b2 = ((1 + c) / 2) / a0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
      - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// ---------- 降噪：谱减法 + 最小值统计噪声估计 ----------
// 1024 点 FFT、50% 重叠 Hann 窗。噪声幅度谱用非对称平滑的最小值跟踪估计，
// 对近似平稳的背景噪声（风扇、空调、电流声）有效。
class NoiseReducer {
  static N = 512;
  static HOP = 256;
  fft = new FFT(NoiseReducer.N);
  win = new Float32Array(NoiseReducer.N);
  inBuf = new Float32Array(NoiseReducer.N);
  outBuf = new Float32Array(NoiseReducer.N);
  re = new Float32Array(NoiseReducer.N);
  im = new Float32Array(NoiseReducer.N);
  noiseMag = new Float32Array(NoiseReducer.N / 2).fill(1e-4);
  minTrack = new Float32Array(NoiseReducer.N / 2).fill(1e9);
  minAge = new Uint16Array(NoiseReducer.N / 2);
  inPos = 0;
  fifo = new Float32Array(NoiseReducer.HOP);
  fifoHead = 0;
  fifoLen = 0;
  strength = 0.6;

  constructor() {
    const N = NoiseReducer.N;
    for (let i = 0; i < N; i++) {
      this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    }
  }

  // 返回本模块引入的延迟（采样数）
  latencySamples(): number {
    return NoiseReducer.N;
  }

  processSample(x: number): number {
    const N = NoiseReducer.N;
    const HOP = NoiseReducer.HOP;
    this.inBuf[this.inPos++] = x;
    if (this.inPos === N) {
      this.processFrame();
      // 本帧已确定的 HOP 个输出采样进入 FIFO
      for (let i = 0; i < HOP; i++) this.fifo[i] = this.outBuf[i];
      this.fifoHead = 0;
      this.fifoLen = HOP;
      // 输入/输出窗各滑动 HOP
      this.inBuf.copyWithin(0, HOP);
      this.inPos = N - HOP;
      this.outBuf.copyWithin(0, HOP);
      this.outBuf.fill(0, N - HOP);
    }
    if (this.fifoLen > 0) {
      const y = this.fifo[this.fifoHead++];
      if (this.fifoHead === this.fifoLen) this.fifoLen = 0;
      return y;
    }
    return 0; // 启动阶段首帧未就绪，输出静音
  }

  processFrame(): void {
    const N = NoiseReducer.N;
    const half = N / 2;
    for (let i = 0; i < N; i++) {
      this.re[i] = this.inBuf[i] * this.win[i];
      this.im[i] = 0;
    }
    this.fft.run(this.re, this.im, false);
    const overSub = 1 + this.strength * 3;   // 过减因子 1..4
    const floor = 0.05;                       // 谱减下限，抑制音乐噪声
    for (let k = 0; k < half; k++) {
      const mag = Math.hypot(this.re[k], this.im[k]);
      // 最小值统计：约 1.5 秒窗口内跟踪各频点最小幅度
      if (mag < this.minTrack[k]) {
        this.minTrack[k] = mag;
        this.minAge[k] = 0;
      } else if (++this.minAge[k] > 280) { // 约 1.5 秒（256/48000*280）
        this.minTrack[k] = mag;
        this.minAge[k] = 0;
      }
      // 噪声估计向最小值缓慢收敛
      this.noiseMag[k] += (this.minTrack[k] - this.noiseMag[k]) * 0.2;
      const gain = Math.max(floor, 1 - (overSub * this.noiseMag[k]) / (mag + 1e-9));
      this.re[k] *= gain;
      this.im[k] *= gain;
      // 共轭对称
      if (k > 0) {
        this.re[N - k] = this.re[k];
        this.im[N - k] = -this.im[k];
      }
    }
    this.fft.run(this.re, this.im, true);
    // 重叠相加，Hann 窗 50% 重叠的 COLA 补偿系数 2/3
    for (let i = 0; i < N; i++) {
      this.outBuf[i] += this.re[i] * this.win[i] * (2 / 3);
    }
  }
}

// ---------- 清晰度：低切 + 临场感峰 + 空气感高架 ----------
// 提升 3.2kHz 附近的语音临场感与 7.5kHz 以上的空气感，并切除低频轰鸣。
class Clarity {
  lowCut = new Biquad();
  presence = new Biquad();
  air = new Biquad();
  amount = -1; // 强制首次更新系数

  update(amount: number, sr: number): void {
    if (amount === this.amount) return;
    this.amount = amount;
    this.lowCut.setHighPass(80, sr);
    this.presence.setPeak(3200, 1.1, amount * 9, sr);
    this.air.setHighShelf(7500, amount * 6, sr);
  }

  processSample(x: number): number {
    return this.air.process(this.presence.process(this.lowCut.process(x)));
  }
}

// ---------- 限峰：前视峰值限幅器 ----------
// 128 采样前视（48kHz 下约 2.7ms）保证攻击瞬间不溢出，释放约 80ms。
class Limiter {
  static LOOKAHEAD = 128;
  delay = new Float32Array(Limiter.LOOKAHEAD);
  pos = 0;
  env = 1;
  ceiling = 0.89; // 约 -1dBFS
  releaseCoef = 0;

  update(sr: number): void {
    this.releaseCoef = Math.exp(-1 / (0.08 * sr));
  }

  latencySamples(): number {
    return Limiter.LOOKAHEAD;
  }

  processSample(x: number): number {
    // 前视：当前采样入延迟线，用其峰值提前收敛包络
    const peak = Math.abs(x);
    const need = peak > this.ceiling ? this.ceiling / peak : 1;
    if (need < this.env) {
      this.env = need; // 攻击：立即（靠前视掩盖）
    } else {
      this.env = need + (this.env - need) * this.releaseCoef;
    }
    const y = this.delay[this.pos] * this.env;
    this.delay[this.pos] = x;
    this.pos = (this.pos + 1) % Limiter.LOOKAHEAD;
    return y;
  }
}

// ---------- 链处理器：按可配置顺序串联各模块 ----------
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage(msg: unknown): void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

class ChainProcessor extends AudioWorkletProcessor {
  nr = new NoiseReducer();
  clarity = new Clarity();
  limiter = new Limiter();
  order: ProcId[] = ['nr', 'clarity', 'limiter'];
  bypass: Record<ProcId, boolean> = { nr: false, clarity: false, limiter: false };

  constructor() {
    super();
    this.limiter.update(sampleRate);
    this.clarity.update(0.5, sampleRate);
    this.port.onmessage = (e) => {
      const msg = e.data as { type: string; config?: ChainConfig };
      if (msg.type !== 'config' || !msg.config) return;
      const c = msg.config;
      this.order = c.order.slice();
      this.bypass = { ...c.bypass };
      this.nr.strength = c.params.nr.strength;
      this.clarity.update(c.params.clarity.amount, sampleRate);
      this.limiter.ceiling = c.params.limiter.ceiling;
      this.reportLatency();
    };
    this.reportLatency();
  }

  reportLatency(): void {
    // 只统计当前启用模块的延迟
    let samples = 0;
    for (const id of this.order) {
      if (this.bypass[id]) continue;
      if (id === 'nr') samples += this.nr.latencySamples();
      if (id === 'limiter') samples += this.limiter.latencySamples();
    }
    this.port.postMessage({ type: 'latency', samples });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    for (let i = 0; i < output.length; i++) {
      let x = input ? input[i] : 0;
      for (const id of this.order) {
        if (this.bypass[id]) continue;
        if (id === 'nr') x = this.nr.processSample(x);
        else if (id === 'clarity') x = this.clarity.processSample(x);
        else x = this.limiter.processSample(x);
      }
      output[i] = x;
    }
    // 多声道输出时复制单声道结果
    for (let ch = 1; ch < outputs[0].length; ch++) {
      outputs[0][ch].set(output);
    }
    return true;
  }
}

registerProcessor('chain-processor', ChainProcessor);
