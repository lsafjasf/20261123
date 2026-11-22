export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MotionMode = "push-in" | "pull-out" | "pan" | "auto";

export interface ImageSpec {
  id: string;
  src: string;
  pixelWidth: number;
  pixelHeight: number;
  focusBox: Rect;
  usableFrame: Rect;
  motion?: MotionMode;
  narrationText?: string;
  narrationSrc?: string;
}

export interface NarrationConfig {
  baseHoldSeconds: number;
  minHoldSeconds: number;
  maxHoldSeconds: number;
  charsPerSecond: number;
  audioSlackSeconds: number;
  transitionSeconds: number;
  fullNarrationSrc?: string;
}

export interface VideoConfig {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  codec: "vp9" | "vp8" | "av1";
}

export interface Project {
  title: string;
  video: VideoConfig;
  narration: NarrationConfig;
  images: ImageSpec[];
}

export interface SegmentTiming {
  index: number;
  imageId: string;
  start: number;
  end: number;
  duration: number;
  enterAt: number;
  leaveAt: number;
  holdSeconds: number;
  narrationSeconds: number;
}

export interface Timeline {
  duration: number;
  frameCount: number;
  transitionSeconds: number;
  segments: SegmentTiming[];
}

export interface CameraKeyframe {
  time: number;
  crop: Rect;
}

export interface CameraPlan {
  imageId: string;
  enterAt: number;
  leaveAt: number;
  startCrop: Rect;
  endCrop: Rect;
  keyframes: CameraKeyframe[];
}

export interface CropSample {
  time: number;
  progress: number;
  crop: Rect;
}

export interface SegmentExportRecord {
  imageId: string;
  inPoint: number;
  outPoint: number;
  transitionIn: number;
  transitionOut: number;
  startCrop: Rect;
  endCrop: Rect;
  cropSamples: CropSample[];
}

export interface ExportManifest {
  title: string;
  exportedAt: string;
  video: VideoConfig;
  duration: number;
  frameCount: number;
  segments: SegmentExportRecord[];
}
