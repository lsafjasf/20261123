/**
 * 混音总线：
 * 1. 发声体按优先级路由到 sfx / danger / dialogue 三条总线；
 * 2. 对话/危险提示出现时，sfx 侧链压低（SIDECHAIN_*）；
 * 3. master 峰值仍超阈值时，对可压低总线做二级 ducking（OVERLOAD_*）；
 * 4. 末端 brick-wall 限制器保证输出永不超过 CEILING_DB。
 * 所有平滑器都是固定系数一阶包络，渲染顺序与浮点运算顺序确定。
 */

import { Scheduler } from './scheduler.ts';
import { Voice } from './synth.ts';
import {
  BLOCK_SAMPLES,
  BUS_CONFIG,
  CEILING_DB,
  LIMITER_ATTACK,
  LIMITER_RELEASE,
  OVERLOAD_ATTACK,
  OVERLOAD_DUCK_DB,
  OVERLOAD_RELEASE,
  Priority,
  SAMPLE_RATE,
  SIDECHAIN_ATTACK,
  SIDECHAIN_DUCK_DB,
  SIDECHAIN_RELEASE,
  dbToGain,
  type BusName,
} from './types.ts';

export interface BlockMetrics {
  sample: number;
  time: number;
  activeVoices: number;
  sfxPeak: number;
  dangerPeak: number;
  dialoguePeak: number;
  masterPeak: number;
  sidechainGain: number;
  overloadGain: number;
  limiterGain: number;
}

export interface RenderResult {
  /** 交错立体声 PCM，Float32，范围由限制器约束在 ceiling 内 */
  pcm: Float32Array;
  metrics: BlockMetrics[];
  totalSamples: number;
  sampleRate: number;
}

type DuckingBus = Exclude<BusName, 'master'>;

const BUSES: DuckingBus[] = ['sfx', 'dialogue', 'danger'];

export class CollisionMixer {
  readonly sampleRate = SAMPLE_RATE;
  readonly blockSize = BLOCK_SAMPLES;
  private readonly scheduler: Scheduler;
  private voices: Voice[] = [];
  private sampleCursor = 0;

  // 平滑器状态（线性增益域）
  private sidechainLevel = 1;
  private overloadLevel = 1;
  private limiterEnv = 0;
  private sidechainHold = 0;

  // 块级峰值记录
  private busPeak: Record<DuckingBus, number> = {
    sfx: 0,
    dialogue: 0,
    danger: 0,
  };
  private masterPeak = 0;

  constructor(seed: number, events: Parameters<Scheduler['load']>[0]) {
    this.scheduler = new Scheduler(seed);
    this.scheduler.load(events);
  }

  get scheduleRecords() {
    return this.scheduler.records;
  }

  get finished(): boolean {
    return (
      this.scheduler.pendingCount === 0 &&
      this.voices.length === 0 &&
      this.scheduler.activeCount === 0
    );
  }

  /** 块级一阶平滑系数：一个时间常数后达到目标的 ~63% */
  private blockCoeff(seconds: number): number {
    const blockDuration = this.blockSize / this.sampleRate;
    return 1 - Math.exp(-blockDuration / seconds);
  }

