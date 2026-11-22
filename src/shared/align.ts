// Sentence-level alignment across takes of the same script.
// Index alignment when sentence counts match; DTW on log-durations otherwise
// (handles a merged/split sentence in one take).

import type { Segmentation } from "./dsp.ts";

// aligned[takeIndex][refSentence] = sentence index in that take, or -1 if missing.
export function alignTakes(segmentations: Segmentation[], refIndex: number): number[][] {
  const ref = segmentations[refIndex];
  const nRef = ref.sentences.length;
  return segmentations.map((seg, t) => {
    if (t === refIndex || seg.sentences.length === nRef) {
      return seg.sentences.map((_, i) => i);
    }
    return dtwAlign(
      ref.sentences.map((s) => s.end - s.start),
      seg.sentences.map((s) => s.end - s.start),
    );
  });
}

// Maps each reference item to a candidate item index (or -1) via DTW
// on log-duration with a Sakoe-Chiba band.
function dtwAlign(refDur: number[], candDur: number[]): number[] {
  const n = refDur.length;
  const m = candDur.length;
  const band = Math.max(2, Math.abs(n - m) + 1);
  const INF = 1e18;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
  cost[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    const jLo = Math.max(1, Math.round((i / n) * m) - band);
    const jHi = Math.min(m, Math.round((i / n) * m) + band);
    for (let j = jLo; j <= jHi; j++) {
      const d = Math.log(Math.max(refDur[i - 1], 1e-3)) - Math.log(Math.max(candDur[j - 1], 1e-3));
      cost[i][j] = d * d + Math.min(cost[i - 1][j], cost[i][j - 1] + 0.5, cost[i - 1][j - 1]);
    }
  }
  // Backtrack.
  const map = new Array<number>(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    map[i - 1] = j - 1;
    const diag = cost[i - 1][j - 1];
    const up = cost[i - 1][j];
    const left = cost[i][j - 1] + 0.5;
    if (diag <= up && diag <= left) {
      i--;
      j--;
    } else if (up <= left) {
      i--;
    } else {
      j--;
    }
  }
  return map;
}
