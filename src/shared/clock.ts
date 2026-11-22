/**
 * 时钟同步纯逻辑。所有参与方以服务端墙钟（Date.now）为基准，
 * 采用 NTP 风格的四次时间点估计本地时钟相对服务端的偏移：
 *
 *   rtt  = (t2 - t0) - (t1 - tServer)
 *   offset = ((t1 - t0) + (tServer - t2)) / 2
 *
 * 其中 t0/t2 为本地时刻、t1/tServer 为服务端时刻。
 * 取 RTT 最小的样本作为最终估计，避免排队抖动污染偏移。
 */

export interface ClockEstimate {
  offsetMs: number;
  rttMs: number;
  samples: number;
}

/**
 * 更直观的样本形式：本地发出 t0、服务端收到并回包 tServer（收发视为同一时刻）、
 * 本地收到 t2。
 */
export interface SyncPoint {
  t0: number;
  tServer: number;
  t2: number;
}

export function estimateFromPoints(points: SyncPoint[]): ClockEstimate {
  if (points.length === 0) {
    return { offsetMs: 0, rttMs: 0, samples: 0 };
  }
  let best: { offset: number; rtt: number } | null = null;
  for (const point of points) {
    const rtt = point.t2 - point.t0;
    const offset =
      point.tServer - (point.t0 + point.t2) / 2;
    if (best === null || rtt < best.rtt) {
      best = { offset, rtt };
    }
  }
  return {
    offsetMs: best?.offset ?? 0,
    rttMs: best?.rtt ?? 0,
    samples: points.length,
  };
}

/** 把本地时刻换算到服务端基准时钟。 */
export function toServerTime(localMs: number, estimate: ClockEstimate): number {
  return localMs + estimate.offsetMs;
}

/** 把服务端基准时刻换算回本地时钟。 */
export function toLocalTime(serverMs: number, estimate: ClockEstimate): number {
  return serverMs - estimate.offsetMs;
}
