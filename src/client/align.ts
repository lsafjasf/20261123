// Anchor-based alignment: normalized cross-correlation template matching
// plus a least-squares fit of translation + uniform scale (no rotation).
import type { Anchor, Transform } from './types.ts';

export interface GrayImage {
  data: Float32Array;
  w: number;
  h: number;
}

// Downsampled grayscale pyramid level for fast matching.
export function toGray(src: Uint8ClampedArray, w: number, h: number, step = 1): GrayImage {
  const gw = Math.floor(w / step);
  const gh = Math.floor(h / step);
  const data = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = ((y * step) * w + x * step) * 4;
      data[y * gw + x] = 0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2];
    }
  }
  return { data, w: gw, h: gh };
}

export interface MatchResult {
  x: number; // subpixel position in target (full-res coords)
  y: number;
  ncc: number;
}

// NCC template match of `tpl` (taken from reference at refX/refY) inside
// a search window around the predicted position in `target`.
export function matchTemplate(
  ref: GrayImage,
  target: GrayImage,
  refX: number,
  refY: number,
  tplRadius: number,
  searchRadius: number,
  scale: number, // target pixels per ref pyramid pixel (== step)
): MatchResult | null {
  const r = tplRadius;
  const cx = Math.round(refX / scale);
  const cy = Math.round(refY / scale);
  if (cx - r < 0 || cy - r < 0 || cx + r >= ref.w || cy + r >= ref.h) return null;

  const size = 2 * r + 1;
  const tpl = new Float32Array(size * size);
  let tMean = 0;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const v = ref.data[(cy - r + j) * ref.w + (cx - r + i)];
      tpl[j * size + i] = v;
      tMean += v;
    }
  }
  tMean /= tpl.length;
  let tVar = 0;
  for (let i = 0; i < tpl.length; i++) {
    tpl[i] -= tMean;
    tVar += tpl[i] * tpl[i];
  }
  if (tVar < 1e-3) return null; // featureless patch

  let best = -2;
  let bestX = 0;
  let bestY = 0;
  const sr = searchRadius;
  for (let oy = -sr; oy <= sr; oy++) {
    for (let ox = -sr; ox <= sr; ox++) {
      const px = cx + ox;
      const py = cy + oy;
      if (px - r < 0 || py - r < 0 || px + r >= target.w || py + r >= target.h) continue;
      let sMean = 0;
      for (let j = 0; j < size; j++) {
        const row = (py - r + j) * target.w + (px - r);
        for (let i = 0; i < size; i++) sMean += target.data[row + i];
      }
      sMean /= tpl.length;
      let cov = 0;
      let sVar = 0;
      for (let j = 0; j < size; j++) {
        const row = (py - r + j) * target.w + (px - r);
        for (let i = 0; i < size; i++) {
          const d = target.data[row + i] - sMean;
          cov += tpl[j * size + i] * d;
          sVar += d * d;
        }
      }
      const ncc = cov / Math.sqrt(tVar * sVar + 1e-9);
      if (ncc > best) {
        best = ncc;
        bestX = px;
        bestY = py;
      }
    }
  }
  if (best < 0.5) return null; // weak match
  return { x: bestX * scale, y: bestY * scale, ncc: best };
}

// Least-squares fit of q_i ≈ s * p_i + t (uniform scale + translation).
// Returns null when there are too few points to be trustworthy.
export function fitSimilarity(
  refPts: Anchor[],
  matched: (MatchResult | null)[],
  minNcc = 0.6,
): { transform: Transform; residualPx: number; used: number } | null {
  const px: number[] = [];
  const py: number[] = [];
  const qx: number[] = [];
  const qy: number[] = [];
  for (let i = 0; i < refPts.length; i++) {
    const m = matched[i];
    if (!m || m.ncc < minNcc) continue;
    px.push(refPts[i].x);
    py.push(refPts[i].y);
    qx.push(m.x);
    qy.push(m.y);
  }
  const n = px.length;
  if (n === 0) return null;

  const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / n;
  const mxp = mean(px), myp = mean(py), mxq = mean(qx), myq = mean(qy);

  let s = 1;
  if (n >= 2) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (px[i] - mxp) * (qx[i] - mxq) + (py[i] - myp) * (qy[i] - myq);
      den += (px[i] - mxp) ** 2 + (py[i] - myp) ** 2;
    }
    if (den > 1e-6) s = num / den;
  }
  // Only "justified" motion: clamp to a sane physical range.
  s = Math.min(1.15, Math.max(0.85, s));
  const tx = mxq - s * mxp;
  const ty = myq - s * myp;

  let err = 0;
  for (let i = 0; i < n; i++) {
    err += (s * px[i] + tx - qx[i]) ** 2 + (s * py[i] + ty - qy[i]) ** 2;
  }
  return { transform: { s, tx, ty }, residualPx: Math.sqrt(err / n), used: n };
}

// Convenience: align one frame against the reference using given anchors.
export function alignFrame(
  refGray: GrayImage,
  frameGray: GrayImage,
  anchors: Anchor[],
  step: number,
  tplRadius = 12,
  searchRadius = 20,
): { transform: Transform; residualPx: number; used: number; matches: (MatchResult | null)[] } | null {
  const matches = anchors.map((a) =>
    matchTemplate(refGray, frameGray, a.x, a.y, tplRadius, searchRadius, step),
  );
  const fit = fitSimilarity(anchors, matches);
  if (!fit) return null;
  return { ...fit, matches };
}
