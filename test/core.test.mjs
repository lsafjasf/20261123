import { test } from "node:test";
import assert from "node:assert/strict";
import { FlatAccumulator, estimateGainMap } from "../public/js/flatfield.js";
import { serializeGainMap, deserializeGainMap, samplePlane } from "../public/js/gainmap.js";
import { applyCorrection, softClip, DEFAULT_OPTIONS } from "../public/js/correct.js";
import { sampleRegions } from "../public/js/sampler.js";

// Synthetic lens vignette: cos^4-like falloff in normalized coords.
function vignette(nx, ny) {
  const dx = nx - 0.5, dy = ny - 0.5;
  const r2 = (dx * dx + dy * dy) / 0.5; // 1 at corners
  return 1 / (1 + 1.6 * r2 * r2);
}

function makeFrame(w, h, fn) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = w <= 1 ? 0.5 : x / (w - 1);
      const ny = h <= 1 ? 0.5 : y / (h - 1);
      const [r, g, b] = fn(nx, ny);
      const i = (y * w + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return buf;
}

function estimateFromSyntheticFlat(w = 160, h = 90) {
  const acc = new FlatAccumulator(w, h);
  for (let f = 0; f < 4; f++) {
    acc.addFrame(makeFrame(w, h, (nx, ny) => {
      const v = 220 * vignette(nx, ny);
      return [v, v, v];
    }));
  }
  return estimateGainMap(acc);
}

test("flat-field correction flattens a vignetted uniform target", () => {
  const map = estimateFromSyntheticFlat();
  const w = 160, h = 90;
  const scene = makeFrame(w, h, (nx, ny) => {
    const v = 200 * vignette(nx, ny);
    return [v, v, v];
  });
  const before = sampleRegions(scene, w, h);
  applyCorrection(scene, w, h, map, { ...DEFAULT_OPTIONS, shoulder: 0 });
  const after = sampleRegions(scene, w, h);
  assert.ok(before.cornerToCenter < 0.75, `vignette present before (${before.cornerToCenter})`);
  assert.ok(after.cornerToCenter > 0.97, `flat after correction (${after.cornerToCenter})`);
});

test("same map improves different resolutions consistently", () => {
  const map = estimateFromSyntheticFlat();
  const ratios = [];
  for (const [w, h] of [[160, 90], [320, 180], [640, 360]]) {
    const scene = makeFrame(w, h, (nx, ny) => {
      const v = 200 * vignette(nx, ny);
      return [v, v, v];
    });
    applyCorrection(scene, w, h, map, { ...DEFAULT_OPTIONS, shoulder: 0 });
    ratios.push(sampleRegions(scene, w, h).cornerToCenter);
  }
  for (const r of ratios) assert.ok(r > 0.96, `ratio ${r}`);
  const spread = Math.max(...ratios) - Math.min(...ratios);
  assert.ok(spread < 0.02, `resolution spread ${spread}`);
});

test("highlight shoulder never clips above 255 and stays monotonic", () => {
  let prev = -1;
  for (let v = 0; v <= 600; v += 3) {
    const out = softClip(v, 0.85, 1);
    assert.ok(out <= 255 && out >= 0, `bounded at v=${v}`);
    assert.ok(out >= prev, `monotonic at v=${v}`);
    prev = out;
  }
  // identity below the knee
  assert.equal(softClip(100, 0.85, 1), 100);
  // hard clamp path (shoulder 0)
  assert.equal(softClip(300, 0.85, 0), 255);
});

test("real scene gradients survive correction", () => {
  const map = estimateFromSyntheticFlat();
  const w = 320, h = 180;
  // True scene: smooth horizontal gradient. Captured: gradient * vignette.
  const truth = (nx) => 60 + 140 * nx;
  const scene = makeFrame(w, h, (nx, ny) => {
    const v = truth(nx) * vignette(nx, ny);
    return [v, v, v];
  });
  applyCorrection(scene, w, h, map, { ...DEFAULT_OPTIONS, shoulder: 0 });
  // Compare corrected mid-row against the true gradient.
  let err = 0, n = 0;
  const y = h >> 1;
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    err += Math.abs(scene[i] - truth(x / (w - 1)));
    n++;
  }
  const meanErr = err / n;
  assert.ok(meanErr < 8, `gradient recovered, mean abs err ${meanErr}`);
});

test("strength slider interpolates between off and full", () => {
  const map = estimateFromSyntheticFlat();
  const w = 160, h = 90;
  const mk = () => makeFrame(w, h, (nx, ny) => {
    const v = 200 * vignette(nx, ny);
    return [v, v, v];
  });
  const off = mk();
  applyCorrection(off, w, h, map, { ...DEFAULT_OPTIONS, strength: 0, shoulder: 0 });
  const half = mk();
  applyCorrection(half, w, h, map, { ...DEFAULT_OPTIONS, strength: 0.5, shoulder: 0 });
  const full = mk();
  applyCorrection(full, w, h, map, { ...DEFAULT_OPTIONS, strength: 1, shoulder: 0 });
  const rOff = sampleRegions(off, w, h).cornerToCenter;
  const rHalf = sampleRegions(half, w, h).cornerToCenter;
  const rFull = sampleRegions(full, w, h).cornerToCenter;
  assert.ok(rOff < rHalf && rHalf < rFull, `${rOff} < ${rHalf} < ${rFull}`);
});

test("gain map JSON round-trips", () => {
  const map = estimateFromSyntheticFlat();
  const back = deserializeGainMap(serializeGainMap(map));
  assert.equal(back.cols, map.cols);
  assert.equal(back.rows, map.rows);
  const a = samplePlane(map.r, map.cols, map.rows, 0.13, 0.77);
  const b = samplePlane(back.r, back.cols, back.rows, 0.13, 0.77);
  assert.ok(Math.abs(a - b) < 1e-3);
});
