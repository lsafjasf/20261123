// Pure reversal-timeline logic, shared by the browser player and Node tests.
// Given decoded video frame timestamps and a [start, end) source range,
// builds the reversed output schedule and the A/V alignment report.

export interface FrameInfo {
  cts: number;
  duration: number;
  keyframe: boolean;
}

export interface OutputFrame {
  outputIndex: number;
  outputTime: number;
  sourceCts: number;
  sourceDuration: number;
  keyframe: boolean;
}

export interface AvErrorStats {
  perFrameMs: number[];
  maxAbsMs: number;
  meanAbsMs: number;
  rmsMs: number;
}

export interface ReversePlan {
  startSec: number;
  endSec: number;
  totalDuration: number;
  frames: OutputFrame[];
  avError: AvErrorStats;
}

// Selects frames whose presentation interval intersects [startSec, endSec),
// sorted by CTS, then builds the reversed output schedule.
export function buildReversePlan(
  frames: FrameInfo[], startSec: number, endSec: number,
): ReversePlan {
  const inRange = frames
    .filter(f => f.cts + f.duration > startSec && f.cts < endSec)
    .sort((a, b) => a.cts - b.cts);
  if (inRange.length === 0) {
    throw new Error(`no frames in range [${startSec}, ${endSec})`);
  }
  const total = inRange.reduce((acc, f) => acc + f.duration, 0);
  const out: OutputFrame[] = [];
  let t = 0;
  for (let k = 0; k < inRange.length; k++) {
    const src = inRange[inRange.length - 1 - k];
    out.push({
      outputIndex: k,
      outputTime: t,
      sourceCts: src.cts,
      sourceDuration: src.duration,
      keyframe: src.keyframe,
    });
    t += src.duration;
  }
  return {
    startSec, endSec, totalDuration: total,
    frames: out,
    avError: computeAvError(out, startSec, total),
  };
}

// A/V alignment error per output frame. On the output timeline, audio is the
// source segment [startSec, startSec+total] played in reverse, so output
// time t pairs with source time (startSec + total - t). For each output
// frame we compare its actual center time with the ideal mirrored center of
// the source frame it displays.
export function computeAvError(
  frames: OutputFrame[], startSec: number, total: number,
): AvErrorStats {
  const perFrameMs = frames.map(f => {
    const actualCenter = f.outputTime + f.sourceDuration / 2;
    const sourceCenter = f.sourceCts + f.sourceDuration / 2;
    const idealCenter = startSec + total - sourceCenter;
    return (actualCenter - idealCenter) * 1000;
  });
  const abs = perFrameMs.map(Math.abs);
  const maxAbsMs = abs.length ? Math.max(...abs) : 0;
  const meanAbsMs = abs.length ? abs.reduce((a, b) => a + b, 0) / abs.length : 0;
  const rmsMs = perFrameMs.length
    ? Math.sqrt(perFrameMs.reduce((a, e) => a + e * e, 0) / perFrameMs.length)
    : 0;
  return { perFrameMs, maxAbsMs, meanAbsMs, rmsMs };
}

// Index of the output frame that should be on screen at output time t.
// Used on resume so playback continues from the paused position instead of
// restarting (which would repeat already-shown frames).
export function frameIndexAt(plan: ReversePlan, t: number): number {
  if (t <= 0) return 0;
  let lo = 0;
  let hi = plan.frames.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = plan.frames[mid];
    if (t < f.outputTime) {
      hi = mid - 1;
    } else if (t >= f.outputTime + f.sourceDuration) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  for (const f of plan.frames) {
    if (f.outputTime + f.sourceDuration > t) return f.outputIndex;
  }
  return plan.frames.length;
}
