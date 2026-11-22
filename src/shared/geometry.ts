import type { Rect } from "./types.ts";

export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    return (min + max) / 2;
  }
  return Math.min(max, Math.max(min, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothStep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function containRect(inner: Rect, outer: Rect): Rect {
  const width = clamp(inner.width, 0, outer.width);
  const height = clamp(inner.height, 0, outer.height);
  const x = clamp(inner.x, outer.x, outer.x + outer.width - width);
  const y = clamp(inner.y, outer.y, outer.y + outer.height - height);
  return { x, y, width, height };
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    width: lerp(a.width, b.width, t),
    height: lerp(a.height, b.height, t),
  };
}

export function rectCenter(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function rectAroundCenter(centerX: number, centerY: number, width: number, height: number): Rect {
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  };
}