  /** 渲染到没有待处理事件且所有发声体自然结束为止 */
  renderAll(): RenderResult {
    const chunks: Float32Array[] = [];
    const metrics: BlockMetrics[] = [];
    // 尾部留 0.4s，保证最长 decay + 释放时间常数完整收尾
    const tailSamples = Math.round(0.4 * this.sampleRate);
    let quietSamples = 0;

    while (true) {
      const block = this.renderBlock();
      chunks.push(block);
      metrics.push(this.lastMetrics);
      if (this.scheduler.pendingCount === 0 && this.voices.length === 0) {
        quietSamples += this.blockSize;
        if (quietSamples >= tailSamples) break;
      } else {
        quietSamples = 0;
      }
      if (this.sampleCursor > this.sampleRate * 3600) {
        throw new Error('render exceeded 1 hour safety bound');
      }
    }

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      pcm,
      metrics,
      totalSamples: total / 2,
      sampleRate: this.sampleRate,
    };
  }

  private lastMetrics!: BlockMetrics;

  renderBlock(): Float32Array {
    const spawned = this.scheduler.drain(
      this.sampleCursor + this.blockSize - 1,
      this.sampleRate,
    );
    if (spawned.length) this.voices.push(...spawned);

    const block = new Float32Array(this.blockSize * 2);
    const busBuffer: Record<DuckingBus, Float32Array> = {
      sfx: new Float32Array(this.blockSize * 2),
      dialogue: new Float32Array(this.blockSize * 2),
      danger: new Float32Array(this.blockSize * 2),
    };

    // 1) 发声体 -> 总线（加入顺序 = 事件 (time,id) 顺序，确定）
    for (const voice of this.voices) {
      const bus = this.route(voice);
      const gain = dbToGain(BUS_CONFIG[bus].gainDb);
      const target = busBuffer[bus];
      for (let i = 0; i < this.blockSize; i++) {
        const [l, r] = voice.renderSample();
        target[i * 2] += l * gain;
        target[i * 2 + 1] += r * gain;
      }
    }
    this.voices = this.scheduler.liveVoices();

    // 2) 块峰值
    for (const bus of BUSES) {
      this.busPeak[bus] = peakOf(busBuffer[bus]);
    }
    const preMasterPeak = BUSES.reduce(
      (max, bus) => Math.max(max, this.busPeak[bus]),
      0,
    );

    // 3) 侧链：对话/危险总线有信号 -> sfx 压低
    const priorityDetected =
      this.busPeak.dialogue > 1e-5 || this.busPeak.danger > 1e-5;
    if (priorityDetected) {
      this.sidechainHold = Math.round(0.25 * this.sampleRate / this.blockSize);
    } else if (this.sidechainHold > 0) {
      this.sidechainHold--;
    }
    const priorityActive = priorityDetected || this.sidechainHold > 0;
    const sideTarget = priorityActive
      ? dbToGain(SIDECHAIN_DUCK_DB)
      : 1;
    this.sidechainLevel = this.toward(
      this.sidechainLevel,
      sideTarget,
      SIDECHAIN_ATTACK,
      SIDECHAIN_RELEASE,
      priorityActive,
    );

    // 4) 二级 ducking：master 峰值仍超过 -3 dBFS 且优先级声音在场
    const overloaded = preMasterPeak > dbToGain(-3);
    const overloadTarget = overloaded ? dbToGain(OVERLOAD_DUCK_DB) : 1;
    this.overloadLevel = this.toward(
      this.overloadLevel,
      overloadTarget,
      OVERLOAD_ATTACK,
      OVERLOAD_RELEASE,
      overloaded,
    );

    // 5) 总线混合 + ducking（只作用于 duckable 总线）
    const ceiling = dbToGain(CEILING_DB);
    for (let i = 0; i < this.blockSize; i++) {
      let left = 0;
      let right = 0;
      for (const bus of BUSES) {
        const cfg = BUS_CONFIG[bus];
        let g = 1;
        if (cfg.duckable) g = this.sidechainLevel * this.overloadLevel;
        left += busBuffer[bus][i * 2] * g;
        right += busBuffer[bus][i * 2 + 1] * g;
      }
      block[i * 2] = left;
      block[i * 2 + 1] = right;
    }

    // 6) brick-wall 限制器：块级前瞻——先测块峰值，平滑目标增益，再整块应用。
    //    瞬态在进入输出缓冲前就被缩小；末尾再做一次硬安全限幅兜底。
    const atk = this.blockCoeff(LIMITER_ATTACK);
    const rel = this.blockCoeff(LIMITER_RELEASE);
    this.masterPeak = 0;
    let blockPeak = 0;
    for (let i = 0; i < block.length; i++) {
      const v = Math.abs(block[i]);
      if (v > blockPeak) blockPeak = v;
    }
    if (blockPeak > this.limiterEnv) {
      this.limiterEnv += (blockPeak - this.limiterEnv) * atk;
    } else {
      this.limiterEnv += (blockPeak - this.limiterEnv) * rel;
    }
    const targetGain = Math.min(1, ceiling / Math.max(this.limiterEnv, 1e-9));
    for (let i = 0; i < block.length; i++) {
      const clipped = Math.max(-ceiling, Math.min(ceiling, block[i] * targetGain));
      block[i] = clipped;
      const v = Math.abs(clipped);
      if (v > this.masterPeak) this.masterPeak = v;
    }

    this.lastMetrics = {
      sample: this.sampleCursor,
      time: this.sampleCursor / this.sampleRate,
      activeVoices: this.voices.length,
      sfxPeak: this.busPeak.sfx,
      dangerPeak: this.busPeak.danger,
      dialoguePeak: this.busPeak.dialogue,
      masterPeak: this.masterPeak,
      sidechainGain: this.sidechainLevel,
      overloadGain: this.overloadLevel,
      limiterGain: targetGain,
    };
    this.sampleCursor += this.blockSize;
    return block;
  }

  private route(voice: Voice): DuckingBus {
    if (voice.priority === Priority.Dialogue) return 'dialogue';
    if (voice.priority === Priority.Danger) return 'danger';
    return 'sfx';
  }

  private toward(
    current: number,
    target: number,
    attack: number,
    release: number,
    engaging: boolean,
  ): number {
    const c = this.blockCoeff(engaging ? attack : release);
    return current + (target - current) * c;
  }
}

function peakOf(buffer: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const v = Math.abs(buffer[i]);
    if (v > peak) peak = v;
  }
  return peak;
}
