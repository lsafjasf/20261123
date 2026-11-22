import type { Anchor, CurveSegment } from "./types.ts";

export interface LinearFit {
  intercept: number;
  slope: number;
  weights: Float64Array;
  residual: number;
}

export function weightedLinear(points: Anchor[]): LinearFit {
  const n = points.length;
  const weights = new Float64Array(n);
  for (let i = 0; i < n; i++) weights[i] = points[i]!.confidence;
  for (let iter = 0; iter < 6; iter++) {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      const w = weights[i]!;
      const x = points[i]!.t;
      const y = points[i]!.offsetMs;
      sw += w;
      sx += w * x;
      sy += w * y;
      sxx += w * x * x;
      sxy += w * x * y;
    }
    const det = sw * sxx - sx * sx;
    if (Math.abs(det) < 1e-14) break;
    const slope = (sw * sxy - sx * sy) / det;
    const intercept = (sy - slope * sx) / sw;
    let residualSum = 0;
    const residuals = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const r = Math.abs(points[i]!.offsetMs - (intercept + slope * points[i]!.t));
      residuals[i] = r;
      residualSum += r;
    }
    const mad = median(Array.from(residuals)) + 1e-6;
    let changed = false;
    for (let i = 0; i < n; i++) {
      const next = Math.max(0.02, Math.exp(-((residuals[i]! / (2.5 * mad)) ** 2)));
      if (Math.abs(next - weights[i]!) > 0.02) changed = true;
      weights[i] = next * points[i]!.confidence;
    }
    if (!changed && iter > 1) {
      return finalize(points, weights, intercept, slope);
    }
  }
  const fit = fitOnce(points, weights);
  return finalize(points, weights, fit.intercept, fit.slope);
}

function fitOnce(points: Anchor[], weights: Float64Array) {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < points.length; i++) {
    const w = weights[i]!;
    const x = points[i]!.t;
    const y = points[i]!.offsetMs;
    sw += w;
    sx += w * x;
    sy += w * y;
    sxx += w * x * x;
    sxy += w * x * y;
  }
  const det = sw * sxx - sx * sx;
  const slope = Math.abs(det) < 1e-14 ? 0 : (sw * sxy - sx * sy) / det;
  const intercept = (sy - slope * sx) / Math.max(1e-12, sw);
  return { intercept, slope };
}

function finalize(points: Anchor[], weights: Float64Array, intercept: number, slope: number): LinearFit {
  let weightedSse = 0;
  let sw = 0;
  for (let i = 0; i < points.length; i++) {
    const r = points[i]!.offsetMs - (intercept + slope * points[i]!.t);
    weightedSse += weights[i]! * r * r;
    sw += weights[i]!;
  }
  return { intercept, slope, weights, residual: Math.sqrt(weightedSse / Math.max(1e-12, sw)) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function fitSegmented(anchors: Anchor[], maxSegments: number, duration: number): { segments: CurveSegment[]; breakpoints: number[] } {
  if (anchors.length < 2) {
    return { segments: [], breakpoints: [] };
  }
  const ordered = [...anchors].sort((a, b) => a.t - b.t);
  const full = weightedLinear(ordered);
  let chosen: { boundaries: number[]; fits: LinearFit[]; bic: number } | null = null;

  for (let segCount = 1; segCount <= Math.min(maxSegments, ordered.length - 1); segCount++) {
    const candidate = searchBoundaries(ordered, segCount, duration, full);
    if (!chosen || candidate.bic < chosen.bic) chosen = candidate;
  }
  const best = chosen!;
  const segments: CurveSegment[] = [];
  for (let s = 0; s < best.fits.length; s++) {
    const start = best.boundaries[s]!;
    const end = best.boundaries[s + 1]!;
    const fit = best.fits[s]!;
    const inSeg = ordered.filter((a) => a.t >= start && (s === best.fits.length - 1 || a.t < end));
    const confidence = segmentConfidence(inSeg, fit);
    segments.push({
      index: s,
      start,
      end,
      offsetMsAtStart: fit.intercept + fit.slope * start,
      offsetMsAtEnd: fit.intercept + fit.slope * end,
      slopeMsPerSec: fit.slope,
      stretchFactor: 1 + fit.slope / 1000,
      confidence,
      residualMs: fit.residual,
      anchorCount: inSeg.length,
      enabled: true,
    });
  }
  return { segments, breakpoints: best.boundaries.slice(1, -1) };
}

function searchBoundaries(anchors: Anchor[], segCount: number, duration: number, full: LinearFit) {
  const n = anchors.length;
  const boundaries = [0];
  for (let s = 1; s < segCount; s++) boundaries.push(anchors[Math.round((s * n) / segCount)]!.t);
  boundaries.push(duration);

  let bestBic = Infinity;
  let bestFits: LinearFit[] = [];
  let bestBoundaries = boundaries.slice();
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let b = 1; b < segCount; b++) {
      let localBest = bestBic;
      let localT = boundaries[b]!;
      const prevT = boundaries[b - 1]!;
      const nextT = boundaries[b + 1]!;
      for (const anchor of anchors) {
        if (anchor.t <= prevT + 0.25 || anchor.t >= nextT - 0.25) continue;
        const trial = boundaries.slice();
        trial[b] = anchor.t;
        const scored = score(anchors, trial, full, segCount);
        if (scored.bic < localBest) {
          localBest = scored.bic;
          localT = anchor.t;
          moved = true;
        }
      }
      boundaries[b] = localT;
      bestBic = localBest;
    }
    const scored = score(anchors, boundaries, full, segCount);
    bestBic = scored.bic;
    bestFits = scored.fits;
    bestBoundaries = boundaries.slice();
    if (!moved) break;
  }
  return { boundaries: bestBoundaries, fits: bestFits, bic: bestBic };
}

function score(anchors: Anchor[], boundaries: number[], full: LinearFit, segCount: number) {
  const fits: LinearFit[] = [];
  let sse = 0;
  let count = 0;
  for (let s = 0; s < segCount; s++) {
    const part = anchors.filter((a) => a.t >= boundaries[s]! && (s === segCount - 1 || a.t < boundaries[s + 1]!));
    if (part.length < 2) return { bic: Infinity, fits: [] };
    const fit = weightedLinear(part);
    fits.push(fit);
    for (const anchor of part) {
      const r = anchor.offsetMs - (fit.intercept + fit.slope * anchor.t);
      sse += anchor.confidence * r * r;
      count++;
    }
  }
  const variance = Math.max(1e-9, sse / Math.max(1, count));
  const bic = count * Math.log(variance) + 2 * segCount * Math.log(count);
  return { bic, fits };
}

function segmentConfidence(anchorsInSegment: Anchor[], fit: LinearFit): number {
  if (anchorsInSegment.length === 0) return 0;
  const meanAnchor = anchorsInSegment.reduce((sum, a) => sum + a.confidence, 0) / anchorsInSegment.length;
  const coverage = Math.min(1, anchorsInSegment.length / 4);
  const residualPenalty = 1 / (1 + (fit.residual / 8) ** 2);
  return clamp01(meanAnchor * (0.5 + 0.3 * coverage + 0.2 * residualPenalty));
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
