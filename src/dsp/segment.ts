// Energy-based phrase segmentation ("per sentence" control units).

export interface Segment {
  startSec: number;
  endSec: number;
}

export function segmentSpeech(
  samples: Float32Array,
  sampleRate: number,
  opts: { minSegSec?: number; mergeGapSec?: number; hangoverSec?: number } = {},
): Segment[] {
  const minSeg = opts.minSegSec ?? 0.3;
  const mergeGap = opts.mergeGapSec ?? 0.35;
  const hangover = opts.hangoverSec ?? 0.2;
  const win = Math.floor(0.025 * sampleRate);
  const hop = Math.floor(0.01 * sampleRate);
  const nFrames = Math.max(1, Math.floor((samples.length - win) / hop));
  const env = new Float64Array(nFrames);
  let peak = 0;
  for (let i = 0; i < nFrames; i++) {
    let s = 0;
    for (let j = 0; j < win; j++) {
      const v = samples[i * hop + j];
      s += v * v;
    }
    env[i] = Math.sqrt(s / win);
    if (env[i] > peak) peak = env[i];
  }
  // noise floor: 20th percentile of frame energy
  const sorted = Float64Array.from(env).sort();
  const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const thr = Math.max(floor * 2.5, peak * 0.02, 1e-5);

  const segs: Segment[] = [];
  let start = -1;
  let below = 0;
  const hangFrames = Math.round(hangover / 0.01);
  for (let i = 0; i < nFrames; i++) {
    if (env[i] > thr) {
      if (start < 0) start = i;
      below = 0;
    } else if (start >= 0) {
      below++;
      if (below > hangFrames) {
        segs.push({ startSec: (start * hop) / sampleRate, endSec: ((i - below) * hop + win) / sampleRate });
        start = -1;
        below = 0;
      }
    }
  }
  if (start >= 0) {
    segs.push({ startSec: (start * hop) / sampleRate, endSec: samples.length / sampleRate });
  }
  // merge across short gaps, drop too-short segments
  const merged: Segment[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s.startSec - last.endSec < mergeGap) {
      last.endSec = s.endSec;
    } else {
      merged.push({ ...s });
    }
  }
  return merged.filter((s) => s.endSec - s.startSec >= minSeg);
}
