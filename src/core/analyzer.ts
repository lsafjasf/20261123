import {
  buildSignature,
  profileSimilarity,
  rowCoverage,
  rowDifferences,
  toLumaPlane,
  type LumaPlane,
} from "./image.ts";
import type {
  AnalysisSummary,
  AnalyzerOptions,
  EvidenceTag,
  FrameAnalysis,
  FrameClass,
  FrameMetrics,
  FrameSignature,
  RGBAFrame,
  SeamEvidence,
} from "./types.ts";

const DEFAULTS: AnalyzerOptions = {
  analysisWidth: 384,
  minShiftPx: 2,
  minSupport: 0.42,
  maxHistory: 12,
};

interface Candidate {
  y: number;
  rank: number;
}

interface SeamResult {
  evidence: SeamEvidence;
  score: number;
}

export class TearingDetector {
  private readonly options: AnalyzerOptions;
  private readonly history: FrameSignature[] = [];
  private readonly lineHistory: number[] = [];
  private readonly seamHistory: Array<{ yRatio: number; shiftRatio: number; time: number }> = [];
  private frameIndex = 0;

  constructor(options: Partial<AnalyzerOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  reset(): void {
    this.history.length = 0;
    this.lineHistory.length = 0;
    this.seamHistory.length = 0;
    this.frameIndex = 0;
  }

  analyze(frame: RGBAFrame, timestampMs = frame.timestampMs ?? 0): FrameAnalysis {
    const plane = toLumaPlane(frame, this.options.analysisWidth);
    const rowDiff = rowDifferences(plane);
    const coverage = rowCoverage(plane);
    const signature = buildSignature(plane, rowDiff);
    const lineState = this.measureLines(plane, rowDiff, coverage, signature);
    const blockState = measureBlocks(plane);
    const temporal = this.measureTemporal(signature);
    const candidates = findCandidates(rowDiff, coverage);
    const seam = this.pickSeam(plane, rowDiff, coverage, candidates, temporal.skew);

    this.updateSeamHistory(seam?.evidence ?? null);

    const recurrence = this.seamRecurrence(seam?.evidence ?? null);
    const tearScore = seam?.score ?? 0;
    const lineBurst = Math.max(
      0,
      Math.min(1, (lineState.density - lineState.baseline - 0.018) / 0.13),
    );
    const vfxScore = clamp01(
      lineBurst * 0.56 +
        lineState.recurrence * Math.min(1, lineBurst * 2.4) * 0.24 +
        recurrence * 0.12 +
        temporal.skew * 0.08,
    );
    const encodeScore = clamp01(blockState.grid * 0.54 + blockState.anomaly * 0.58);
    const metrics: FrameMetrics = {
      lineDensity: lineState.density,
      lineBurst,
      lineRecurrence: lineState.recurrence,
      blockGrid: blockState.grid,
      blockAnomaly: blockState.anomaly,
      crossFrameSkew: temporal.skew,
      chromaShift: temporal.chromaShift,
    };

    const classification = classify(
      tearScore,
      encodeScore,
      vfxScore,
      seam,
      lineState,
      this.options,
    );
    const tags = buildTags(classification, seam, metrics, this.options);
    const confidence = confidenceFor(classification, tearScore, encodeScore, vfxScore, seam);

    this.history.push(signature);
    this.lineHistory.push(lineState.density);
    if (this.history.length > this.options.maxHistory) this.history.shift();
    if (this.lineHistory.length > this.options.maxHistory) this.lineHistory.shift();
    this.frameIndex += 1;

    return {
      index: this.frameIndex - 1,
      timestampMs,
      width: frame.width,
      height: frame.height,
      classification,
      confidence,
      tearScore,
      encodeScore,
      vfxScore,
      seam: seam?.evidence ?? null,
      metrics,
      tags,
      note: noteFor(classification, seam, lineState.baseline, blockState),
    };
  }

  private measureLines(
    plane: LumaPlane,
    rowDiff: Float32Array,
    coverage: Float32Array,
    signature: FrameSignature,
  ): { density: number; baseline: number; recurrence: number } {
    const sorted = Array.from(rowDiff).sort((a, b) => a - b);
    const lowQuantile = sorted[Math.floor(sorted.length * 0.35)] ?? 0;
    const threshold = Math.max(12, lowQuantile * 2.1);
    let strongRows = 0;
    for (let y = 2; y < plane.height; y += 1) {
      if (rowDiff[y] >= threshold && coverage[y] >= 0.46) strongRows += 1;
    }
    const density = strongRows / Math.max(1, plane.height);
    const baseline = median(this.lineHistory.slice(-10));
    let recurrence = 0;
    for (let i = this.history.length - 1; i >= Math.max(0, this.history.length - 5); i -= 1) {
      recurrence = Math.max(recurrence, profileSimilarity(signature.rowProfile, this.history[i].rowProfile));
    }
    return { density, baseline, recurrence };
  }

  private measureTemporal(signature: FrameSignature): { skew: number; chromaShift: number } {
    if (this.history.length === 0) return { skew: 0, chromaShift: 0 };
    let topLag = 0;
    let bottomLag = 0;
    let topDistance = Number.POSITIVE_INFINITY;
    let bottomDistance = Number.POSITIVE_INFINITY;
    for (let lag = 1; lag <= Math.min(6, this.history.length); lag += 1) {
      const previous = this.history[this.history.length - lag];
      const top = signatureDistance(signature.top, previous.top);
      const bottom = signatureDistance(signature.bottom, previous.bottom);
      if (top < topDistance) {
        topDistance = top;
        topLag = lag;
      }
      if (bottom < bottomDistance) {
        bottomDistance = bottom;
        bottomLag = lag;
      }
    }
    const lagDelta = Math.abs(topLag - bottomLag);
    const matchConfidence = clamp01(1 - (topDistance + bottomDistance) / 70);
    const skew = clamp01((lagDelta / 3) * 0.62 + matchConfidence * 0.18);
    return { skew, chromaShift: lagDelta / 6 };
  }

  private pickSeam(
    plane: LumaPlane,
    rowDiff: Float32Array,
    coverage: Float32Array,
    candidates: Candidate[],
    temporalSkew: number,
  ): SeamResult | null {
    let best: SeamResult | null = null;
    for (const candidate of candidates) {
      const result = evaluateSeam(plane, rowDiff, coverage, candidate.y, temporalSkew, this.options);
      if (!best || result.score > best.score) best = result;
    }
    if (best) {
      const center = Math.round(best.evidence.y);
      let refinedBest = best;
      for (let y = Math.max(3, center - 2); y <= Math.min(plane.height - 4, center + 2); y += 1) {
        if (y === center) continue;
        const adjusted = evaluateSeam(
          plane,
          rowDiff,
          coverage,
          y,
          temporalSkew,
          this.options,
        );
        const candidateValue = adjusted.score + Math.max(0, adjusted.evidence.seamGain) * 0.12;
        const currentValue =
          refinedBest.score + Math.max(0, refinedBest.evidence.seamGain) * 0.12;
        if (candidateValue > currentValue) {
          refinedBest = adjusted;
        }
      }
      best = refinedBest;
      best.evidence.y = Math.round(best.evidence.y / plane.scaleY);
      best.evidence.shift = Math.round(best.evidence.shift / plane.scaleX);
    }
    return best;
  }

  private updateSeamHistory(seam: SeamEvidence | null): void {
    if (!seam) return;
    this.seamHistory.push({
      yRatio: seam.yRatio,
      shiftRatio: seam.shiftRatio,
      time: this.frameIndex,
    });
    if (this.seamHistory.length > 16) this.seamHistory.shift();
  }

  private seamRecurrence(seam: SeamEvidence | null): number {
    if (!seam) return 0;
    let hits = 0;
    for (const previous of this.seamHistory.slice(-10, -1)) {
      if (
        Math.abs(previous.yRatio - seam.yRatio) < 0.018 &&
        Math.abs(previous.shiftRatio - seam.shiftRatio) < 0.0025
      ) {
        hits += 1;
      }
    }
    return clamp01(hits / 4);
  }
}

function findCandidates(rowDiff: Float32Array, coverage: Float32Array): Candidate[] {
  const ranked: Candidate[] = [];
  for (let y = 3; y < rowDiff.length - 3; y += 1) {
    const left = rowDiff[y - 1] ?? 0;
    const right = rowDiff[y + 1] ?? 0;
    if (rowDiff[y] < Math.max(left, right) * 0.82) continue;
    const rank = rowDiff[y] * (0.38 + coverage[y] * 0.62);
    ranked.push({ y, rank });
  }
  ranked.sort((a, b) => b.rank - a.rank);

  const picked: Candidate[] = [];
  const marked = new Uint8Array(rowDiff.length);
  for (const candidate of ranked) {
    if (marked[candidate.y]) continue;
    picked.push(candidate);
    for (let y = candidate.y - 2; y <= candidate.y + 2; y += 1) {
      if (y >= 0 && y < marked.length) marked[y] = 1;
    }
    if (picked.length >= 20) break;
  }
  const step = Math.max(4, Math.round(rowDiff.length / 42));
  for (let y = 4; y < rowDiff.length - 4; y += step) {
    if (marked[y]) continue;
    const rank = rowDiff[y] * (0.38 + coverage[y] * 0.62);
    picked.push({ y, rank });
    for (let near = y - 1; near <= y + 1; near += 1) marked[near] = 1;
  }
  return picked;
}

function evaluateSeam(
  plane: LumaPlane,
  rowDiff: Float32Array,
  coverage: Float32Array,
  y: number,
  temporalSkew: number,
  options: AnalyzerOptions,
): SeamResult {
  const { width, height, data } = plane;
  const band = Math.max(6, Math.min(12, Math.round(height * 0.05)));
  const maxShift = Math.max(6, Math.min(42, Math.round(width * 0.1)));
  const margin = maxShift + 2;
  const xStep = width > 300 ? 2 : 1;
  const rowPairs: Array<{ top: number; bottom: number }> = [];
  for (let i = 0; i < band; i += 1) {
    const top = y - 2 - i;
    const bottom = y + 1 + i;
    if (top > 2 && bottom < height - 2) rowPairs.push({ top, bottom });
  }
  if (rowPairs.length < 4) {
    return { evidence: emptySeam(y, height), score: 0 };
  }

  const scoreAt = (shift: number): number => {
    let total = 0;
    let count = 0;
    for (const pair of rowPairs) {
      const topRow = pair.top * width;
      const bottomRow = pair.bottom * width;
      for (let x = margin; x < width - margin; x += xStep) {
        total += Math.abs(data[topRow + x] - data[bottomRow + x + shift]);
        count += 1;
      }
    }
    return total / Math.max(1, count);
  };
  const pairSad = (top: number, bottom: number, shift: number): number => {
    const topRow = top * width;
    const bottomRow = bottom * width;
    let total = 0;
    let count = 0;
    for (let x = margin; x < width - margin; x += xStep) {
      total += Math.abs(data[topRow + x] - data[bottomRow + x + shift]);
      count += 1;
    }
    return total / Math.max(1, count);
  };

  const baseline = scoreAt(0);
  let bestShift = 0;
  let bestSad = baseline;
  for (let shift = -maxShift; shift <= maxShift; shift += 1) {
    if (shift === 0) continue;
    const sad = scoreAt(shift);
    if (sad < bestSad) {
      bestSad = sad;
      bestShift = shift;
    }
  }

  const rowVotes: number[] = [];
  let alignedRows = 0;
  let improvedRows = 0;
  for (const pair of rowPairs) {
    const topRow = pair.top * width;
    const bottomRow = pair.bottom * width;
    let rowBaseline = 0;
    let rowBest = Number.POSITIVE_INFINITY;
    let rowShift = 0;
    let count = 0;
    for (let x = margin; x < width - margin; x += xStep) {
      rowBaseline += Math.abs(data[topRow + x] - data[bottomRow + x]);
      count += 1;
    }
    rowBaseline /= Math.max(1, count);
    for (let shift = -maxShift; shift <= maxShift; shift += 1) {
      let sad = 0;
      for (let x = margin; x < width - margin; x += xStep) {
        sad += Math.abs(data[topRow + x] - data[bottomRow + x + shift]);
      }
      sad /= Math.max(1, count);
      if (sad < rowBest) {
        rowBest = sad;
        rowShift = shift;
      }
    }
    if (Math.abs(rowShift - bestShift) <= 1) alignedRows += 1;
    if (rowBest < rowBaseline * 0.84 && Math.abs(rowShift) >= options.minShiftPx) {
      improvedRows += 1;
      rowVotes.push(rowShift);
    }
  }

  const support = (alignedRows / rowPairs.length) * 0.55 + (improvedRows / rowPairs.length) * 0.45;
  const gain = (baseline - bestSad) / (baseline + 4);
  const seamBaseline = pairSad(y - 1, y, 0);
  const seamAligned = pairSad(y - 1, y, bestShift);
  const seamGain = (seamBaseline - seamAligned) / (seamBaseline + 3);
  const shiftMagnitude = Math.abs(bestShift);
  const boundary = rowDiff[y] ?? 0;
  const boundaryScore = clamp01(boundary / 26) * 0.5 + coverage[y] * 0.5;
  const shiftScore = clamp01((shiftMagnitude - 1) / 9);
  const temporal = clamp01(temporalSkew);
  const confidence = clamp01(
    clamp01(gain / 0.38) * 0.36 +
      support * 0.28 +
      shiftScore * 0.18 +
      boundaryScore * 0.12 +
      temporal * 0.06,
  );
  const reject =
    shiftMagnitude < options.minShiftPx ||
    support < options.minSupport ||
    gain < 0.16 ||
    seamGain < 0.22 ||
    boundary < 2.5 ||
    coverage[y] < 0.14 ||
    rowVotes.length < Math.max(3, rowPairs.length * 0.3);

  return {
    evidence: {
      y,
      yRatio: y / height,
      shift: bestShift,
      shiftRatio: bestShift / width,
      boundary,
      matchGain: gain,
      seamGain,
      seamResidual: seamAligned,
      seamBaseline,
      support,
      confidence,
      temporalSkew: temporal,
    },
    score: reject ? confidence * 0.32 : confidence,
  };
}

function emptySeam(y: number, height: number): SeamEvidence {
  return {
    y,
    yRatio: y / height,
    shift: 0,
    shiftRatio: 0,
    boundary: 0,
    matchGain: 0,
    seamGain: 0,
    seamResidual: 0,
    seamBaseline: 0,
    support: 0,
    confidence: 0,
    temporalSkew: 0,
  };
}

function signatureDistance(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / Math.max(1, length);
}

function measureBlocks(plane: LumaPlane): { grid: number; anomaly: number } {
  const { width, height, data } = plane;
  const xEdges = new Float32Array(width);
  const yEdges = new Float32Array(height);
  for (let y = 1; y < height; y += 1) {
    for (let x = 1; x < width; x += 1) {
      const at = y * width + x;
      const horizontal = Math.abs(data[at] - data[at - 1]);
      const vertical = Math.abs(data[at] - data[at - width]);
      xEdges[x] += horizontal;
      yEdges[y] += vertical;
    }
  }
  for (let x = 0; x < width; x += 1) xEdges[x] /= Math.max(1, height - 1);
  for (let y = 0; y < height; y += 1) yEdges[y] /= Math.max(1, width - 1);

  let grid = 0;
  let anomaly = 0;
  for (let period = 4; period <= 24; period += 1) {
    if (period >= height / 3 || period >= width / 3) continue;
    let onX = 0;
    let offX = 0;
    let onY = 0;
    let offY = 0;
    for (let x = 1; x < width - 1; x += 1) {
      if (x % period === 0) onX += xEdges[x];
      else offX += xEdges[x];
    }
    for (let y = 1; y < height - 1; y += 1) {
      if (y % period === 0) onY += yEdges[y];
      else offY += yEdges[y];
    }
    const onXMean = onX / Math.max(1, Math.floor(width / period));
    const offXMean = offX / Math.max(1, width - Math.floor(width / period));
    const onYMean = onY / Math.max(1, Math.floor(height / period));
    const offYMean = offY / Math.max(1, height - Math.floor(height / period));
    const ratioX = onXMean / (offXMean + 0.2);
    const ratioY = onYMean / (offYMean + 0.2);
    const ratio = Math.sqrt(Math.max(0.1, ratioX) * Math.max(0.1, ratioY));
    grid = Math.max(grid, clamp01((ratio - 1.02) / 1.1));
    anomaly = Math.max(anomaly, blockMeanAnomaly(plane, period));
  }
  return { grid, anomaly };
}

function blockMeanAnomaly(plane: LumaPlane, blockSize: number): number {
  const { width, height, data } = plane;
  const cols = Math.floor(width / blockSize);
  const rows = Math.floor(height / blockSize);
  if (cols < 3 || rows < 3) return 0;
  const means = new Float32Array(cols * rows);
  const textures = new Float32Array(cols * rows);
  for (let by = 0; by < rows; by += 1) {
    for (let bx = 0; bx < cols; bx += 1) {
      let sum = 0;
      let sumSq = 0;
      let count = 0;
      for (let y = by * blockSize; y < (by + 1) * blockSize; y += 1) {
        for (let x = bx * blockSize; x < (bx + 1) * blockSize; x += 1) {
          const value = data[y * width + x];
          sum += value;
          sumSq += value * value;
          count += 1;
        }
      }
      const at = by * cols + bx;
      means[at] = sum / Math.max(1, count);
      textures[at] = Math.sqrt(Math.max(0, sumSq / Math.max(1, count) - means[at] ** 2));
    }
  }
  let abnormal = 0;
  let total = 0;
  for (let by = 1; by < rows - 1; by += 1) {
    for (let bx = 1; bx < cols - 1; bx += 1) {
      const at = by * cols + bx;
      const horizontalDelta =
        (Math.abs(means[at] - means[at - 1]) + Math.abs(means[at] - means[at + 1])) / 2;
      const verticalDelta =
        (Math.abs(means[at] - means[at - cols]) + Math.abs(means[at] - means[at + cols])) / 2;
      const delta = Math.min(horizontalDelta, verticalDelta);
      const harsh = clamp01((textures[at] - 22) / 40);
      if (delta > 11 && harsh > 0.12) abnormal += Math.min(1, delta / 42) * (0.55 + harsh);
      total += 1;
    }
  }
  return clamp01((abnormal / Math.max(1, total)) * 8.5);
}

function classify(
  tearScore: number,
  encodeScore: number,
  vfxScore: number,
  seam: SeamResult | null,
  line: { density: number; baseline: number },
  options: AnalyzerOptions,
): FrameClass {
  const seamValid =
    seam !== null &&
    seam.evidence.matchGain >= 0.15 &&
    seam.evidence.seamGain >= 0.22 &&
    seam.evidence.support >= options.minSupport &&
    Math.abs(seam.evidence.shift) >= options.minShiftPx;
  if (seamValid && tearScore >= 0.57 && tearScore >= Math.max(encodeScore, vfxScore) + 0.02) {
    return "tear";
  }
  if (vfxScore >= 0.57 && tearScore < 0.58 && vfxScore + 0.1 >= encodeScore) {
    return "vfx-glitch";
  }
  if (encodeScore >= 0.58 && encodeScore >= tearScore) return "encode-block";
  if (line.density - line.baseline > 0.07 && tearScore < 0.45) return "uncertain";
  if (Math.max(tearScore, encodeScore, vfxScore) >= 0.43) return "uncertain";
  return "normal";
}

function confidenceFor(
  classification: FrameClass,
  tearScore: number,
  encodeScore: number,
  vfxScore: number,
  seam: SeamResult | null,
): number {
  if (classification === "tear") return clamp01((tearScore + (seam?.evidence.confidence ?? 0)) / 2);
  if (classification === "encode-block") return encodeScore;
  if (classification === "vfx-glitch") return vfxScore;
  if (classification === "uncertain") return Math.max(tearScore, encodeScore, vfxScore);
  return clamp01(1 - Math.max(tearScore, encodeScore, vfxScore));
}

function buildTags(
  classification: FrameClass,
  seam: SeamResult | null,
  metrics: FrameMetrics,
  options: AnalyzerOptions,
): EvidenceTag[] {
  const tags: EvidenceTag[] = [];
  if (
    seam &&
    Math.abs(seam.evidence.shift) >= options.minShiftPx &&
    (classification === "tear" ||
      (seam.evidence.matchGain >= 0.2 && seam.evidence.seamGain >= 0.22))
  ) {
    tags.push("seam-shift");
  }
  if (metrics.crossFrameSkew > 0.34) tags.push("cross-time-skew");
  if (metrics.blockGrid > 0.42) tags.push("block-grid");
  if (metrics.blockAnomaly > 0.4) tags.push("localized-block");
  if (metrics.lineBurst > 0.34) tags.push("line-burst");
  if (metrics.lineRecurrence > 0.68) tags.push("recurring-pattern");
  if (metrics.lineDensity > 0.09 && metrics.lineBurst < 0.22) tags.push("scanline-baseline");
  if (seam && seam.evidence.support < options.minSupport) tags.push("low-shift-support");
  if (classification !== "tear" && metrics.lineDensity > 0.08) tags.push("no-horizontal-shift");
  return tags;
}

function noteFor(
  classification: FrameClass,
  seam: SeamResult | null,
  baseline: number,
  blocks: { grid: number; anomaly: number },
): string {
  if (classification === "tear") {
    return `上下窗带在 ${seam?.evidence.shift ?? 0}px 位移处吻合，支持度 ${Math.round(
      (seam?.evidence.support ?? 0) * 100,
    )}%`;
  }
  if (classification === "encode-block") {
    return `块状边界与局部均值异常突出（网格 ${Math.round(blocks.grid * 100)}%）`;
  }
  if (classification === "vfx-glitch") {
    return "横线密度突然抬升并跨帧复现，未形成稳定整幅水平位移";
  }
  if (classification === "uncertain") {
    return "存在异常横纹，但位移支持或跨帧证据不足";
  }
  if (seam && Math.abs(seam.evidence.shift) >= 2) {
    return "检出局部横线候选，但缝隙残差/整幅支持未达到撕裂阈值";
  }
  return baseline > 0.08 ? "横线密度属于本片段常态基线" : "未发现整幅水平断层";
}

export function summarize(frames: FrameAnalysis[]): AnalysisSummary {
  const counts: Record<FrameClass, number> = {
    normal: 0,
    tear: 0,
    "encode-block": 0,
    "vfx-glitch": 0,
    uncertain: 0,
  };
  let confidence = 0;
  for (const frame of frames) {
    counts[frame.classification] += 1;
    if (frame.classification !== "normal") confidence += frame.confidence;
  }
  const total = Math.max(1, frames.length);
  const ratios = Object.fromEntries(
    Object.entries(counts).map(([key, count]) => [key, count / total]),
  ) as Record<FrameClass, number>;
  const flaggedFrames = counts.tear + counts["encode-block"] + counts["vfx-glitch"] + counts.uncertain;
  return {
    frames: frames.length,
    counts,
    ratios,
    flaggedFrames,
    averageConfidence: confidence / Math.max(1, flaggedFrames),
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export interface SeamProbe {
  y: number;
  score: number;
  evidence: SeamEvidence;
  accepted: boolean;
}

export function probeSeams(frame: RGBAFrame, options: Partial<AnalyzerOptions> = {}): SeamProbe[] {
  const merged = { ...DEFAULTS, ...options };
  const plane = toLumaPlane(frame, merged.analysisWidth);
  const rowDiff = rowDifferences(plane);
  const coverage = rowCoverage(plane);
  return findCandidates(rowDiff, coverage)
    .map((candidate) => {
      const result = evaluateSeam(plane, rowDiff, coverage, candidate.y, 0, merged);
      result.evidence.y = Math.round(result.evidence.y / plane.scaleY);
      result.evidence.shift = Math.round(result.evidence.shift / plane.scaleX);
      return {
        y: result.evidence.y,
        score: result.score,
        evidence: result.evidence,
        accepted:
          result.evidence.matchGain >= 0.16 &&
          result.evidence.seamGain >= 0.22 &&
          result.evidence.support >= merged.minSupport,
      };
    })
    .sort((a, b) => b.score - a.score);
}
