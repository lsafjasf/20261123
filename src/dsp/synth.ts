// 确定性合成“合唱式”重叠双人语音，用于回归测试。
// 语音模型：谐波叠加（1/h 衰减与双共振峰加权）加音节包络、轻微颤音与气声；
// 笑声模型：4~6 Hz 的短促音节串，带更强气声。全部由种子 PRNG 驱动、可复现，
// 同时输出每条语音的活动掩码作为真值。

export interface VoiceEvent {
  startSec: number;
  durSec: number;
  kind: "syllable" | "laugh";
  f0: number;
  amp: number;
}

export interface SynthScene {
  sampleRate: number;
  /** 两支麦的录音（已含相互串音） */
  trackA: Float32Array;
  trackB: Float32Array;
  /** 真值：每个控制帧（100fps）说话人 A/B 是否发声 */
  activeA: Uint8Array;
  activeB: Uint8Array;
  durationSec: number;
}

// mulberry32：小巧的确定性 PRNG
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FORMANTS = [520, 1450, 2600];
const FORMANT_BW = [110, 160, 220];

function formantWeight(freq: number): number {
  let w = 0.08;
  for (let k = 0; k < FORMANTS.length; k++) {
    const d = (freq - FORMANTS[k]) / FORMANT_BW[k];
    w += Math.exp(-d * d) * (k === 0 ? 1 : 0.55 / k);
  }
  return w;
}

// 渲染一个音节/笑声脉冲到缓冲
function renderSyllable(
  out: Float32Array,
  sampleRate: number,
  startSec: number,
  durSec: number,
  f0: number,
  amp: number,
  rand: () => number,
  breathDb: number,
): void {
  const start = Math.floor(startSec * sampleRate);
  const len = Math.min(out.length - start, Math.floor(durSec * sampleRate));
  if (len <= 0) return;
  const attack = Math.max(1, Math.floor(0.02 * sampleRate));
  const release = Math.max(1, Math.floor(0.06 * sampleRate));
  const phases = new Float64Array(10);
  for (let h = 0; h < phases.length; h++) phases[h] = rand() * Math.PI * 2;
  const breathAmp = amp * Math.pow(10, breathDb / 20);
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    let env = 1;
    if (i < attack) env = i / attack;
    else if (i > len - release) env = Math.max(0, (len - i) / release);
    env = Math.sin(env * Math.PI * 0.5) ** 1.5;
    const vibrato = 1 + 0.02 * Math.sin(2 * Math.PI * 5.2 * t);
    let s = 0;
    for (let h = 1; h <= 10; h++) {
      const freq = f0 * vibrato * h;
      if (freq > sampleRate * 0.45) break;
      phases[h - 1] += (2 * Math.PI * freq) / sampleRate;
      s += (formantWeight(freq) / h) * Math.sin(phases[h - 1]);
    }
    s += breathAmp * (rand() * 2 - 1);
    out[start + i] += s * env * amp;
  }
}

function renderVoice(
  events: VoiceEvent[],
  sampleRate: number,
  totalSamples: number,
  rand: () => number,
): Float32Array {
  const out = new Float32Array(totalSamples);
  const temp = new Float32Array(totalSamples);
  for (const ev of events) {
    temp.fill(0);
    if (ev.kind === "syllable") {
      renderSyllable(temp, sampleRate, ev.startSec, ev.durSec, ev.f0, ev.amp, rand, -26);
    } else {
      // 笑声：一串短促脉冲
      const pulseRate = 4.5 + rand() * 1.5;
      const pulseDur = 0.09;
      const n = Math.floor(ev.durSec * pulseRate);
      for (let k = 0; k < n; k++) {
        const t = ev.startSec + k / pulseRate;
        const a = ev.amp * (0.75 + 0.25 * Math.sin((Math.PI * k) / Math.max(1, n - 1)));
        renderSyllable(temp, sampleRate, t, pulseDur, ev.f0 * 1.15, a, rand, -16);
      }
    }
    // 逐事件响度归一：模拟现场每支领夹麦独立增益调整，
    // 保证每个音节/笑声事件的响度接近（±1.5dB 随机自然起伏）。
    const start = Math.floor(ev.startSec * sampleRate);
    const end = Math.min(totalSamples, Math.ceil((ev.startSec + ev.durSec + 0.1) * sampleRate));
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      sum += temp[i] * temp[i];
      count++;
    }
    const rms = count > 0 ? Math.sqrt(sum / count) : 0;
    if (rms > 1e-9) {
      const targetDb = -22 + (rand() * 2 - 1) * 1.5;
      const g = Math.pow(10, targetDb / 20) / rms;
      for (let i = start; i < end; i++) out[i] += temp[i] * g;
    }
  }
  return out;
}

