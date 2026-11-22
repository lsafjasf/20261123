// 四类取证特征，流式逐帧计算（不缓存完整谱图，长录音内存可控），
// 输出"逐帧"连续曲线，供检测层做稳健评分。全部基于原始 PCM，无降噪。
import { fft, hannWindow } from "./dsp.ts";

export interface FeatureSet {
  times: Float32Array;
  rms: Float32Array;
  noiseFloorDb: Float32Array;     // 每帧底噪电平估计（dB）
  floorStep: Float64Array;        // 底噪阶跃：前后窗中位数差
  phaseBreak: Float64Array;       // 相位断裂：相位声码器偏差能量
  sampleJump: Float64Array;       // 样本级跳变（原始 PCM 一阶差分局部峰值）
  dcStep: Float64Array;           // 直流偏置阶跃
  repeatScore: Float64Array;      // 短时重复：底噪指纹与他处的最大相关
  repeatPartner: Int32Array;      // 重复来源帧号（-1 表示无）
  sampleRate: number;
  hop: number;
}

const EPS = 1e-12;
const FRAME = 2048;
const HOP = 512;
const BANDS = 24;
const MAX_FP = 3000; // 指纹数量上限，超出按步长抽稀，控制 O(n^2) 比对成本

function windowMedian(x: ArrayLike<number>, a: number, b: number): number {
  const lo = Math.max(0, a), hi = Math.min(x.length, b);
  if (hi <= lo) return NaN;
  const seg = Float64Array.from({ length: hi - lo }, (_, i) => x[lo + i]).sort();
  const n = seg.length;
  return n % 2 ? seg[(n - 1) / 2] : (seg[n / 2 - 1] + seg[n / 2]) / 2;
}

export function computeFeatures(pcm: Float32Array, sampleRate: number): FeatureSet {
  const nF = Math.max(0, Math.floor((pcm.length - FRAME) / HOP) + 1);
  const half = FRAME / 2;
  const win = hannWindow(FRAME);
  const times = new Float32Array(nF);
  const rms = new Float32Array(nF);
  const floorDb = new Float32Array(nF);
  const phaseBreak = new Float64Array(nF);
  const fps = sampleRate / HOP;
  const expected = (2 * Math.PI * HOP) / FRAME;

  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  const prevPhase = new Float32Array(half);
  const prevMag = new Float32Array(half);
  const mag = new Float32Array(half);
  const ph = new Float32Array(half);
  const sorted = new Float32Array(half);
  const bandW = Math.max(1, Math.floor(half / BANDS));
  const stride = Math.max(1, Math.ceil(nF / MAX_FP));
  const fpIdx: number[] = [];
  const fpVecs: Float64Array[] = [];

  for (let f = 0; f < nF; f++) {
    const off = f * HOP;
    let acc = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = pcm[off + i];
      re[i] = s * win[i];
      im[i] = 0;
      acc += s * s;
    }
    rms[f] = Math.sqrt(acc / FRAME);
    times[f] = (off + FRAME / 2) / sampleRate;
    fft(re, im);
    for (let k = 0; k < half; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      ph[k] = Math.atan2(im[k], re[k]);
      sorted[k] = mag[k];
    }
    sorted.sort();
    floorDb[f] = 20 * Math.log10(sorted[Math.floor(half * 0.2)] + EPS);
    if (f > 0) {
      let num = 0, den = 0;
      for (let k = 1; k < half; k++) {
        let d = ph[k] - prevPhase[k] - expected * k;
        d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
        const w = Math.min(mag[k], prevMag[k]);
        num += w * Math.abs(d);
        den += w;
      }
      phaseBreak[f] = den > EPS ? num / den : 0;
    }
    prevPhase.set(ph);
    prevMag.set(mag);
    if (f % stride === 0) {
      const v = new Float64Array(BANDS);
      for (let b = 0; b < BANDS; b++) {
        let s = 0;
        for (let k = b * bandW; k < (b + 1) * bandW && k < half; k++) s += Math.log(mag[k] + EPS);
        v[b] = s / bandW;
      }
      let mean = 0;
      for (const x of v) mean += x;
      mean /= BANDS;
      let norm = 0;
      for (let b = 0; b < BANDS; b++) { v[b] -= mean; norm += v[b] * v[b]; }
      norm = Math.sqrt(norm) || 1;
      for (let b = 0; b < BANDS; b++) v[b] /= norm;
      fpIdx.push(f);
      fpVecs.push(v);
    }
  }

  // 底噪阶跃：前后各 0.5s 窗的中位数差
  const winF = Math.round(0.5 * fps);
  const floorStep = new Float64Array(nF);
  for (let f = 0; f < nF; f++) {
    const before = windowMedian(floorDb, f - winF, f - 1);
    const after = windowMedian(floorDb, f + 1, f + winF);
    floorStep[f] = Number.isFinite(before) && Number.isFinite(after) ? Math.abs(after - before) : 0;
  }

  // 样本级跳变与直流阶跃（直接在原始 PCM 上）
  const jump = new Float64Array(nF);
  const dc = new Float64Array(nF);
  const span = FRAME / 4;
  for (let f = 0; f < nF; f++) {
    const c = Math.round(times[f] * sampleRate);
    let peak = 0;
    for (let i = Math.max(1, c - span); i < Math.min(pcm.length, c + span); i++) {
      const d = Math.abs(pcm[i] - pcm[i - 1]);
      if (d > peak) peak = d;
    }
    jump[f] = peak;
    let s1 = 0, s2 = 0, n1 = 0, n2 = 0;
    for (let i = Math.max(0, c - span); i < c; i++) { s1 += pcm[i]; n1++; }
    for (let i = c; i < Math.min(pcm.length, c + span); i++) { s2 += pcm[i]; n2++; }
    dc[f] = n1 && n2 ? Math.abs(s2 / n2 - s1 / n1) : 0;
  }

  // 短时重复：仅在低能帧指纹间比对，时间间隔 >2s
  const floorSorted = Float32Array.from(floorDb).sort();
  const floorMed = floorSorted[Math.floor(nF * 0.6)];
  const quietFp: number[] = [];
  for (let i = 0; i < fpIdx.length; i++) {
    if (floorDb[fpIdx[i]] <= floorMed) quietFp.push(i);
  }
  const minGap = Math.round(2 * fps);
  const repeatScore = new Float64Array(nF);
  const repeatPartner = new Int32Array(nF).fill(-1);
  for (let a = 0; a < quietFp.length; a++) {
    for (let b = a + 1; b < quietFp.length; b++) {
      const fa = fpIdx[quietFp[a]], fb = fpIdx[quietFp[b]];
      if (fb - fa < minGap) continue;
      const va = fpVecs[quietFp[a]], vb = fpVecs[quietFp[b]];
      let dot = 0;
      for (let k = 0; k < BANDS; k++) dot += va[k] * vb[k];
      if (dot > repeatScore[fa]) { repeatScore[fa] = dot; repeatPartner[fa] = fb; }
      if (dot > repeatScore[fb]) { repeatScore[fb] = dot; repeatPartner[fb] = fa; }
    }
  }

  return {
    times, rms,
    noiseFloorDb: floorDb,
    floorStep,
    phaseBreak,
    sampleJump: jump,
    dcStep: dc,
    repeatScore,
    repeatPartner,
    sampleRate,
    hop: HOP,
  };
}
