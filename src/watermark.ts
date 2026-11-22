import {
  buildIntegral,
  cloneImage,
  fitWithin,
  rectMean,
  toLuma
} from "./image.ts";
import {
  CODE_BITS,
  TILE_COLS,
  TILE_ROWS,
  buildPayload,
  decodeSymbols,
  validateCreatorId
} from "./payload.ts";
import type { DecodedPayload } from "./payload.ts";
import type {
  DetectOptions,
  EmbedOptions,
  FrameDetection,
  MergedDetection,
  RgbaImage,
  Sensitivity,
  TileEvidence,
  WatermarkGeometry
} from "./types.ts";

const SEARCH_CELLS = 32;
const DEFAULT_MAX_DIMENSION = 1100;
const SYNC_SYMBOLS = buildPayload(1).symbols.slice(0, 16);

export function chooseCellSize(width: number, height: number): number {
  return Math.max(14, Math.min(30, Math.round(Math.min(width, height) / 42)));
}

export function embedWatermark(image: RgbaImage, options: EmbedOptions): RgbaImage {
  const creatorId = validateCreatorId(options.creatorId);
  const amplitude = Math.max(0.8, Math.min(14, options.amplitude ?? 3.8));
  const cellSize = Math.max(8, Math.min(64, Math.round(options.cellSize ?? chooseCellSize(image.width, image.height))));
  const symbols = buildPayload(creatorId).symbols;
  const output = cloneImage(image);
  const data = output.data;
  const windowX = new Float32Array(cellSize);
  const windowY = new Float32Array(cellSize);

  for (let index = 0; index < cellSize; index += 1) {
    const window = Math.sin(Math.PI * ((index + 0.5) / cellSize));
    windowX[index] = window;
    windowY[index] = window;
  }

  for (let y = 0; y < output.height; y += 1) {
    const cellY = Math.floor(y / cellSize);
    const rowBit = (cellY % TILE_ROWS) * TILE_COLS;
    const wy = windowY[y % cellSize];
    for (let x = 0; x < output.width; x += 1) {
      const cellX = Math.floor(x / cellSize);
      const bit = rowBit + (cellX % TILE_COLS);
      const sign = symbols[bit] === 1 ? 1 : -1;
      const delta = amplitude * sign * windowX[x % cellSize] * wy;
      const offset = (y * output.width + x) * 4;
      data[offset] = data[offset] + delta;
      data[offset + 1] = data[offset + 1] + delta;
      data[offset + 2] = data[offset + 2] + delta;
    }
  }
  return output;
}

interface SearchHit {
  creatorId: number;
  confidence: number;
  score: number;
  syncMatches: number;
  correctedBits: number;
  codeCorrelation: number;
  signal: number;
  geometry: WatermarkGeometry;
  observedSymbols: Uint8Array;
  values: Float32Array;
  period: Float32Array;
  counts: Uint16Array;
  gridCols: number;
  gridRows: number;
  startCol: number;
  startRow: number;
  residuals: Float32Array;
  cellSize: number;
  offsetX: number;
  offsetY: number;
}

function sensitivityFloor(sensitivity: Sensitivity): {
  confidence: number;
  sync: number;
  correlation: number;
} {
  if (sensitivity === "strict") return { confidence: 76, sync: 16, correlation: 0.2 };
  if (sensitivity === "aggressive") return { confidence: 42, sync: 14, correlation: 0.08 };
  return { confidence: 58, sync: 15, correlation: 0.14 };
}

