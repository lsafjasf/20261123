/**
 * 发声调度：族内音色轮换 + 优先级抢占。
 * 决策只依赖 (seed, event, 当前发声体快照)，全部整数/浮点运算顺序固定，
 * 不依赖 Map 迭代顺序、Date.now 或任何外部状态。
 */

import { Voice, createVoice } from './synth.ts';
import {
  FAMILY_QUOTA,
  MIN_AUDIBLE_SPEED,
  Priority,
  type CollisionEvent,
  type TimbreFamily,
} from './types.ts';

export type RejectReason = 'too_slow' | 'rotated' | 'stolen';

export interface ScheduleRecord {
  eventId: number;
  sample: number;
  accepted: boolean;
  reason?: RejectReason;
  /** 被轮换/抢占掉的发声体事件 id（若有） */
  replacedEventId?: number;
}

export class Scheduler {
  private events: CollisionEvent[] = [];
  private cursor = 0;
  private active = new Set<Voice>();
  readonly records: ScheduleRecord[] = [];

  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  /** 批量载入事件；内部按 (time, id) 稳定排序，保证流顺序可复现 */
  load(events: CollisionEvent[]): void {
    this.events = [...events].sort((a, b) =>
      a.time === b.time ? a.id - b.id : a.time - b.time,
    );
    this.cursor = 0;
  }

  /** 取截至 currentSample 应触发的全部事件，逐一定价并分配发声体 */
  drain(currentSample: number, sampleRate: number): Voice[] {
    const spawned: Voice[] = [];
    while (this.cursor < this.events.length) {
      const event = this.events[this.cursor];
      const startSample = Math.round(event.time * sampleRate);
      if (startSample > currentSample) break;
      this.cursor++;
      const voice = this.allocate(event, startSample);
      if (voice) spawned.push(voice);
    }
    return spawned;
  }

  private allocate(
    event: CollisionEvent,
    startSample: number,
  ): Voice | null {
    if (event.speed < MIN_AUDIBLE_SPEED && event.priority < Priority.Danger) {
      this.records.push({
        eventId: event.id,
        sample: startSample,
        accepted: false,
        reason: 'too_slow',
      });
      return null;
    }

    const candidate = createVoice(event, this.seed, startSample);
    const family = candidate.family;
    const members = this.familyMembers(family);

    if (members.length < FAMILY_QUOTA[family]) {
      this.accept(candidate, startSample);
      return candidate;
    }

    // 族配额已满：先尝试同优先级“轮休”——替换包络最靠后的同族声音，
    // 让连续的硬币轻响/碎玻璃轮流发声而不是无限叠加
    const weakest = members.reduce((a, b) =>
      a.currentEnv() <= b.currentEnv() ? a : b,
    );
    if (weakest.priority <= event.priority) {
      this.active.delete(weakest);
      this.records.push({
        eventId: weakest.eventId,
        sample: startSample,
        accepted: false,
        reason: 'rotated',
        replacedEventId: event.id,
      });
      this.accept(candidate, startSample);
      return candidate;
    }

    // 族内都是更重要的声音：当前事件被丢弃
    this.records.push({
      eventId: event.id,
      sample: startSample,
      accepted: false,
      reason: 'stolen',
    });
    return null;
  }

  private accept(voice: Voice, sample: number): void {
    this.active.add(voice);
    this.records.push({ eventId: voice.eventId, sample, accepted: true });
  }

  private familyMembers(family: TimbreFamily): Voice[] {
    const out: Voice[] = [];
    for (const voice of this.active) {
      if (voice.family === family) out.push(voice);
    }
    return out;
  }

  /** 每个 block 调用：返回仍存活的发声体，并回收已结束的 */
  liveVoices(): Voice[] {
    const out: Voice[] = [];
    for (const voice of this.active) {
      if (voice.isFinished()) this.active.delete(voice);
      else out.push(voice);
    }
    return out;
  }

  get activeCount(): number {
    return this.active.size;
  }

  get pendingCount(): number {
    return this.events.length - this.cursor;
  }
}
