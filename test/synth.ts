/**
 * End-to-end test: synthesise a damaged film scan with known ground
 * truth, run the CLI on it, and verify the delivery outputs.
 *
 *   node test/synth.ts
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { encodePng, decodePng } from "../src/node/png.ts";
import { mulberry32 } from "../src/core/repair.ts";
import { toLuma, noiseSigma } from "../src/core/analyze.ts";
import type { Frame } from "../src/core/types.ts";

const W = 320, H = 240, N = 32, FPS = 24;
const OUT = join("out", "test");
const IN_DIR = join(OUT, "in");
const MANUAL_DIR = join(OUT, "manual");
const DELIVERY = join(OUT, "delivery");

const CONTENT_LINE_X = 200;      // real picture content, all frames
const SCRATCH_A_X = 100;         // repairable scratch, frames 8..20
const SCRATCH_A_RANGE: [number, number] = [8, 20];
const SCRATCH_B_X = 250;         // ambiguous scratch, frames 4..28 -> locked
const SCRATCH_B_RANGE: [number, number] = [4, 28];
const DISABLED = 9;
const MANUAL = 14;
const GRAIN = 3;

const DUST: { frame: number; x: number; y: number; r: number; v: number }[] = [
  { frame: 5, x: 40, y: 200, r: 3, v: 70 },
  { frame: 11, x: 280, y: 60, r: 4, v: -70 },
  { frame: 17, x: 150, y: 180, r: 3, v: 65 },
  { frame: 23, x: 250, y: 200, r: 2, v: -65 },
];

function circleCenter(t: number): { x: number; y: number } {
  return { x: 60 + 4 * t, y: 60 + 2 * t };
}

function cleanFrame(t: number): Frame {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 80 + y * 0.3 + (x % 32 < 16 ? 8 : 0);
      if (x === CONTENT_LINE_X || x === CONTENT_LINE_X + 1) v = 30;
      const c = circleCenter(t);
      const dx = x - c.x, dy = y - c.y;
      if (dx * dx + dy * dy <= 144) v = 200;
      const p = (y * W + x) * 4;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
      rgba[p + 3] = 255;
    }
  }
  return { index: t, width: W, height: H, rgba };
}

function addGrain(f: Frame): void {
  const rand = mulberry32(1234 + f.index);
  let spare = NaN;
  const gauss = (): number => {
    if (!isNaN(spare)) { const v = spare; spare = NaN; return v; }
    const u = Math.max(1e-9, rand()), v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  for (let p = 0; p < f.rgba.length; p += 4) {
    const n = gauss() * GRAIN;
    for (let c = 0; c < 3; c++) {
      const v = f.rgba[p + c] + n;
      f.rgba[p + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
}

function paint(f: Frame, x: number, y: number, delta: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const p = (y * W + x) * 4;
  for (let c = 0; c < 3; c++) {
    const v = f.rgba[p + c] + delta;
    f.rgba[p + c] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}

function damage(f: Frame): void {
  const t = f.index;
  for (const d of DUST) {
    if (d.frame !== t) continue;
    for (let y = -d.r; y <= d.r; y++) {
      for (let x = -d.r; x <= d.r; x++) {
        if (x * x + y * y <= d.r * d.r) paint(f, d.x + x, d.y + y, d.v);
      }
    }
  }
  if (t === 13) {
    for (let i = 0; i <= 60; i++) {
      paint(f, 30 + i, 30 + Math.round(20 * Math.sin(i / 9) + i / 6), -60);
    }
  }
  if (t >= SCRATCH_A_RANGE[0] && t <= SCRATCH_A_RANGE[1]) {
    for (let y = 0; y < H; y++) {
      paint(f, SCRATCH_A_X, y, 45);
      paint(f, SCRATCH_A_X + 1, y, 45);
    }
  }
  if (t >= SCRATCH_B_RANGE[0] && t <= SCRATCH_B_RANGE[1]) {
    for (let y = 0; y < H; y++) paint(f, SCRATCH_B_X, y, -45);
  }
}

function buildInputs(): void {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(IN_DIR, { recursive: true });
  mkdirSync(MANUAL_DIR, { recursive: true });
  for (let t = 0; t < N; t++) {
    const f = cleanFrame(t);
    addGrain(f);
    damage(f);
    writeFileSync(join(IN_DIR, `f${String(t).padStart(4, "0")}.png`),
      encodePng({ width: W, height: H, rgba: f.rgba }));
    if (t === MANUAL) {
      // "Human" replacement: clean frame plus a marker square.
      const m = cleanFrame(t);
      addGrain(m);
      for (let y = 10; y < 20; y++) {
        for (let x = 10; x < 20; x++) paint(m, x, y, 90);
      }
      writeFileSync(join(MANUAL_DIR, `f${String(t).padStart(4, "0")}.png`),
        encodePng({ width: W, height: H, rgba: m.rgba }));
    }
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

function loadDelivery(): Map<number, Frame> {
  const out = new Map<number, Frame>();
  for (const f of readdirSync(join(DELIVERY, "sequence"))) {
    const img = decodePng(readFileSync(join(DELIVERY, "sequence", f)));
    const m = f.match(/F(\d+)\.png$/);
    if (m) out.set(Number(m[1]), { index: Number(m[1]), width: img.width, height: img.height, rgba: img.rgba });
  }
  return out;
}

function loadMasks(): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  for (const f of readdirSync(join(DELIVERY, "masks"))) {
    const img = decodePng(readFileSync(join(DELIVERY, "masks", f)));
    const m = f.match(/F(\d+)_mask\.png$/);
    if (!m) continue;
    const mask = new Uint8Array(img.width * img.height);
    for (let i = 0; i < mask.length; i++) mask[i] = img.rgba[i * 4] > 127 ? 1 : 0;
    out.set(Number(m[1]), mask);
  }
  return out;
}

function meanAbsDiff(a: Frame, b: Frame, x0: number, y0: number, w: number, h: number): number {
  let sum = 0, n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const p = (y * W + x) * 4;
      sum += Math.abs(a.rgba[p] - b.rgba[p]); n++;
    }
  }
  return sum / n;
}

function main(): void {
  buildInputs();
  execFileSync(process.execPath, [
    "src/node/cli.ts",
    "--in", IN_DIR, "--out", DELIVERY, "--name", "SYNTH_TEST",
    "--fps", String(FPS), "--disable", String(DISABLED),
    "--manual-dir", MANUAL_DIR,
  ], { stdio: "inherit" });

  const manifest = JSON.parse(readFileSync(join(DELIVERY, "mask-manifest.json"), "utf8"));
  const out = loadDelivery();
  const masks = loadMasks();
  const input = (t: number): Frame => {
    const img = decodePng(readFileSync(join(IN_DIR, `f${String(t).padStart(4, "0")}.png`)));
    return { index: t, width: img.width, height: img.height, rgba: img.rgba };
  };

  // 1. Disabled frame passes through untouched.
  const d9 = out.get(DISABLED) as Frame, i9 = input(DISABLED);
  check("disabled frame untouched", meanAbsDiff(d9, i9, 0, 0, W, H) === 0);

  // 2. Dust repaired close to ground truth, grain retained.
  const clean5 = cleanFrame(5);
  const d5 = out.get(5) as Frame;
  const dustDiff = meanAbsDiff(d5, clean5, 34, 194, 13, 13);
  check("dust repaired", dustDiff < 8, `mean|Δ|=${dustDiff.toFixed(2)}`);
  const sigma5 = noiseSigma(toLuma(d5), W, H);
  check("grain not flattened", sigma5 > 2 && sigma5 < 4.5, `sigma=${sigma5.toFixed(2)}`);

  // 3. Scratch A repaired on active frames (rows clear of the moving circle).
  const clean10 = cleanFrame(10);
  const d10 = out.get(10) as Frame;
  const saDiff = meanAbsDiff(d10, clean10, SCRATCH_A_X, 120, 2, H - 120);
  check("transient scratch repaired", saDiff < 8, `mean|Δ|=${saDiff.toFixed(2)}`);

  // 4. Ambiguous scratch B locked as content, never repaired.
  const locked = manifest.lockedLines.some((l: { x: number }) => Math.abs(l.x - SCRATCH_B_X) <= 2);
  check("ambiguous line locked in manifest", locked);
  let bUntouched = true;
  for (let t = SCRATCH_B_RANGE[0]; t <= SCRATCH_B_RANGE[1]; t++) {
    if (t === MANUAL) continue;
    if (meanAbsDiff(out.get(t) as Frame, input(t), SCRATCH_B_X, 0, 1, H) !== 0) bUntouched = false;
  }
  check("locked line pixels untouched", bUntouched);

  // 5. Picture-content vertical line never masked.
  let contentSafe = true;
  for (const [t, mask] of masks) {
    void t;
    for (let y = 0; y < H; y++) {
      if (mask[y * W + CONTENT_LINE_X] || mask[y * W + CONTENT_LINE_X + 1]) contentSafe = false;
    }
  }
  check("content line never repaired", contentSafe);

  // 6. Moving object never masked (circle radius 12 + 1px safety margin).
  let motionSafe = true;
  for (const [t, mask] of masks) {
    const c = circleCenter(t);
    for (let y = c.y - 13; y <= c.y + 13; y++) {
      for (let x = c.x - 13; x <= c.x + 13; x++) {
        const dx = x - c.x, dy = y - c.y;
        if (dx * dx + dy * dy > 169) continue;
        if (x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x]) motionSafe = false;
      }
    }
  }
  check("moving object never repaired", motionSafe);

  // 7. Repairs confined to declared masks.
  let confined = true;
  for (let t = 0; t < N; t++) {
    if (t === DISABLED || t === MANUAL) continue;
    const o = out.get(t) as Frame, i = input(t);
    const mask = masks.get(t);
    for (let p = 0; p < W * H; p++) {
      if (o.rgba[p * 4] !== i.rgba[p * 4] && !(mask && mask[p])) confined = false;
    }
  }
  check("changes confined to masks", confined);

  // 8. Manual frame applied and logged.
  check("manual frame listed",
    manifest.manualFrames.includes(MANUAL) &&
    manifest.summary.manualEdits === 1);
  const manualImg = decodePng(readFileSync(join(MANUAL_DIR, `f${String(MANUAL).padStart(4, "0")}.png`)));
  const d14 = out.get(MANUAL) as Frame;
  check("manual frame applied",
    meanAbsDiff(d14, { index: MANUAL, width: W, height: H, rgba: manualImg.rgba }, 0, 0, W, H) === 0);
  check("manual-frames export exists",
    readdirSync(join(DELIVERY, "manual-frames")).some((f) => f.includes("manual")));

  // 9. Manifest completeness.
  check("manifest covers all frames", manifest.frames.length === N);
  const rep5 = manifest.frames.find((r: { frame: number }) => r.frame === 5);
  check("frame 5 mask has confidence + temporal fields",
    rep5.masks.length > 0 &&
    typeof rep5.masks[0].confidence === "number" &&
    typeof rep5.masks[0].temporal.persistence === "number" &&
    rep5.masks[0].decision === "repaired");
  check("grain stats recorded",
    rep5.masks[0].grainBefore > 0 && rep5.masks[0].grainAfter > 0);

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main();