// 生成“合唱式”重叠剧本：轮流发言、抢话重叠、同时大笑。
function makeScript(rand: () => number, durationSec: number): { a: VoiceEvent[]; b: VoiceEvent[] } {
  const a: VoiceEvent[] = [];
  const b: VoiceEvent[] = [];
  const pushPhrase = (
    list: VoiceEvent[],
    startSec: number,
    f0: number,
    rand: () => number,
  ): number => {
    let t = startSec;
    const syllables = 3 + Math.floor(rand() * 5);
    for (let k = 0; k < syllables; k++) {
      const dur = 0.12 + rand() * 0.18;
      list.push({
        startSec: t,
        durSec: dur,
        kind: "syllable",
        f0: f0 * (0.92 + rand() * 0.2),
        amp: 0.5 + rand() * 0.3,
      });
      t += dur + 0.03 + rand() * 0.08;
    }
    return t;
  };

  let t = 0.4;
  let turn = 0;
  while (t < durationSec - 2.5) {
    const r = rand();
    if (r < 0.3) {
      // 抢话重叠：B 在 A 说到一半时插入（合唱式重叠）
      const endA = pushPhrase(a, t, 110 + rand() * 30, rand);
      const overlapAt = t + (endA - t) * (0.4 + rand() * 0.3);
      pushPhrase(b, overlapAt, 180 + rand() * 40, rand);
      t = endA + 0.5 + rand() * 0.8;
    } else if (r < 0.45) {
      // 同时大笑
      const dur = 0.8 + rand() * 0.9;
      a.push({ startSec: t, durSec: dur, kind: "laugh", f0: 200 + rand() * 60, amp: 0.65 });
      b.push({ startSec: t + rand() * 0.15, durSec: dur * (0.8 + rand() * 0.3), kind: "laugh", f0: 240 + rand() * 60, amp: 0.6 });
      t += dur + 0.6 + rand() * 0.6;
    } else {
      // 单人发言
      const list = turn % 2 === 0 ? a : b;
      const f0 = turn % 2 === 0 ? 110 + rand() * 30 : 180 + rand() * 40;
      t = pushPhrase(list, t, f0, rand) + 0.35 + rand() * 0.7;
    }
    turn++;
  }
  return { a, b };
}

// 由渲染后的干净语音能量生成活动掩码（而非事件时间表），
// 保证真值与实际可听内容一致（笑声脉冲串的尾部静默不算活动）。
function activityMaskFromSignal(voice: Float32Array, sampleRate: number): Uint8Array {
  const fps = 100;
  const hop = Math.round(sampleRate / fps);
  const frames = Math.ceil(voice.length / hop);
  const mask = new Uint8Array(frames);
  const thresh = Math.pow(10, -45 / 20);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    const end = Math.min(start + hop, voice.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += voice[i] * voice[i];
    if (Math.sqrt(sum / Math.max(1, end - start)) > thresh) mask[f] = 1;
  }
  return mask;
}

export interface SynthOptions {
  seed?: number;
  sampleRate?: number;
  durationSec?: number;
  /** 串音电平（dB，负数）：对方语音漏进本麦的增益 */
  bleedDb?: number;
  /** 串音延时（ms），模拟两麦到人嘴的距离差 */
  bleedDelayMs?: number;
}

export function synthScene(opts: SynthOptions = {}): SynthScene {
  const seed = opts.seed ?? 20261123;
  const sampleRate = opts.sampleRate ?? 44100;
  const durationSec = opts.durationSec ?? 24;
  const bleedDb = opts.bleedDb ?? -11;
  const bleedDelayMs = opts.bleedDelayMs ?? 1.2;
  const rand = mulberry32(seed);
  const totalSamples = Math.floor(durationSec * sampleRate);

  const script = makeScript(rand, durationSec);
  const voiceA = renderVoice(script.a, sampleRate, totalSamples, rand);
  const voiceB = renderVoice(script.b, sampleRate, totalSamples, rand);

  // 模拟现场增益调整（gain staging）：两人佩戴各自领夹麦，电平应被
  // 调到接近。把两条语音各自归一到 -20 dBFS RMS，避免合成偏差掩盖算法问题。
  normalizeRms(voiceA, -20);
  normalizeRms(voiceB, -20);

  // 混合串音：trackX = voiceX + g * delayed(voiceY)
  const g = Math.pow(10, bleedDb / 20);
  const delay = Math.round((bleedDelayMs / 1000) * sampleRate);
  const trackA = new Float32Array(totalSamples);
  const trackB = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    const j = i - delay;
    trackA[i] = voiceA[i] + (j >= 0 ? g * voiceB[j] : 0);
    trackB[i] = voiceB[i] + (j >= 0 ? g * voiceA[j] : 0);
  }

  return {
    sampleRate,
    trackA,
    trackB,
    activeA: activityMaskFromSignal(voiceA, sampleRate),
    activeB: activityMaskFromSignal(voiceB, sampleRate),
    durationSec,
  };
}

function normalizeRms(x: Float32Array, targetDb: number): void {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  const rms = Math.sqrt(sum / x.length);
  if (rms <= 0) return;
  const g = Math.pow(10, targetDb / 20) / rms;
  for (let i = 0; i < x.length; i++) x[i] *= g;
}
