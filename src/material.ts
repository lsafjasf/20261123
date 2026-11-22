// 程序生成测试素材：扫频、持续长音、合成讲话、啸叫注入、混合
// 纯数学渲染到 Float32Array，无任何第三方依赖。

export type MaterialKind = 'sweep' | 'tone' | 'speech' | 'howl' | 'mix';

const TAU = Math.PI * 2;

// 确定性伪随机（mulberry32），保证每次生成的素材一致、可复现
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 线性扫频 100Hz -> 8kHz，恒定幅度（不应触发：电平不增长） */
export function renderSweep(sr: number, seconds: number): Float32Array<ArrayBuffer> {
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  const f0 = 100, f1 = 8000;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f0 + (f1 - f0) * (t / seconds);
    phase += TAU * f / sr;
    out[i] = 0.35 * Math.sin(phase);
  }
  return out;
}

/** 持续长音 880Hz + 轻微颤音，恒定包络（不应触发：无增长） */
export function renderTone(sr: number, seconds: number): Float32Array<ArrayBuffer> {
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const vibrato = 6 * Math.sin(TAU * 5 * t); // ±6Hz, 5Hz 颤音
    phase += TAU * (880 + vibrato) / sr;
    // 起止各 100ms 淡入淡出，中段恒定
    const env = Math.min(1, t / 0.1, (seconds - t) / 0.1);
    out[i] = 0.4 * env * Math.sin(phase);
  }
  return out;
}

/** 合成讲话：音节序列，谐波声源 + 共振峰 + 门控包络（不应触发：宽带、包络起伏） */
export function renderSpeech(sr: number, seconds: number, seed = 7): Float32Array<ArrayBuffer> {
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  const rnd = prng(seed);
  let pos = 0;
  let phase = 0;
  while (pos < n) {
    const sylLen = Math.floor(sr * (0.12 + rnd() * 0.14));
    const gapLen = Math.floor(sr * (0.04 + rnd() * 0.12));
    const f0 = 100 + rnd() * 80;
    const formants = [300 + rnd() * 500, 900 + rnd() * 900, 2200 + rnd() * 800];
    const end = Math.min(n, pos + sylLen);
    for (let i = pos; i < end; i++) {
      const t = (i - pos) / sr;
      const env = Math.sin(Math.PI * (i - pos) / (end - pos)); // 音节包络
      phase += TAU * f0 / sr;
      // 谐波声源 + 气息噪声（真实讲话的宽带底噪，降低单谐波突出度）
      let src = 0.35 * (rnd() * 2 - 1);
      for (let h = 1; h <= 10; h++) src += Math.sin(phase * h) / h;
      // 简化共振峰：在谐波源上叠加共振频率附近的强调
      let v = src * 0.25;
      for (const fm of formants) {
        v += 0.12 * Math.sin(TAU * fm * t) * Math.sin(phase);
      }
      out[i] = (out[i] ?? 0) + 0.5 * env * v;
    }
    pos = end + gapLen;
  }
  // 轻度归一化
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i] ?? 0));
  if (peak > 0.9) for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) * (0.9 / peak);
  return out;
}

/**
 * 啸叫注入：在基底上叠加一个从 startSec 起指数增长的窄带分量，
 * 模拟扩声环路在某频点自激。增长速率约 +5 dB/s，封顶 -6dBFS。
 */
export function addHowl(
  base: Float32Array<ArrayBuffer>, sr: number, freq: number, startSec: number, growthDbPerSec = 5,
): Float32Array<ArrayBuffer> {
  const out = Float32Array.from(base);
  const start = Math.floor(startSec * sr);
  let phase = 0;
  for (let i = start; i < out.length; i++) {
    const t = (i - start) / sr;
    const amp = Math.min(0.5, 0.004 * Math.pow(10, (growthDbPerSec * t) / 20));
    phase += TAU * freq / sr;
    out[i] = Math.max(-1, Math.min(1, (out[i] ?? 0) + amp * Math.sin(phase)));
  }
  return out;
}

/** 混合素材：扫频(0-4s) + 长音(4-8s) + 讲话(8-14s) + 啸叫注入(10s 起, 1250Hz) */
export function renderMix(sr: number): { data: Float32Array<ArrayBuffer>; howlFreq: number } {
  const seconds = 14;
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  const mix = (part: Float32Array, offsetSec: number) => {
    const off = Math.floor(offsetSec * sr);
    for (let i = 0; i < part.length && off + i < n; i++) {
      out[off + i] = (out[off + i] ?? 0) + (part[i] ?? 0);
    }
  };
  mix(renderSweep(sr, 4), 0);
  mix(renderTone(sr, 4), 4);
  mix(renderSpeech(sr, 6.5), 8);
  const howlFreq = 1250;
  const withHowl = addHowl(out, sr, howlFreq, 10, 5);
  return { data: withHowl, howlFreq };
}

export function renderMaterial(kind: MaterialKind, sr: number): { data: Float32Array<ArrayBuffer>; howlFreq: number | null } {
  switch (kind) {
    case 'sweep': return { data: renderSweep(sr, 10), howlFreq: null };
    case 'tone': return { data: renderTone(sr, 8), howlFreq: null };
    case 'speech': return { data: renderSpeech(sr, 10), howlFreq: null };
    case 'howl': {
      const base = renderSpeech(sr, 12);
      return { data: addHowl(base, sr, 1600, 3, 5), howlFreq: 1600 };
    }
    case 'mix': return renderMix(sr);
  }
}
