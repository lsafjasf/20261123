// 流式分帧特征提取：喂入 16kHz 单声道 PCM 块，逐 10ms 帧产出特征。
// 只保留特征（每帧约 20 字节），PCM 用完即弃 —— 2 小时录音内存有界。
import { FFT_SIZE, powerSpectrum } from './dsp.js';
import type { FrameFeatures } from './types.js';

export const ANALYSIS_RATE = 16000;
export const HOP = 160;        // 10ms
export const WIN = 400;        // 25ms
const CLIP_LEVEL = 0.98;

export class FeatureExtractor {
  private carry = new Float32Array(WIN);  // 跨块保留 WIN-HOP 个采样
  private carryLen = 0;
  private prevSample = 0;
  private rms: number[] = [];
  private peak: number[] = [];
  private maxJump: number[] = [];
  private clipCount: number[] = [];
  private flatness: number[] = [];
  private centroid: number[] = [];
  private spectrum = new Float64Array(FFT_SIZE / 2);

  // 喂入一段 16kHz 单声道采样。
  push(samples: Float32Array): void {
    let pos = 0;
    while (pos < samples.length) {
      const need = WIN - this.carryLen;
      const take = Math.min(need, samples.length - pos);
      this.carry.set(samples.subarray(pos, pos + take), this.carryLen);
      this.carryLen += take;
      pos += take;
      if (this.carryLen === WIN) {
        this.emitFrame();
        // 帧有重叠：下一帧首采样的“前一个采样”是本帧第 HOP-1 个采样
        this.prevSample = this.carry[HOP - 1];
        // 帧移 HOP：保留尾部 WIN-HOP 个采样
        this.carry.copyWithin(0, HOP, WIN);
        this.carryLen = WIN - HOP;
      }
    }
  }

  private emitFrame(): void {
    const f = this.carry;
    let sumSq = 0;
    let peak = 0;
    let maxJump = 0;
    let clips = 0;
    let prev = this.prevSample;
    for (let i = 0; i < WIN; i++) {
      const x = f[i];
      const ax = Math.abs(x);
      sumSq += x * x;
      if (ax > peak) peak = ax;
      const jump = Math.abs(x - prev);
      if (jump > maxJump) maxJump = jump;
      if (ax >= CLIP_LEVEL) clips++;
      prev = x;
    }
    this.rms.push(Math.sqrt(sumSq / WIN));
    this.peak.push(peak);
    this.maxJump.push(maxJump);
    this.clipCount.push(clips);

    powerSpectrum(f, 0, WIN, this.spectrum);
    const spec = this.spectrum;
    const n = spec.length;
    let sum = 0;
    let logSum = 0;
    let weighted = 0;
    for (let i = 1; i < n; i++) {   // 跳过 DC
      const p = spec[i] + 1e-12;
      sum += p;
      logSum += Math.log(p);
      weighted += p * i;
    }
    const bins = n - 1;
    const arith = sum / bins;
    const geo = Math.exp(logSum / bins);
    this.flatness.push(arith > 0 ? Math.min(1, geo / arith) : 0);
    this.centroid.push(sum > 0 ? weighted / sum / n : 0);
  }

  finish(): FrameFeatures {
    return {
      rate: ANALYSIS_RATE,
      hopSec: HOP / ANALYSIS_RATE,
      count: this.rms.length,
      rms: Float32Array.from(this.rms),
      peak: Float32Array.from(this.peak),
      maxJump: Float32Array.from(this.maxJump),
      clipCount: Uint16Array.from(this.clipCount),
      flatness: Float32Array.from(this.flatness),
      centroid: Float32Array.from(this.centroid),
    };
  }
}