function buildPeriod(
  integral: Float64Array,
  stride: number,
  width: number,
  height: number,
  cellSize: number,
  offsetX: number,
  offsetY: number
): {
  period: Float32Array;
  counts: Uint16Array;
  gridCols: number;
  gridRows: number;
  startCol: number;
  startRow: number;
  residuals: Float32Array;
} | null {
  const totalCols = Math.floor((width - offsetX) / cellSize);
  const totalRows = Math.floor((height - offsetY) / cellSize);
  if (totalCols < TILE_COLS || totalRows < TILE_ROWS) return null;

  const gridCols = Math.min(SEARCH_CELLS, totalCols);
  const gridRows = Math.min(SEARCH_CELLS, totalRows);
  const startCol = Math.floor((totalCols - gridCols) / 2);
  const startRow = Math.floor((totalRows - gridRows) / 2);
  const means = new Float32Array(gridRows * gridCols);
  const inner = cellSize * 0.5;

  for (let row = 0; row < gridRows; row += 1) {
    const y0 = offsetY + (startRow + row) * cellSize + inner * 0.5;
    const y1 = y0 + inner;
    for (let col = 0; col < gridCols; col += 1) {
      const x0 = offsetX + (startCol + col) * cellSize + inner * 0.5;
      const x1 = x0 + inner;
      means[row * gridCols + col] = rectMean(integral, stride, x0, y0, x1, y1);
    }
  }

  const period = new Float32Array(CODE_BITS);
  const counts = new Uint16Array(CODE_BITS);
  const residuals = new Float32Array(gridRows * gridCols);
  for (let row = 1; row < gridRows - 1; row += 1) {
    for (let col = 1; col < gridCols - 1; col += 1) {
      const here = row * gridCols + col;
      const residual =
        means[here] -
        (means[here - 1] + means[here + 1] + means[here - gridCols] + means[here + gridCols]) *
          0.25;
      residuals[here] = residual;
      const bit = (row % TILE_ROWS) * TILE_COLS + (col % TILE_COLS);
      period[bit] += residual;
      counts[bit] += 1;
    }
  }
  return { period, counts, gridCols, gridRows, startCol, startRow, residuals };
}

function phaseValues(
  period: Float32Array,
  counts: Uint16Array,
  phaseX: number,
  phaseY: number
): Float32Array {
  const values = new Float32Array(CODE_BITS);
  for (let row = 0; row < TILE_ROWS; row += 1) {
    const sourceRow = (row - phaseY + TILE_ROWS) % TILE_ROWS;
    for (let col = 0; col < TILE_COLS; col += 1) {
      const sourceCol = (col - phaseX + TILE_COLS) % TILE_COLS;
      const source = sourceRow * TILE_COLS + sourceCol;
      const target = row * TILE_COLS + col;
      const count = counts[source];
      values[target] = count > 0 ? period[source] / count : 0;
    }
  }
  return values;
}

function observedSymbols(values: Float32Array): Uint8Array {
  const symbols = new Uint8Array(CODE_BITS);
  for (let index = 0; index < CODE_BITS; index += 1) {
    symbols[index] = values[index] >= 0 ? 1 : 0;
  }
  return symbols;
}

function symbolCorrelation(observed: Uint8Array, expected: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < CODE_BITS; index += 1) {
    sum += (observed[index] === expected[index] ? 1 : -1);
  }
  return sum / CODE_BITS;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function inspectTiles(hit: SearchHit, expected: Uint8Array): TileEvidence[] {
  const tiles: TileEvidence[] = [];
  const firstRow = (TILE_ROWS - (hit.geometry.phaseY % TILE_ROWS)) % TILE_ROWS;
  const firstCol = (TILE_COLS - (hit.geometry.phaseX % TILE_COLS)) % TILE_COLS;

  for (let row = firstRow; row + TILE_ROWS <= hit.gridRows; row += TILE_ROWS) {
    for (let col = firstCol; col + TILE_COLS <= hit.gridCols; col += TILE_COLS) {
      let agreement = 0;
      let total = 0;
      for (let cellRow = 0; cellRow < TILE_ROWS; cellRow += 1) {
        for (let cellCol = 0; cellCol < TILE_COLS; cellCol += 1) {
          const bit = cellRow * TILE_COLS + cellCol;
          const gridRow = row + cellRow;
          const gridCol = col + cellCol;
          const residual = hit.residuals[gridRow * hit.gridCols + gridCol];
          const observed = residual >= 0 ? 1 : 0;
          if (observed === expected[bit]) agreement += 1;
          total += 1;
        }
      }
      const pixelX = Math.round(
        hit.offsetX + (hit.startCol + col) * hit.cellSize
      );
      const pixelY = Math.round(
        hit.offsetY + (hit.startRow + row) * hit.cellSize
      );
      tiles.push({
        x: pixelX,
        y: pixelY,
        cells: CODE_BITS,
        agreement: total > 0 ? agreement / total : 0
      });
    }
  }
  tiles.sort((left, right) => right.agreement - left.agreement);
  return tiles;
}

