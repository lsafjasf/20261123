import type { Rect } from './types.ts';

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;

/** Frame-rate independent smoothstep easing for layout interpolation. */
export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

export const rectsEqual = (a: Rect, b: Rect, eps = 1e-6): boolean =>
  Math.abs(a.x - b.x) <= eps &&
  Math.abs(a.y - b.y) <= eps &&
  Math.abs(a.w - b.w) <= eps &&
  Math.abs(a.h - b.h) <= eps;

/** Intersection rectangle of two rects, or null when they do not overlap. */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export const rectArea = (r: Rect): number =>
  Math.max(0, r.w) * Math.max(0, r.h);

/**
 * Fraction (0..1) of `zone` covered by `occluder`.
 * Used by the HUD occlusion monitor; pure math so it is unit-testable in Node.
 */
export function coveredFraction(zone: Rect, occluder: Rect): number {
  const overlap = intersectRect(zone, occluder);
  if (!overlap) return 0;
  const zoneArea = rectArea(zone);
  if (zoneArea <= 0) return 0;
  return clamp(rectArea(overlap) / zoneArea, 0, 1);
}

export const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
});
