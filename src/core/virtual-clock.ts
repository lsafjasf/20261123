import type { MonotonicClock } from './types.ts';

/**
 * 虚拟单调时钟，单位毫秒。测试中手动推进时间，
 * 让缓冲、追直播、延迟突变等场景完全确定、可复现。
 */
export class VirtualClock implements MonotonicClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    if (ms < 0) {
      throw new RangeError('virtual clock cannot move backwards');
    }
    this.current += ms;
    return this.current;
  }

  set(ms: number): void {
    if (ms < this.current) {
      throw new RangeError('virtual clock cannot move backwards');
    }
    this.current = ms;
  }
}

/** 封装 performance.now 的真实单调时钟。 */
export class PerformanceClock implements MonotonicClock {
  private readonly perf: Pick<Performance, 'now'>;

  constructor(perf: Pick<Performance, 'now'>) {
    this.perf = perf;
  }
  now(): number {
    return this.perf.now();
  }
}