function scoreCandidate(hit: SearchHit, expected: Uint8Array): {
  confidence: number;
  consistency: number;
  tiles: TileEvidence[];
} {
  hit.codeCorrelation = symbolCorrelation(hit.observedSymbols, expected);
  const tiles = inspectTiles(hit, expected);
  const usable = tiles.slice(0, 24);
  const positive = usable.filter((tile) => tile.agreement >= 0.56).length;
  const consistency = usable.length > 0 ? positive / usable.length : 0;
  const correlationNorm = clamp01((hit.codeCorrelation - 0.06) / 0.38);
  const syncNorm = clamp01((hit.syncMatches - 10) / 6);
  const consistencyNorm = clamp01((consistency - 0.14) / 0.68);
  const confidence = Math.round(
    12 + 50 * correlationNorm + 22 * syncNorm + 16 * consistencyNorm
  );
  return { confidence: Math.max(1, Math.min(98, confidence)), consistency, tiles: usable };
}

function emptyDetection(
  startedAt: number,
  checkedGeometries: number,
  reason: string
): FrameDetection {
  return {
    found: false,
    creatorId: null,
    confidence: 0,
    score: 0,
    syncMatches: 0,
    crcValid: false,
    correctedBits: 0,
    codeCorrelation: 0,
    signal: 0,
    geometry: null,
    bitMatrix: [],
    bitValues: [],
    tiles: [],
    checkedGeometries,
    elapsedMs: Math.round(performance.now() - startedAt),
    reason
  };
}

