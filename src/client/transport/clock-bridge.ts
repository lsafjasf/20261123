/**
 * 浏览器端时钟管理：
 * - 周期性发起 clock-sync，估计本地 performance 时钟相对服务端墙钟的偏移；
 * - 提供 AudioContext 时间与 performance 时间的互转（基于一次同时采样）。
 */

import { estimateFromPoints, type ClockEstimate } from '../../shared/clock.ts';
import type { ControlMessage } from '../../shared/protocol.ts';

interface SyncPoint {
  t0: number;
  tServer: number;
  t2: number;
}

export class ClockBridge {
  private readonly ws: WebSocket;
  private readonly roundId: string;
  private points: SyncPoint[] = [];
  private estimate: ClockEstimate = { offsetMs: 0, rttMs: 0, samples: 0 };
  private pending = new Map<
    number,
    { resolve: () => void; t0: number }
  >();
  private nextId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private audioOrigin: { performance: number; audio: number } | null = null;

  constructor(ws: WebSocket, roundId: string) {
    this.ws = ws;
    this.roundId = roundId;
  }

  start(intervalMs = 2000): void {
    this.timer = setInterval(() => {
      void this.syncOnce();
    }, intervalMs);
    void this.syncOnce();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  bindAudioContext(context: AudioContext): void {
    this.audioOrigin = {
      performance: performance.now(),
      audio: context.currentTime,
    };
  }

  audioToPerformance(audioTime: number): number {
    if (!this.audioOrigin) {
      return audioTime * 1000;
    }
    return (
      this.audioOrigin.performance +
      (audioTime - this.audioOrigin.audio) * 1000
    );
  }

  handleMessage(message: ControlMessage): boolean {
    if (
      message.kind !== 'clock-sync-ack' ||
      message.roundId !== this.roundId
    ) {
      return false;
    }
    const t2 = performance.now();
    this.points.push({ t0: message.t0, tServer: message.t1, t2 });
    if (this.points.length > 20) {
      this.points.shift();
    }
    this.estimate = estimateFromPoints(this.points);
    const pending = this.pending.get(message.id);
    if (pending) {
      this.pending.delete(message.id);
      pending.resolve();
    }
    return true;
  }

  async syncOnce(): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const id = this.nextId;
    this.nextId += 1;
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      this.pending.set(id, { resolve, t0 });
      this.ws.send(
        JSON.stringify({
          kind: 'clock-sync',
          roundId: this.roundId,
          id,
          t0,
        } satisfies ControlMessage),
      );
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve();
        }
      }, 1000);
    });
  }

  /** 本地 performance 时刻 -> 服务端基准墙钟（Date.now 口径）。 */
  toServerTime(localPerformanceMs: number): number {
    return localPerformanceMs + this.estimate.offsetMs;
  }

  get current(): ClockEstimate {
    return { ...this.estimate };
  }
}
