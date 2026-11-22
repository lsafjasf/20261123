import type { CameraKeyframe, CropSample, MotionMode, Rect } from "./types.ts";
import {
  clamp,
  easeInOutCubic,
  lerpRect,
  rectAroundCenter,
  rectCenter,
} from "./geometry.ts";

export interface CameraInput {
  imageId: string;
  pixelWidth: number;
  pixelHeight: number;
  focusBox: Rect;
  usableFrame: Rect;
  mode: MotionMode;
  outputAspect: number;
  index: number;
}

export interface CameraPlan {
  imageId: string;
  startCrop: Rect;
  endCrop: Rect;
  keyframes: CameraKeyframe[];
}

const PUSH_START_SCALE = 1;
const PUSH_END_SCALE = 0.72;
const PAN_WIDTH_SCALE = 0.82;

interface CenterRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function maxCropWidth(usable: Rect, aspect: number): number {
  return Math.min(usable.width, usable.height * aspect);
}

function minCoverWidth(focus: Rect, aspect: number): number {
  return Math.max(focus.width, focus.height * aspect);
}

function centerRangeFor(usable: Rect, focus: Rect, width: number, height: number): CenterRange {
  const minX = Math.max(usable.x + width / 2, focus.x + focus.width - width / 2);
  const maxX = Math.min(usable.x + usable.width - width / 2, focus.x + width / 2);
  const minY = Math.max(usable.y + height / 2, focus.y + focus.height - height / 2);
  const maxY = Math.min(usable.y + usable.height - height / 2, focus.y + height / 2);
  return {
    minX: clamp(minX, -Infinity, maxX),
    maxX,
    minY: clamp(minY, -Infinity, maxY),
    maxY,
  };
}

function pickCenters(
  range: CenterRange,
  focusCenter: { x: number; y: number },
  drift: number,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const startX = clamp(focusCenter.x - drift * (range.maxX - range.minX), range.minX, range.maxX);
  const endX = clamp(focusCenter.x + drift * (range.maxX - range.minX), range.minX, range.maxX);
  const startY = clamp(focusCenter.y - drift * 0.35 * (range.maxY - range.minY), range.minY, range.maxY);
  const endY = clamp(focusCenter.y + drift * 0.35 * (range.maxY - range.minY), range.minY, range.maxY);
  return {
    start: { x: startX, y: startY },
    end: { x: endX, y: endY },
  };
}

function focusCenters(range: CenterRange, focusCenter: { x: number; y: number }) {
  const x = clamp(focusCenter.x, range.minX, range.maxX);
  const y = clamp(focusCenter.y, range.minY, range.maxY);
  const center = { x, y };
  return { start: center, end: center };
}

export function buildCameraPlan(input: CameraInput): CameraPlan {
  const usable = input.usableFrame;
  const focus = input.focusBox;
  const aspect = input.outputAspect;
  const limit = maxCropWidth(usable, aspect);
  const cover = minCoverWidth(focus, aspect);
  const mode: MotionMode = input.mode === "auto"
    ? (input.index % 2 === 0 ? "push-in" : "pull-out")
    : input.mode;

  let startWidth: number;
  let endWidth: number;
  let drift: number;

  if (mode === "push-in") {
    startWidth = clamp(limit * PUSH_START_SCALE, cover, limit);
    endWidth = clamp(limit * PUSH_END_SCALE, cover, limit);
    drift = -0.25;
  } else if (mode === "pull-out") {
    startWidth = clamp(limit * PUSH_END_SCALE, cover, limit);
    endWidth = clamp(limit * PUSH_START_SCALE, cover, limit);
    drift = 0.25;
  } else {
    const width = clamp(limit * PAN_WIDTH_SCALE, cover, limit);
    startWidth = width;
    endWidth = width;
    drift = input.index % 2 === 0 ? 0.4 : -0.4;
  }

  const startHeight = startWidth / aspect;
  const endHeight = endWidth / aspect;
  const startRange = centerRangeFor(usable, focus, startWidth, startHeight);
  const endRange = centerRangeFor(usable, focus, endWidth, endHeight);
  const focusCenter = rectCenter(focus);

  const startPicked = mode === "pan"
    ? pickCenters(startRange, focusCenter, drift)
    : focusCenters(startRange, focusCenter);
  const endPicked = mode === "pan"
    ? pickCenters(endRange, focusCenter, drift)
    : focusCenters(endRange, focusCenter);

  const startCrop = rectAroundCenter(startPicked.start.x, startPicked.start.y, startWidth, startHeight);
  const endCrop = rectAroundCenter(endPicked.end.x, endPicked.end.y, endWidth, endHeight);

  return {
    imageId: input.imageId,
    startCrop,
    endCrop,
    keyframes: [
      { time: 0, crop: startCrop },
      { time: 1, crop: endCrop },
    ],
  };
}

export function cropAt(plan: CameraPlan, progress: number): Rect {
  const t = easeInOutCubic(progress);
  return lerpRect(plan.startCrop, plan.endCrop, t);
}

export function sampleCrops(plan: CameraPlan, count: number): CropSample[] {
  const samples: CropSample[] = [];
  const total = Math.max(2, count);
  for (let i = 0; i < total; i += 1) {
    const progress = i / (total - 1);
    samples.push({ time: progress, progress, crop: cropAt(plan, progress) });
  }
  return samples;
}