export function detectWatermark(
  image: RgbaImage,
  options: DetectOptions = {}
): FrameDetection {
  const startedAt = performance.now();
  const sensitivity = options.sensitivity ?? "balanced";
  const floor = sensitivityFloor(sensitivity);
  const maxDimension = Math.max(320, options.maxDimension ?? DEFAULT_MAX_DIMENSION);
  const prepared = fitWithin(image, maxDimension);
  const luma = toLuma(prepared);
  const stride = prepared.width + 1;
  const integral = buildIntegral(luma, prepared.width, prepared.height);
  const shortSide = Math.min(prepared.width, prepared.height);
  const maxCell = Math.max(18, Math.min(60, shortSide * 0.62));
  const expectedCache = new Map<number, Uint8Array>();
  let checkedGeometries = 0;
  let nearMiss: FrameDetection | null = null;
  let best: { hit: SearchHit; confidence: number; tiles: TileEvidence[]; consistency: number } | null = null;
  let tentative:
    | {
        values: Float32Array;
        observed: Uint8Array;
        decoded: DecodedPayload;
        geometry: WatermarkGeometry;
        signal: number;
      }
    | null = null;

  const getExpected = (creatorId: number): Uint8Array => {
    let expected = expectedCache.get(creatorId);
    if (!expected) {
      expected = buildPayload(creatorId).symbols;
      expectedCache.set(creatorId, expected);
    }
    return expected;
  };

  const scaleStep = shortSide > 680 ? 0.5 : 0.4;
  for (let cellSize = 4; cellSize <= maxCell; cellSize += scaleStep) {
    const offsetStep = Math.max(1, cellSize / 8);
    for (let oy = 0; oy < cellSize; oy += offsetStep) {
      for (let ox = 0; ox < cellSize; ox += offsetStep) {
        const grid = buildPeriod(
          integral,
          stride,
          prepared.width,
          prepared.height,
          cellSize,
          ox,
          oy
        );
        if (!grid) continue;
        checkedGeometries += 1;

        for (let phaseY = 0; phaseY < TILE_ROWS; phaseY += 1) {
          for (let phaseX = 0; phaseX < TILE_COLS; phaseX += 1) {
            let syncMatches = 0;
            for (let bit = 0; bit < 16; bit += 1) {
              const bitRow = Math.floor(bit / TILE_COLS);
              const bitCol = bit % TILE_COLS;
              const sourceRow = (bitRow - phaseY + TILE_ROWS) % TILE_ROWS;
              const sourceCol = (bitCol - phaseX + TILE_COLS) % TILE_COLS;
              const source = sourceRow * TILE_COLS + sourceCol;
              const count = grid.counts[source];
              const value = count > 0 ? grid.period[source] / count : 0;
              const observedBit = value >= 0 ? 1 : 0;
              if (observedBit === SYNC_SYMBOLS[bit]) syncMatches += 1;
            }
            if (syncMatches < floor.sync) continue;
            const values = phaseValues(grid.period, grid.counts, phaseX, phaseY);
            const observed = observedSymbols(values);
            const decoded = decodeSymbols(observed);
            let signal = 0;
            for (let index = 0; index < CODE_BITS; index += 1) signal += Math.abs(values[index]);
            signal /= CODE_BITS;
            if (
              decoded.syncMatches >= 14 &&
              (!tentative ||
                decoded.syncMatches > tentative.decoded.syncMatches ||
                (decoded.syncMatches === tentative.decoded.syncMatches && signal > tentative.signal))
            ) {
              tentative = {
                values,
                observed,
                decoded,
                signal,
                geometry: {
                  cellSize: Number(cellSize.toFixed(2)),
                  offsetX: Number(ox.toFixed(2)),
                  offsetY: Number(oy.toFixed(2)),
                  phaseX,
                  phaseY
                }
              };
            }
            if (
              decoded.syncMatches < floor.sync ||
              decoded.crcDistance > 1 ||
              decoded.creatorId < 1
            ) {
              continue;
            }
            const expected = getExpected(decoded.creatorId);
            const hit: SearchHit = {
              creatorId: decoded.creatorId,
              confidence: 0,
              score: 0,
              syncMatches: decoded.syncMatches,
              correctedBits: decoded.correctedIdBits,
              codeCorrelation: 0,
              signal,
              geometry: {
                cellSize: Number(cellSize.toFixed(2)),
                offsetX: Number(ox.toFixed(2)),
                offsetY: Number(oy.toFixed(2)),
                phaseX,
                phaseY
              },
              observedSymbols: observed,
              values,
              period: grid.period,
              counts: grid.counts,
              gridCols: grid.gridCols,
              gridRows: grid.gridRows,
              startCol: grid.startCol,
              startRow: grid.startRow,
              residuals: grid.residuals,
              cellSize,
              offsetX: ox,
              offsetY: oy
            };
            const scored = scoreCandidate(hit, expected);
            hit.confidence = scored.confidence;
            hit.score =
              scored.confidence / 100 +
              hit.codeCorrelation * 0.5 +
              (hit.syncMatches - 8) * 0.02;
            nearMiss = {
              found: false,
              creatorId: decoded.creatorId,
              confidence: scored.confidence,
              score: hit.score,
              syncMatches: decoded.syncMatches,
              crcValid: true,
              correctedBits: decoded.correctedIdBits,
              codeCorrelation: hit.codeCorrelation,
              signal: hit.signal,
              geometry: hit.geometry,
              bitMatrix: Array.from(observed),
              bitValues: Array.from(values),
              tiles: scored.tiles,
              checkedGeometries,
              elapsedMs: Math.round(performance.now() - startedAt),
              reason: "候选签名通过 CRC24，但相关强度低于当前灵敏度阈值。"
            };
            if (!best || hit.score > best.hit.score) {
              best = { hit, confidence: scored.confidence, tiles: scored.tiles, consistency: scored.consistency };
            }
          }
        }
      }
    }
  }

  if (!best) {
    if (!tentative) {
      return emptyDetection(
        startedAt,
        checkedGeometries,
        "未发现可验证的同步码与 CRC24 签名。"
      );
    }
    return {
      found: false,
      creatorId: null,
      confidence: 0,
      score: 0,
      syncMatches: tentative.decoded.syncMatches,
      crcValid: false,
      correctedBits: tentative.decoded.correctedIdBits,
      codeCorrelation: 0,
      signal: tentative.signal,
      geometry: tentative.geometry,
      bitMatrix: Array.from(tentative.observed),
      bitValues: Array.from(tentative.values),
      tiles: [],
      checkedGeometries,
      elapsedMs: Math.round(performance.now() - startedAt),
      reason: "检测到高一致同步结构，正在等待跨帧共识或更完整的片段。"
    };
  }

  const found =
    best.confidence >= floor.confidence &&
    best.hit.syncMatches >= floor.sync &&
    best.hit.codeCorrelation >= floor.correlation;
  if (!found) {
    const result = nearMiss ?? emptyDetection(startedAt, checkedGeometries, "候选强度不足。");
    result.checkedGeometries = checkedGeometries;
    result.elapsedMs = Math.round(performance.now() - startedAt);
    return result;
  }

  return {
    found: true,
    creatorId: best.hit.creatorId,
    confidence: best.confidence,
    score: best.hit.score,
    syncMatches: best.hit.syncMatches,
    crcValid: true,
    correctedBits: best.hit.correctedBits,
    codeCorrelation: best.hit.codeCorrelation,
    signal: best.hit.signal,
    geometry: best.hit.geometry,
    bitMatrix: Array.from(best.hit.observedSymbols),
    bitValues: Array.from(best.hit.values),
    tiles: best.tiles,
    checkedGeometries,
    elapsedMs: Math.round(performance.now() - startedAt),
    reason: "同步码、汉明纠错编号与 CRC24 校验一致。"
  };
}

