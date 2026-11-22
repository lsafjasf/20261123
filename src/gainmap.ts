// Resolution-independent 2D gain map.
//
// Gains live on a coarse grid in *normalized* coordinates (0..1 across the
// frame, independent of pixel resolution). Any target resolution samples the
// same continuous bilinear surface, so one mapping behaves identically when
// applied to 1080p, 4K, or a thumbnail.

export interface GainMapMeta {
  name: string;
  sourceWidth: number;
  sourceHeight: number;
  frames: number;
  maxGain: number;
  createdAt: string;
}

export interface GainMap {
  cols: number;
  rows: number;
  // Channel-planar grids, row-major, values >= 1 (multiplicative gain).
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  meta: GainMapMeta;
}

export function createGainMap(cols: number, rows: number, meta?: Partial<GainMapMeta>): GainMap {
  const n = cols * rows;
  const r = new Float32Array(n).fill(1);
  const g = new Float32Array(n).fill(1);
  const b = new Float32Array(n).fill(1);
  return {
    cols,
    rows,
    r,
    g,
    b,
    meta: {
      name: "gain-map",
      sourceWidth: 0,
      sourceHeight: 0,
      frames: 0,
      maxGain: 8,
      createdAt: new Date().toISOString(),
      ...meta,
    },
  };
}

// Bilinear sample of one channel plane at normalized coords (nx, ny in 0..1).
// Grid nodes sit at cell centers ((i+0.5)/cols); near the borders we
// linearly extrapolate instead of clamping, so corner falloff estimated
// from block-averaged flats is reproduced faithfully at the frame edges.
export function samplePlane(plane: Float32Array, cols: number, rows: number, nx: number, ny: number): number {
  const fx = Math.min(Math.max(nx, 0), 1) * cols - 0.5;
  const fy = Math.min(Math.max(ny, 0), 1) * rows - 0.5;
  let x0 = Math.floor(fx);
  let y0 = Math.floor(fy);
  x0 = Math.min(Math.max(x0, 0), cols - 2);
  y0 = Math.min(Math.max(y0, 0), rows - 2);
  const tx = fx - x0;
  const ty = fy - y0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const i00 = y0 * cols + x0;
  const i10 = y0 * cols + x1;
  const i01 = y1 * cols + x0;
  const i11 = y1 * cols + x1;
  const top = plane[i00] + (plane[i10] - plane[i00]) * tx;
  const bot = plane[i01] + (plane[i11] - plane[i01]) * tx;
  return top + (bot - top) * ty;
}

export interface RGBGain {
  r: number;
  g: number;
  b: number;
}

export function sampleGain(map: GainMap, nx: number, ny: number, out: RGBGain): RGBGain {
  out.r = samplePlane(map.r, map.cols, map.rows, nx, ny);
  out.g = samplePlane(map.g, map.cols, map.rows, nx, ny);
  out.b = samplePlane(map.b, map.cols, map.rows, nx, ny);
  return out;
}

// Serialize to a compact JSON-friendly object (rounded to 4 decimals).
export function serializeGainMap(map: GainMap): string {
  const pack = (a: Float32Array) => Array.from(a, (v) => Math.round(v * 1e4) / 1e4);
  return JSON.stringify({
    kind: "vignette-gain-map",
    version: 1,
    cols: map.cols,
    rows: map.rows,
    r: pack(map.r),
    g: pack(map.g),
    b: pack(map.b),
    meta: map.meta,
  });
}

export function deserializeGainMap(json: string): GainMap {
  const o = JSON.parse(json);
  if (o.kind !== "vignette-gain-map" || o.version !== 1) {
    throw new Error("unrecognized gain map file");
  }
  const cols = o.cols | 0;
  const rows = o.rows | 0;
  const n = cols * rows;
  const unpack = (a: number[], name: string) => {
    if (!Array.isArray(a) || a.length !== n) throw new Error(`bad channel: ${name}`);
    return Float32Array.from(a);
  };
  return {
    cols,
    rows,
    r: unpack(o.r, "r"),
    g: unpack(o.g, "g"),
    b: unpack(o.b, "b"),
    meta: { ...createGainMap(cols, rows).meta, ...o.meta },
  };
}
