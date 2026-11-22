export const SOURCE_WIDTH = 1920;
export const SOURCE_HEIGHT = 1080;
export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;
export const BASE_CROP_WIDTH = (SOURCE_HEIGHT * OUTPUT_WIDTH) / OUTPUT_HEIGHT;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Easing = "linear" | "easeInOut" | "easeOut";

export interface Gesture {
  id: string;
  label: string;
  rect: Rect;
  start: number;
  end: number;
}

export interface Shot {
  id: string;
  person: "lin" | "zhou";
  speaker: string;
  role: string;
  start: number;
  end: number;
  text: string;
  sourceBox: Rect;
  gesture: Gesture;
  target: Point;
  zoom: number;
  easing: Easing;
  panMs: number;
  safeCaptions: boolean;
  safeGestures: boolean;
}

export interface Project {
  title: string;
  subtitle: string;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  fps: number;
  shots: Shot[];
}

export interface CropFrame {
  shotIndex: number;
  shotId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
  drawX: number;
  drawY: number;
  drawW: number;
  drawH: number;
  letterbox: boolean;
  effectiveZoom: number;
  fromShotId: string | null;
}

export interface CropResolution {
  frame: CropFrame;
  contained: boolean;
  warnings: string[];
  safeUnion: Rect | null;
}

export interface CaptionCue {
  id: string;
  start: number;
  end: number;
  text: string;
}
