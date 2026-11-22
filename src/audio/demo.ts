/**
 * 内置 demo 素材合成：一条带鼓点重拍的“音乐轨” + 几段模拟说话，
 * 让用户无需导入任何文件即可体验节拍切点与语音保护全流程。
 */

import type { Clip, SegmentWeight, SpeechSpan } from "../core/types.ts";
import { encodeWav, mixInto } from "./wav.ts";

export interface DemoTrack {
  sampleRate: number;
  durationSec: number;
  bpm: number;
  wav: Uint8Array;
  /** 合成时写入的真实说话区间（用于测试核对检测结果）。 */
  speechTruth: SpeechSpan[];
  clips: Clip[];
}

const SAMPLE_RATE = 44100;
const BPM = 112;

function sine(freq: number, seconds: number, sampleRate: number): Float32Array {
  const length = Math.round(seconds * sampleRate);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

function envelopeDecay(length: number, decaySamples: number): Float32Array {
  const env = new Float32Array(length);
  for (let i = 0; i < length; i++) env[i] = Math.exp(-i / decaySamples);
  return env;
}

function kick(seconds: number, sampleRate: number): Float32Array {
  const length = Math.round(seconds * sampleRate);
  const out = new Float32Array(length);
  const env = envelopeDecay(length, sampleRate * 0.06);
  for (let i = 0; i < length; i++) {
    const freq = 120 * Math.exp(-i / (sampleRate * 0.03)) + 45;
    out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * env[i];
  }
  return out;
}

function hat(seconds: number, sampleRate: number): Float32Array {
  const length = Math.round(seconds * sampleRate);
  const out = new Float32Array(length);
  const env = envelopeDecay(length, sampleRate * 0.012);
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let i = 0; i < length; i++) out[i] = rand() * env[i] * 0.5;
  return out;
}

/** 模拟说话：带调幅的共振峰信号 + 音节起伏，能量明显高于底噪。 */
function voiced(seconds: number, sampleRate: number): Float32Array {
  const length = Math.round(seconds * sampleRate);
  const out = new Float32Array(length);
  const syllableHz = 4.2;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const syllable = 0.55 + 0.45 * Math.abs(Math.sin(2 * Math.PI * syllableHz * t));
    const formant =
      Math.sin(2 * Math.PI * 180 * t) * 0.6 +
      Math.sin(2 * Math.PI * 620 * t) * 0.25 +
      Math.sin(2 * Math.PI * 980 * t) * 0.15;
    const fade = Math.min(1, t * 12, (seconds - t) * 12);
    out[i] = formant * syllable * Math.max(0, fade) * 0.5;
  }
  return out;
}

const CLIP_DEFS: { name: string; duration: number; weight: SegmentWeight }[] = [
  { name: "出发机场", duration: 4.2, weight: "strong" },
  { name: "云层飞行", duration: 3.4, weight: "normal" },
  { name: "海边公路", duration: 4.8, weight: "strong" },
  { name: "市集漫步", duration: 3.9, weight: "weak" },
  { name: "山顶日落", duration: 5.1, weight: "strong" },
  { name: "夜市烟火", duration: 3.6, weight: "normal" },
  { name: "篝火对话", duration: 4.5, weight: "weak" },
  { name: "归途车窗", duration: 4.0, weight: "normal" },
];

export function buildDemoTrack(): DemoTrack {
  const totalDuration = CLIP_DEFS.reduce((sum, clip) => sum + clip.duration, 0);
  const totalSamples = Math.round(totalDuration * SAMPLE_RATE);
  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);
  const beat = 60 / BPM;

  // 鼓点：每拍 hat，每小节首拍 kick（4/4 拍）。
  for (let bar = 0, time = 0; time < totalDuration; bar++, time += beat * 4) {
    for (let b = 0; b < 4 && time + b * beat < totalDuration; b++) {
      const hitTime = time + b * beat;
      const start = Math.round(hitTime * SAMPLE_RATE);
      const drum = b === 0 ? kick(0.22, SAMPLE_RATE) : hat(0.08, SAMPLE_RATE);
      const bass = b === 0 ? sine(55, 0.28, SAMPLE_RATE) : new Float32Array(0);
      const bassEnv = envelopeDecay(bass.length, SAMPLE_RATE * 0.08);
      for (let i = 0; i < bass.length; i++) bass[i] *= bassEnv[i] * 0.4;
      mixInto(left, drum, start, 0.9);
      mixInto(right, drum, start, 0.9);
      mixInto(left, bass, start, 0.8);
      mixInto(right, bass, start, 0.8);
    }
  }

  // 两段“人物说话”，刻意跨越自然切点，用来验证拦腰切断检测。
  const speechTruth: SpeechSpan[] = [
    { start: 5.0, end: 7.6, level: 0.5 },
    { start: 17.2, end: 20.4, level: 0.5 },
  ];
  for (const span of speechTruth) {
    const voice = voiced(span.end - span.start, SAMPLE_RATE);
    const start = Math.round(span.start * SAMPLE_RATE);
    mixInto(left, voice, start, 1);
    mixInto(right, voice, start, 0.92);
  }

  // 极轻的底噪，让 VAD 噪声底估计有东西可比。
  let seed = 777;
  const rand = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
  for (let i = 0; i < totalSamples; i++) {
    const noise = rand() * 0.004;
    left[i] = Math.max(-1, Math.min(1, left[i] + noise));
    right[i] = Math.max(-1, Math.min(1, right[i] + noise));
  }

  const clips: Clip[] = [];
  let cursor = 0;
  CLIP_DEFS.forEach((def, index) => {
    clips.push({
      id: `clip-${index + 1}`,
      name: def.name,
      start: cursor,
      duration: def.duration,
      weight: def.weight,
      source: { sourceId: `demo-${index + 1}`, inPoint: 0 },
    });
    cursor += def.duration;
  });

  return {
    sampleRate: SAMPLE_RATE,
    durationSec: totalDuration,
    bpm: BPM,
    wav: encodeWav({ channels: [left, right], sampleRate: SAMPLE_RATE }),
    speechTruth,
    clips,
  };
}
