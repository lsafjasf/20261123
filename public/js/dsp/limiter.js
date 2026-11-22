import { dbToLin, linToDb } from './dynamics.js';

                                
                       
                       
 

// Lookahead brickwall limiter. The output is delayed by `lookaheadMs`;
// the applied gain never lets a sample exceed the ceiling.
export function lookaheadLimit(
  input              ,
  fs        ,
  ceilingDb        ,
  lookaheadMs = 1.5,
  releaseMs = 50,
)                {
  const n = input.length;
  const look = Math.max(1, Math.round(lookaheadMs * 0.001 * fs));
  const ceiling = dbToLin(ceilingDb);
  const relCoef = Math.exp(-1 / (releaseMs * 0.001 * fs));

  // Trailing sliding window maximum of |x| over [i-look, i]: the set of
  // samples currently inside the delay line.
  const windowMax = new Float32Array(n);
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const abs = new Float32Array(n);
  for (let i = 0; i < n; i++) abs[i] = Math.abs(input[i]);
  for (let i = 0; i < n; i++) {
    while (tail > head && abs[deque[tail - 1]] <= abs[i]) tail--;
    deque[tail++] = i;
    while (head < tail && deque[head] < i - look) head++;
    windowMax[i] = head < tail ? abs[deque[head]] : 0;
  }

  const output = new Float32Array(n);
  const gainDb = new Float32Array(n);
  let g = 1;
  for (let i = 0; i < n; i++) {
    const need = windowMax[i] > ceiling ? ceiling / windowMax[i] : 1;
    if (need < g) g = need;
    else g = g + (need - g) * (1 - relCoef);
    if (g > 1) g = 1;
    const src = i - look;
    const y = src >= 0 ? input[src] * g : 0;
    output[i] = y;
    gainDb[i] = linToDb(g);
  }
  return { output, gainDb };
}

// 4x linear-interpolation oversampled peak (true-peak approximation).
export function oversampledPeakDb(x              )         {
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    if (i + 1 < x.length) {
      const b = x[i];
      const c = x[i + 1];
      for (const t of [0.25, 0.5, 0.75]) {
        const v = Math.abs(b + (c - b) * t);
        if (v > peak) peak = v;
      }
    }
  }
  return linToDb(peak);
}

export function samplePeakDb(x              )         {
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
  }
  return linToDb(peak);
}
