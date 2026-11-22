export type Sensitivity = "strict" | "balanced" | "aggressive";

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface EmbedOptions {
  creatorId: number;
  amplitude?: number;
  cellSize?: number;
}

export interface DetectOptions {
  maxDimension?: number;
  sensitivity?: Sensitivity;
  maxCandidates?: number;
}

export interface WatermarkGeometry {
  cellSize: number;
  offsetX: number;
  offsetY: number;
  phaseX: number;
  phaseY: number;
}

export interface TileEvidence {
  x: number;
  y: number;
  cells: number;
  agreement: number;
}

export interface FrameDetection {
  found: boolean;
  creatorId: number | null;
  confidence: number;
  score: number;
  syncMatches: number;
  crcValid: boolean;
  correctedBits: number;
  codeCorrelation: number;
  signal: number;
  geometry: WatermarkGeometry | null;
  bitMatrix: number[];
  bitValues: number[];
  tiles: TileEvidence[];
  checkedGeometries: number;
  elapsedMs: number;
  reason: string;
}

export interface MergedDetection {
  found: boolean;
  creatorId: number | null;
  confidence: number;
  hits: number;
  frames: number;
  consistency: number;
  evidence: FrameDetection[];
  reason: string;
}

export interface PixelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
