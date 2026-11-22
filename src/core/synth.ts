/**
 * 确定性碰撞音色合成。
 * 每个发声体（Voice）在创建时用 (mixerSeed, eventId, family) 派生私有 RNG，
 * 一次性决定失谐、颗粒、共振频率等参数；逐样本渲染阶段不再取随机数，
 * 因此同样的 seed + 事件流必然得到逐位一致的采样输出。
 */

import { Rng, hash32, hashString } from './rng.ts';
import {
  MATERIAL_FAMILY,
  Priority,
  SAMPLE_RATE,
  clamp,
  velocityToBrightness,
  velocityToGain,
  type CollisionEvent,
  type MaterialId,
  type TimbreFamily,
} from './types.ts';

interface Mode {
  freq: number;
  amp: number;
  decay: number; // 秒
  phase: number;
}

interface VoiceParams {
  family: TimbreFamily;
  material: MaterialId;
  priority: Priority;
  eventId: number;
  startSample: number;
  gain: number;
  pan: number;
  attack: number;
  decay: number;
  modes: Mode[];
  noiseAmp: number;
  noiseDecay: number;
  noiseFilter: number; // 一阶低通系数 0..1
  formant: number;
  danger: boolean;
}

export class Voice {
  readonly params: VoiceParams;
  private age = 0;
  private noiseState: number;
  private lfoPhase = 0;
  private env = 0;
  private noiseFilterMem = 0;
  finished = false;

  constructor(params: VoiceParams, initialNoiseState: number) {
    this.params = params;
    this.noiseState = initialNoiseState | 0;
  }

 get family(): TimbreFamily {
    return this.params.family;
  }

  get priority(): Priority {
    return this.params.priority;
  }

  get eventId(): number {
    return this.params.eventId;
  }

  get startSample(): number {
    return this.params.startSample;
  }

  /** 渲染一个样本，返回 [左, 右]；到达寿命后返回 0 并标记 finished */
  renderSample(): [number, number] {
    const p = this.params;
    if (this.age >= (p.attack + p.decay) * SAMPLE_RATE) {
      this.finished = true;
      return [0, 0];
    }
    const t = this.age / SAMPLE_RATE;
    this.age++;

    // 两段包络：线性 attack（体声起振）+ 指数 decay
    let env: number;
    if (t < p.attack) {
      env = t / p.attack;
    } else {
      const dt = (t - p.attack) / p.decay;
      env = Math.exp(-dt * 4.6);
    }
    this.env = env;

    let tone = 0;
    for (const mode of p.modes) {
      mode.phase += (2 * Math.PI * mode.freq) / SAMPLE_RATE;
      const decayEnv = Math.exp((-t * 4.6) / mode.decay);
      tone += Math.sin(mode.phase) * mode.amp * decayEnv;
    }

    // 确定性噪声：线性同余，逐样本推进但状态完全由初始状态决定
    let noise = 0;
    if (p.noiseAmp > 0) {
      this.noiseState =
        (Math.imul(this.noiseState, 1664525) + 1013904223) | 0;
      const white = this.noiseState / 2147483648;
      // 一阶低通，控制噪声亮度
      this.noiseFilterMem =
        this.noiseFilterMem + p.noiseFilter * (white - this.noiseFilterMem);
      noise =
        this.noiseFilterMem *
        p.noiseAmp *
        Math.exp((-t * 4.6) / Math.max(p.noiseDecay, 1e-4));
    }

    let signal = (tone + noise) * env * p.gain;

    // 对话/危险提示：共振峰调制，和物理撞击声明显区分
    if (p.family === 'voice') {
      this.lfoPhase += (2 * Math.PI * (p.danger ? 7.5 : 5.2)) / SAMPLE_RATE;
      const formant = 1 + 0.12 * Math.sin(this.lfoPhase);
      signal *= formant;
    }

    // 等功率声像
    const angle = (clamp(p.pan, -1, 1) * Math.PI) / 4;
    const left = signal * Math.cos(angle);
    const right = signal * Math.sin(angle);
    return [left, right];
  }

  isFinished(): boolean {
    return this.finished;
  }

  /** 当前包络值，供调度器做“可抢占”判断 */
  currentEnv(): number {
    return this.env;
  }
}

