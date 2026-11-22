import {
  BASE_CROP_WIDTH,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  SOURCE_HEIGHT,
  SOURCE_WIDTH,
} from "./types.ts";
import type {
  CropFrame,
  CropResolution,
  Easing,
  Project,
  Rect,
  Shot,
} from "./types.ts";

const SAFE_MARGIN = 26;
const MIN_ZOOM = 0.33;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function ease(t: number, kind: Easing): number {
  const x = clamp(t, 0, 1);
  if (kind === "linear") return x;
  if (kind === "easeOut") return 1 - (1 - x) ** 3;
  return x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;
}

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function projectSafeUnion(shot: Shot): Rect | null {
  const rects = [shot.sourceBox];
  if (shot.safeGestures) rects.push(shot.gesture.rect);
  return unionRects(rects);
}

export function shotIndexAt(project: Project, time: number): number {
  if (time < (project.shots[0]?.start ?? 0)) return 0;
  const t = clamp(time, 0, Math.max(0, (project.shots.at(-1)?.end ?? 0) - 0.0001));
  for (let i = 0; i < project.shots.length; i += 1) {
    const shot = project.shots[i];
    if (t >= shot.start && t < shot.end) return i;
  }
  return Math.max(0, project.shots.length - 1);
}

function baseCrop(shot: Shot): CropFrame {
  const union = projectSafeUnion(shot);
  const requiredWidth = union && shot.safeGestures
    ? union.w + SAFE_MARGIN * 2
    : 0;
  const requestedWidth = clamp(
    BASE_CROP_WIDTH / clamp(shot.zoom, MIN_ZOOM, 2.4),
    1,
    SOURCE_WIDTH,
  );
  const width = clamp(Math.max(requestedWidth, requiredWidth), 1, SOURCE_WIDTH);
  const fullHeight = width > BASE_CROP_WIDTH;
  const height = fullHeight ? SOURCE_HEIGHT : SOURCE_HEIGHT * (width / BASE_CROP_WIDTH);
  const scale = fullHeight ? OUTPUT_WIDTH / width : OUTPUT_HEIGHT / height;

  const centerX = shot.sourceBox.x + shot.sourceBox.w / 2;
  const centerY = shot.sourceBox.y + shot.sourceBox.h / 2;
  let left = centerX - shot.target.x * width;
  let top = fullHeight ? 0 : centerY - shot.target.y * height;

  if (union && shot.safeGestures) {
    const minLeft = union.x + union.w + SAFE_MARGIN - width;
    const maxLeft = union.x - SAFE_MARGIN;
    left = minLeft <= maxLeft ? clamp(left, minLeft, maxLeft) : (minLeft + maxLeft) / 2;
  }
  left = clamp(left, 0, SOURCE_WIDTH - width);
  top = clamp(top, 0, SOURCE_HEIGHT - height);

  const drawW = OUTPUT_WIDTH;
  const drawH = fullHeight ? SOURCE_HEIGHT * scale : OUTPUT_HEIGHT;
  let drawY = fullHeight
    ? clamp(shot.target.y * OUTPUT_HEIGHT - centerY * scale, 0, OUTPUT_HEIGHT - drawH)
    : 0;
  if (fullHeight && drawH < OUTPUT_HEIGHT) {
    drawY = clamp(drawY, 0, OUTPUT_HEIGHT - drawH);
  }

  return {
    shotIndex: 0,
    shotId: shot.id,
    left,
    top,
    width,
    height,
    scale,
    drawX: 0,
    drawY,
    drawW,
    drawH,
    letterbox: fullHeight,
    effectiveZoom: BASE_CROP_WIDTH / width,
    fromShotId: null,
  };
}

function blendCrop(from: CropFrame, to: CropFrame, amount: number): CropFrame {
  const t = ease(amount, "easeInOut");
  return {
    ...to,
    left: lerp(from.left, to.left, t),
    top: lerp(from.top, to.top, t),
    width: lerp(from.width, to.width, t),
    height: lerp(from.height, to.height, t),
    scale: lerp(from.scale, to.scale, t),
    drawX: lerp(from.drawX, to.drawX, t),
    drawY: lerp(from.drawY, to.drawY, t),
    drawW: lerp(from.drawW, to.drawW, t),
    drawH: lerp(from.drawH, to.drawH, t),
    letterbox: from.letterbox || to.letterbox,
    effectiveZoom: lerp(from.effectiveZoom, to.effectiveZoom, t),
    fromShotId: from.shotId,
  };
}

export function resolveCrop(project: Project, time: number): CropResolution {
  const index = shotIndexAt(project, time);
  const shot = project.shots[index];
  const target = baseCrop(shot);
  let frame: CropFrame = { ...target, shotIndex: index };

  const next = project.shots[index + 1];
  if (next && next.panMs > 0) {
    const transitionStart = shot.end - next.panMs / 1000;
    const progress = (time - transitionStart) / (next.panMs / 1000);
    if (progress > 0 && progress < 1) {
      const upcoming = baseCrop(next);
      frame = blendCrop(target, upcoming, progress);
      frame.shotIndex = index;
      frame.shotId = shot.id;
      frame.fromShotId = shot.id;
    }
  }

  const union = projectSafeUnion(shot);
  const warnings: string[] = [];
  let contained = true;
  if (union && shot.safeGestures) {
    contained =
      union.x >= frame.left - 0.5 &&
      union.x + union.w <= frame.left + frame.width + 0.5;
    if (!contained) warnings.push("平移过程中手势短暂越过安全区");
  }
  if (shot.safeCaptions) {
    warnings.push("字幕按 86% 安全宽度自动换行");
  }
  return { frame, contained, warnings, safeUnion: union };
}

export function cropAtCut(project: Project, shot: Shot): CropFrame {
  const index = project.shots.findIndex((item) => item.id === shot.id);
  return { ...baseCrop(shot), shotIndex: Math.max(0, index) };
}
