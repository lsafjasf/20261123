import assert from "node:assert/strict";
import test from "node:test";
import { TearingDetector, summarize } from "../src/core/analyzer.ts";
import type { RGBAFrame } from "../src/core/types.ts";

const W = 480;
const H = 270;

function scene(time: number, scanlines = false): RGBAFrame {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const at = (y * W + x) * 4;
      const road = y > 155;
      const stripe = Math.sin((x + time * 4) * 0.11) * 22;
      const lane = road ? Math.abs(((x + time * 4) % 72) - 36) < 3 : false;
      const building = y < 155 ? Math.sin((x + time * 2) * 0.037 + y * 0.005) * 18 : 0;
      const checker = ((Math.floor((x + time * 3) / 13) + Math.floor(y / 13)) & 1) * 12;
      const base = road ? 38 : 58;
      let r = base + stripe + building + checker;
      let g = base + 18 + stripe * 0.55 + building * 0.7 + checker;
      let b = base + 34 + stripe * 0.2 + building * 1.2 + checker;
      if (y > 80 && y < 124) {
        const carX = 160 + ((time * 3) % 72);
        if (x > carX && x < carX + 68 && y > 88 && y < 118) {
          r = 220;
          g = 72;
          b = 46;
        }
      }
      if (lane) {
        r = 205;
        g = 195;
        b = 142;
      }
      if (y > 226 && y < 242 && x > 24 && x < 145) {
        r = 18;
        g = 24;
        b = 31;
      }
      if (scanlines && y % 4 === 0) {
        r *= 0.42;
        g *= 0.42;
        b *= 0.42;
      }
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 255;
    }
  }
  return { width: W, height: H, data, timestampMs: time * 40 };
}

function withTear(base: RGBAFrame, seam: number, shift: number): RGBAFrame {
  const data = new Uint8ClampedArray(base.data);
  for (let y = seam; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const target = (y * W + x) * 4;
      const sourceX = Math.max(0, Math.min(W - 1, x - shift));
      const source = (y * W + sourceX) * 4;
      data[target] = base.data[source];
      data[target + 1] = base.data[source + 1];
      data[target + 2] = base.data[source + 2];
    }
  }
  return { ...base, data };
}

function withBlocks(base: RGBAFrame): RGBAFrame {
  const data = new Uint8ClampedArray(base.data);
  const colors = [
    [210, 64, 92],
    [42, 206, 178],
    [228, 187, 62],
    [72, 107, 222],
    [199, 89, 214],
    [111, 204, 84],
  ];
  for (let by = 0; by < 3; by += 1) {
    for (let bx = 0; bx < 4; bx += 1) {
      const color = colors[(by * 4 + bx) % colors.length];
      const startX = 208 + bx * 24;
      const startY = 72 + by * 24;
      for (let y = startY; y < startY + 24; y += 1) {
        for (let x = startX; x < startX + 24; x += 1) {
          const at = (y * W + x) * 4;
          const noise = ((x * 17 + y * 31) % 23) - 11;
          data[at] = color[0] + noise;
          data[at + 1] = color[1] - noise;
          data[at + 2] = color[2] + noise * 0.5;
        }
      }
    }
  }
  return { ...base, data };
}

function withGlitch(base: RGBAFrame): RGBAFrame {
  const data = new Uint8ClampedArray(base.data);
  for (let y = 0; y < H; y += 1) {
    const band = y % 9 === 0 || y % 9 === 1;
    for (let x = 0; x < W; x += 1) {
      const at = (y * W + x) * 4;
      if (band) {
        data[at] = 255 - data[at];
        data[at + 1] = 255 - data[at + 1];
        data[at + 2] = 255 - data[at + 2];
      }
      if (y > 34 && y < 38) {
        const shifted = ((x + 11) % W) * 4 + y * W * 4;
        data[at] = data[shifted];
      }
    }
  }
  return { ...base, data };
}

test("detects a genuine full-width acquisition tear", () => {
  const detector = new TearingDetector();
  for (let i = 0; i < 6; i += 1) detector.analyze(scene(i));
  const result = detector.analyze(withTear(scene(6), 104, 14));
  assert.equal(result.classification, "tear");
  const seam = result.seam;
  if (!seam) throw new Error("expected seam evidence");
  assert.ok(Math.abs(seam.shift) >= 7);
  assert.ok(seam.support > 0.42);
});

test("keeps persistent high-frequency scanlines out of tear class", () => {
  const detector = new TearingDetector();
  let result = detector.analyze(scene(0, true));
  for (let i = 1; i < 14; i += 1) result = detector.analyze(scene(i, true));
  assert.notEqual(result.classification, "tear");
  assert.ok(result.metrics.lineDensity > 0.1);
  assert.equal(result.classification, "normal");
});

test("classifies grid-aligned block corruption", () => {
  const detector = new TearingDetector();
  for (let i = 0; i < 5; i += 1) detector.analyze(scene(i));
  const result = detector.analyze(withBlocks(scene(5)));
  assert.equal(result.classification, "encode-block");
  assert.ok(result.encodeScore > result.tearScore);
});

test("classifies a burst of recurring horizontal glitch lines as vfx", () => {
  const detector = new TearingDetector();
  for (let i = 0; i < 10; i += 1) detector.analyze(scene(i));
  let result = detector.analyze(withGlitch(scene(10)));
  for (let i = 11; i < 15; i += 1) result = detector.analyze(withGlitch(scene(i)));
  assert.equal(result.classification, "vfx-glitch");
  assert.ok(result.vfxScore > 0.55);
});

test("summary covers every classification bucket", () => {
  const detector = new TearingDetector();
  const frames = [scene(0), withTear(scene(1), 104, 12), withBlocks(scene(2))].map(
    (frame, index) => detector.analyze(frame, index * 40),
  );
  const summary = summarize(frames);
  assert.equal(summary.frames, 3);
  assert.equal(
    Object.values(summary.counts).reduce((total, count) => total + count, 0),
    3,
  );
  assert.ok(summary.ratios.normal >= 0);
});
