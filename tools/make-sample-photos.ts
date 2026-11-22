// Generates a synthetic construction-site photo sequence for demo/testing.
// Simulates: camera drift (translate+scale), day/night brightness swing,
// abrupt exposure flicker, and construction progress. Node stdlib only.
// Run: node tools/make-sample-photos.ts [count] [width] [height]
import { deflateSync } from 'node:zlib';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, 'photos');

const COUNT = Number(process.argv[2] || 72);
const W = Number(process.argv[3] || 640);
const H = Number(process.argv[4] || 360);

// --- deterministic PRNG (mulberry32) ---
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- minimal PNG encoder (RGBA8, filter 0) ---
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba: Uint8Array, w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (1 + w * 4) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- tiny software rasterizer ---
type Pix = { data: Uint8Array; w: number; h: number };

function makePix(w: number, h: number): Pix {
  return { data: new Uint8Array(w * h * 4), w, h };
}
function put(p: Pix, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= p.w || y >= p.h) return;
  const i = (y * p.w + x) * 4;
  p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255;
}
function rect(p: Pix, x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number): void {
  for (let y = Math.max(0, y0 | 0); y < Math.min(p.h, y1 | 0); y++)
    for (let x = Math.max(0, x0 | 0); x < Math.min(p.w, x1 | 0); x++) put(p, x, y, r, g, b);
}
function disc(p: Pix, cx: number, cy: number, rad: number, r: number, g: number, b: number): void {
  for (let y = (cy - rad) | 0; y <= (cy + rad) | 0; y++)
    for (let x = (cx - rad) | 0; x <= (cx + rad) | 0; x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) put(p, x, y, r, g, b);
}

// --- scene: sky, sun, ground with texture, growing building, crane ---
function renderScene(frame: number, total: number, rand: () => number): Pix {
  const p = makePix(W, H);
  const t = frame / total;
  const horizon = (H * 0.58) | 0;

  // sky gradient (fixed colors; brightness applied later as exposure)
  for (let y = 0; y < horizon; y++) {
    const k = y / horizon;
    const r = 110 + 60 * k, g = 150 + 50 * k, b = 220 - 20 * k;
    for (let x = 0; x < W; x++) put(p, x, y, r, g, b);
  }
  // sun drifts across the sky
  disc(p, W * (0.15 + 0.7 * t), H * (0.12 + 0.1 * Math.sin(t * Math.PI)), 18, 250, 240, 190);

  // ground with deterministic speckle texture (good for template matching)
  const gr = rng(1234);
  const speck: number[] = [];
  for (let i = 0; i < 4000; i++) speck.push(gr() * W, horizon + gr() * (H - horizon), gr());
  rect(p, 0, horizon, W, H, 122, 105, 84);
  for (let i = 0; i < speck.length; i += 3) {
    const v = speck[i + 2];
    const c = 90 + v * 80;
    disc(p, speck[i], speck[i + 1], 1 + v * 2.5, c, c * 0.9, c * 0.75);
  }
  // a few distinctive ground markers (anchor targets)
  disc(p, W * 0.2, H * 0.8, 7, 210, 60, 40);
  disc(p, W * 0.78, H * 0.72, 7, 40, 90, 200);
  disc(p, W * 0.5, H * 0.9, 7, 230, 200, 60);

  // building grows one floor every few frames
  const floors = 2 + Math.floor(t * 8);
  const bx = W * 0.38, bw = W * 0.24, fh = H * 0.055;
  for (let f = 0; f < floors; f++) {
    const y1 = horizon - f * fh;
    rect(p, bx, y1 - fh + 2, bx + bw, y1, 168, 160, 150);
    for (let wx = 0; wx < 5; wx++)
      rect(p, bx + 8 + wx * (bw / 5.4), y1 - fh + 7, bx + 8 + wx * (bw / 5.4) + 9, y1 - 5, 60, 70, 90);
  }
  // crane
  rect(p, W * 0.66, horizon - H * 0.42, W * 0.66 + 5, horizon, 200, 160, 40);
  rect(p, W * 0.55, horizon - H * 0.42, W * 0.8, horizon - H * 0.42 + 5, 200, 160, 40);
  const hookX = W * (0.58 + 0.18 * ((frame % 20) / 20));
  rect(p, hookX, horizon - H * 0.42 + 5, hookX + 2, horizon - H * 0.3, 30, 30, 30);
  void rand;
  return p;
}

// --- camera drift + exposure model, then write PNGs ---
function resample(src: Pix, dx: number, dy: number, scale: number): Pix {
  const out = makePix(src.w, src.h);
  const cx = src.w / 2, cy = src.h / 2;
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const sx = cx + (x - cx - dx) / scale;
      const sy = cy + (y - cy - dy) / scale;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      for (let c = 0; c < 3; c++) {
        const g = (xx: number, yy: number): number => {
          const i = (Math.min(src.h - 1, Math.max(0, yy)) * src.w + Math.min(src.w - 1, Math.max(0, xx))) * 4 + c;
          return src.data[i];
        };
        const v = g(x0, y0) * (1 - fx) * (1 - fy) + g(x0 + 1, y0) * fx * (1 - fy)
          + g(x0, y0 + 1) * (1 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy;
        out.data[(y * src.w + x) * 4 + c] = v;
      }
      out.data[(y * src.w + x) * 4 + 3] = 255;
    }
  }
  return out;
}

function applyExposure(p: Pix, ev: number): void {
  const gain = Math.pow(2, ev);
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const lin = Math.pow(i / 255, 2.2) * gain;
    lut[i] = Math.round(Math.min(1, lin) ** (1 / 2.2) * 255);
  }
  for (let i = 0; i < p.data.length; i += 4) {
    p.data[i] = lut[p.data[i]];
    p.data[i + 1] = lut[p.data[i + 1]];
    p.data[i + 2] = lut[p.data[i + 2]];
  }
}

async function main(): Promise<void> {
  await fsp.mkdir(OUT_DIR, { recursive: true });
  const rand = rng(20261123);
  let camX = 0, camY = 0, camS = 1;
  const log: string[] = ['frame,ev_day,ev_flicker,dx,dy,scale'];

  for (let f = 0; f < COUNT; f++) {
    // slow random walk of the camera (bumped tripod)
    camX += (rand() - 0.5) * 1.6;
    camY += (rand() - 0.5) * 1.2;
    camS += (rand() - 0.5) * 0.0012;
    if (f === Math.floor(COUNT * 0.4)) camX += 7; // one real bump
    camS = Math.min(1.03, Math.max(0.97, camS));

    // exposure: smooth day/night curve + abrupt flicker events
    const evDay = 1.4 * Math.sin((f / COUNT) * Math.PI * 2 - Math.PI / 2);
    let evFlicker = (rand() - 0.5) * 0.5;
    if (rand() < 0.08) evFlicker += (rand() < 0.5 ? -1 : 1) * (0.8 + rand() * 0.8);

    const scene = renderScene(f, COUNT, rand);
    const shot = resample(scene, camX, camY, camS);
    applyExposure(shot, evDay + evFlicker);

    const name = `site_${String(f + 1).padStart(4, '0')}.png`;
    await fsp.writeFile(path.join(OUT_DIR, name), encodePng(shot.data, W, H));
    log.push([name, evDay.toFixed(3), evFlicker.toFixed(3), camX.toFixed(2), camY.toFixed(2), camS.toFixed(4)].join(','));
  }
  await fsp.writeFile(path.join(OUT_DIR, 'ground-truth.csv'), log.join('\n') + '\n');
  console.log(`wrote ${COUNT} frames to ${OUT_DIR}`);
}

await main();