export function createVoice(
  event: CollisionEvent,
  mixerSeed: number,
  startSample: number,
): Voice {
  const family =
    event.priority >= Priority.Danger
      ? ('voice' as TimbreFamily)
      : MATERIAL_FAMILY[event.material];
  const seed = hash32(mixerSeed, event.id | 0, hashString(family));
  const rng = new Rng(seed);
  const gain = velocityToGain(event.speed);
  const brightness = velocityToBrightness(event.speed);
  const builder = BUILDERS[family](rng, brightness);
  return new Voice({
    family,
    material: event.material,
    priority: event.priority,
    eventId: event.id,
    startSample,
    gain,
    pan: event.pan,
    danger: event.priority === Priority.Danger,
    ...builder,
  }, rng.nextU32() | 1);
}

interface BuilderResult {
  attack: number;
  decay: number;
  modes: Mode[];
  noiseAmp: number;
  noiseDecay: number;
  noiseFilter: number;
  formant: number;
}

type Builder = (rng: Rng, brightness: number) => BuilderResult;

function makeModes(
  rng: Rng,
  base: number,
  partials: Array<[number, number, number]>,
  detune: number,
): Mode[] {
  return partials.map(([ratio, amp, decay]) => ({
    freq: base * ratio * (1 + rng.range(-detune, detune)),
    amp,
    decay,
    phase: rng.range(0, Math.PI * 2),
  }));
}

const BUILDERS: Record<TimbreFamily, Builder> = {
  metal: (rng, b) => ({
    attack: 0.001,
    decay: 0.55 + rng.range(0, 0.35),
    modes: makeModes(
      rng,
      2200 + rng.range(-180, 240),
      [
        [1, 0.5, 0.5],
        [2.76, 0.34, 0.4],
        [5.07, 0.22, 0.3],
        [8.9, 0.12 * b + 0.04, 0.18],
      ],
      0.004,
    ),
    noiseAmp: 0.05 + 0.1 * b,
    noiseDecay: 0.05,
    noiseFilter: 0.55,
    formant: 0,
  }),
  wood: (rng, b) => ({
    attack: 0.002,
    decay: 0.16 + rng.range(0, 0.08),
    modes: makeModes(
      rng,
      180 + rng.range(-25, 35),
      [
        [1, 0.6, 0.14],
        [2.3, 0.25, 0.09],
        [4.15, 0.12, 0.05],
      ],
      0.01,
    ),
    noiseAmp: 0.22 + 0.15 * b,
    noiseDecay: 0.08,
    noiseFilter: 0.28,
    formant: 0,
  }),
  glass: (rng, b) => ({
    attack: 0.0008,
    decay: 0.9 + rng.range(0, 0.6),
    modes: makeModes(
      rng,
      3100 + rng.range(-200, 300),
      [
        [1, 0.4, 0.9],
        [2.01, 0.3, 0.7],
        [3.98, 0.2, 0.5],
        [6.8, (0.14 + 0.1 * b) * 0.8, 0.3],
      ],
      0.002,
    ),
    noiseAmp: 0.1 + 0.22 * b,
    noiseDecay: 0.12,
    noiseFilter: 0.7,
    formant: 0,
  }),
  stone: (rng, b) => ({
    attack: 0.003,
    decay: 0.22 + rng.range(0, 0.1),
    modes: makeModes(
      rng,
      120 + rng.range(-15, 20),
      [
        [1, 0.55, 0.2],
        [1.72, 0.2, 0.12],
      ],
      0.015,
    ),
    noiseAmp: 0.35 + 0.2 * b,
    noiseDecay: 0.1,
    noiseFilter: 0.2,
    formant: 0,
  }),
  rubber: (rng) => ({
    attack: 0.004,
    decay: 0.09 + rng.range(0, 0.05),
    modes: makeModes(
      rng,
      95 + rng.range(-10, 12),
      [[1, 0.5, 0.08]],
      0.02,
    ),
    noiseAmp: 0.16,
    noiseDecay: 0.04,
    noiseFilter: 0.12,
    formant: 0,
  }),
  voice: (rng, b) => ({
    attack: 0.012,
    decay: 0.4 + rng.range(0, 0.25),
    modes: makeModes(
      rng,
      320 + rng.range(-30, 60),
      [
        [1, 0.45, 0.45],
        [2, 0.2, 0.35],
        [3.01, 0.1, 0.25],
      ],
      0.006,
    ),
    noiseAmp: 0.04 + 0.06 * b,
    noiseDecay: 0.2,
    noiseFilter: 0.18,
    formant: 900 + rng.range(-80, 120),
  }),
};