interface ConsensusHit {
  creatorId: number;
  confidence: number;
  support: number;
  syncMatches: number;
  crcDistance: number;
}

function consensusFromFrames(
  frames: FrameDetection[],
  minimumSync: number
): ConsensusHit | null {
  const groups = new Map<string, FrameDetection[]>();
  for (const frame of frames) {
    if (!frame.geometry || frame.bitValues.length !== CODE_BITS) continue;
    const key = [
      Math.round(frame.geometry.cellSize),
      frame.geometry.phaseX,
      frame.geometry.phaseY
    ].join(":");
    const group = groups.get(key) ?? [];
    group.push(frame);
    groups.set(key, group);
  }

  let best: ConsensusHit | null = null;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const values = new Float32Array(CODE_BITS);
    let weightTotal = 0;
    for (const frame of group) {
      const weight = Math.max(0.25, Math.min(2.5, frame.signal / 3));
      for (let index = 0; index < CODE_BITS; index += 1) {
        values[index] += frame.bitValues[index] * weight;
      }
      weightTotal += weight;
    }
    if (weightTotal <= 0) continue;
    for (let index = 0; index < CODE_BITS; index += 1) values[index] /= weightTotal;
    const decoded = decodeSymbols(observedSymbols(values));
    if (
      decoded.creatorId < 1 ||
      decoded.syncMatches < minimumSync ||
      decoded.crcDistance > 1
    ) {
      continue;
    }
    const confidence = Math.min(
      97,
      Math.round(60 + Math.min(30, group.length * 6) + (decoded.crcDistance === 0 ? 4 : 0))
    );
    const hit: ConsensusHit = {
      creatorId: decoded.creatorId,
      confidence,
      support: group.length,
      syncMatches: decoded.syncMatches,
      crcDistance: decoded.crcDistance
    };
    if (
      !best ||
      hit.confidence > best.confidence ||
      (hit.confidence === best.confidence && hit.support > best.support)
    ) {
      best = hit;
    }
  }
  return best;
}

