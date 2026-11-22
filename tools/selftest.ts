// Algorithm self-test on synthetic data (no browser needed).
// Run: node tools/selftest.ts
import { toGray, matchTemplate, fitSimilarity } from '../src/client/align.ts';
import { planCorrections, medianFilter } from '../src/client/exposure.ts';
import { WebmMuxer } from '../src/client/webm.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${detail}`);
  if (!cond) failures++;
}

// --- 1. template matching recovers a known shift ---
{
  const w = 160, h = 120;
  const rgba = new Uint8ClampedArray(w * h * 4);
  let seed = 42;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < rgba.length; i += 4) {
    const v = Math.floor(rnd() * 255);
    rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
  }
  const ref = toGray(rgba, w, h, 1);
  // shift target by (+5, -3)
  const dx = 5, dy = -3;
  const shifted = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = x - dx, sy = y - dy;
      shifted[y * w + x] = sx >= 0 && sy >= 0 && sx < w && sy < h ? ref.data[sy * w + sx] : 0;
    }
  const target = { data: shifted, w, h };
  const m = matchTemplate(ref, target, 80, 60, 10, 16, 1);
  check('matchTemplate finds shift', !!m && Math.abs(m.x - 85) <= 1 && Math.abs(m.y - 57) <= 1,
    m ? `got (${m.x}, ${m.y}) ncc=${m.ncc.toFixed(3)}` : 'no match');
}

// --- 2. similarity fit recovers scale + translation ---
{
  const anchors = [
    { id: 1, x: 100, y: 200 },
    { id: 2, x: 300, y: 250 },
    { id: 3, x: 500, y: 180 },
  ];
  const s = 1.02, tx = -6, ty = 4;
  const matched = anchors.map((a) => ({ x: s * a.x + tx, y: s * a.y + ty, ncc: 0.9 }));
  const fit = fitSimilarity(anchors, matched);
  check('fitSimilarity recovers transform',
    !!fit && Math.abs(fit.transform.s - s) < 1e-6 && Math.abs(fit.transform.tx - tx) < 1e-6
    && Math.abs(fit.transform.ty - ty) < 1e-6 && fit.residualPx < 1e-6,
    fit ? `s=${fit.transform.s} tx=${fit.transform.tx} ty=${fit.transform.ty}` : 'null');
}

// --- 3. exposure: flicker removed, day/night trend kept ---
{
  const n = 72;
  const raw: number[] = [];
  for (let i = 0; i < n; i++) {
    const day = 1.4 * Math.sin((i / n) * Math.PI * 2 - Math.PI / 2);
    const flicker = i % 7 === 0 ? 0.9 : (i % 5 === 0 ? -0.7 : 0.05 * Math.sin(i * 3));
    raw.push(day + flicker);
  }
  const plan = planCorrections(raw, 1.5);
  const corrected = raw.map((v, i) => v + plan.corrections[i]);
  // high-frequency energy should drop, slow trend should remain
  const hf = (arr: number[]): number => {
    let e = 0;
    for (let i = 1; i < arr.length; i++) e += (arr[i] - arr[i - 1]) ** 2;
    return e;
  };
  const trendKept = Math.abs(Math.max(...plan.evTrend) - Math.min(...plan.evTrend)) > 2;
  check('flicker smoothed', hf(corrected) < hf(raw) * 0.6,
    `hf ${hf(raw).toFixed(1)} → ${hf(corrected).toFixed(1)}`);
  check('day/night trend preserved', trendKept,
    `trend range ${(Math.max(...plan.evTrend) - Math.min(...plan.evTrend)).toFixed(2)}EV`);
  check('medianFilter flat on constant', medianFilter([3, 3, 3, 3, 3], 2).every((v) => v === 3));
}

// --- 4. WebM muxer emits sane EBML ---
{
  const muxer = new WebmMuxer({ width: 640, height: 360, codecId: 'V_VP9' });
  muxer.addFrame(new Uint8Array([1, 2, 3, 4]), 0, true);
  muxer.addFrame(new Uint8Array([5, 6, 7]), 83, false);
  const file = muxer.finalize();
  const head = Array.from(file.slice(0, 4));
  check('webm EBML magic', head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3);
  const init = muxer.initSegment();
  const media = muxer.mediaSegment();
  check('init+media ≈ file size', Math.abs(init.length + media.length - file.length) < 40,
    `init=${init.length} media=${media.length} file=${file.length}`);
}

process.exit(failures ? 1 : 0);