export function mergeDetections(
  frames: FrameDetection[],
  sensitivity: Sensitivity = "balanced"
): MergedDetection {
  const floor = sensitivityFloor(sensitivity);
  const usable = frames.filter((frame) => frame.found && frame.creatorId !== null);
  const consensus = consensusFromFrames(frames, Math.max(13, floor.sync - 1));
  if (usable.length === 0) {
    if (consensus) {
      return {
        found: true,
        creatorId: consensus.creatorId,
        confidence: consensus.confidence,
        hits: consensus.support,
        frames: frames.length,
        consistency: frames.length > 0 ? consensus.support / frames.length : 0,
        evidence: frames,
        reason: `跨 ${consensus.support}/${frames.length} 帧完成位级共识，CRC24 校验通过。`
      };
    }
    const strongest = frames.reduce(
      (best, frame) => (frame.confidence > best.confidence ? frame : best),
      frames[0] ?? emptyDetection(performance.now(), 0, "没有可分析的帧。")
    );
    return {
      found: false,
      creatorId: null,
      confidence: strongest?.confidence ?? 0,
      hits: 0,
      frames: frames.length,
      consistency: 0,
      evidence: frames,
      reason:
        strongest?.reason ??
        "未检测到通过同步码与 CRC24 双重校验的来源标识。"
    };
  }

  const groups = new Map<number, FrameDetection[]>();
  for (const frame of usable) {
    const id = frame.creatorId as number;
    const group = groups.get(id) ?? [];
    group.push(frame);
    groups.set(id, group);
  }

  let chosenId = 0;
  let chosen: FrameDetection[] = [];
  let chosenWeight = -1;
  for (const [id, group] of groups) {
    const weight = group.reduce(
      (sum, frame) => sum + frame.confidence + Math.max(0, frame.score) * 12,
      0
    );
    if (weight > chosenWeight) {
      chosenWeight = weight;
      chosenId = id;
      chosen = group;
    }
  }

  const noHitProbability = chosen.reduce(
    (probability, frame) => probability * (1 - frame.confidence / 100),
    1
  );
  const coverage = frames.length > 0 ? chosen.length / frames.length : 0;
  const base = 100 * (1 - noHitProbability);
  const confidence = Math.max(
    1,
    Math.min(98, Math.round(base * (0.8 + 0.2 * coverage)))
  );
  const consistency = frames.length > 0 ? chosen.length / frames.length : 0;
  let finalId = chosenId;
  let finalConfidence = confidence;
  let finalHits = chosen.length;
  let finalConsistency = consistency;
  let reason = `跨 ${chosen.length}/${frames.length} 帧检测到一致的创建者签名。`;

  if (consensus) {
    if (consensus.creatorId === chosenId) {
      finalConfidence = Math.max(finalConfidence, consensus.confidence);
      finalHits = Math.max(finalHits, consensus.support);
      reason = "逐帧签名与跨帧位级共识相互印证。";
    } else if (consensus.confidence > finalConfidence) {
      finalId = consensus.creatorId;
      finalConfidence = consensus.confidence;
      finalHits = consensus.support;
      finalConsistency = frames.length > 0 ? consensus.support / frames.length : 0;
      reason = `跨 ${consensus.support}/${frames.length} 帧完成位级共识，CRC24 校验通过。`;
    }
  }
  const found = finalConfidence >= floor.confidence && finalHits > 0;

  return {
    found,
    creatorId: found ? finalId : null,
    confidence: finalConfidence,
    hits: finalHits,
    frames: frames.length,
    consistency: finalConsistency,
    evidence: frames,
    reason: found ? reason : "存在候选帧，但跨帧一致性与置信度未达到阈值。"
  };
}

export function samplingTimestamps(duration: number, count: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || count < 1) return [0];
  const safeCount = Math.max(1, Math.min(24, Math.round(count)));
  const usable = Math.max(0.001, duration - 0.05);
  const timestamps: number[] = [];
  for (let index = 0; index < safeCount; index += 1) {
    const fraction = (index + 0.5) / safeCount;
    timestamps.push(Math.min(usable, Math.max(0, usable * fraction)));
  }
  return timestamps;
}
