import type {
  AnalysisResult,
  AnalysisSettings,
  AudioFeatures,
  MatchGroup,
  MatchOccurrence,
} from "../shared/types.ts";
import { clamp, median } from "./dsp.ts";

const CONTOUR_POINTS = 24;
const MIN_VOICED_COVERAGE = 0.52;

interface CandidateSegment {
  start: number;
  end: number;
  startFrame: number;
  endFrame: number;
  center: number;
  contour: Float32Array;
  valid: Uint8Array;
  voicedRatio: number;
  confidence: number;
  flatness: number;
  level: number;
}

interface RawPair {
  a: CandidateSegment;
  b: CandidateSegment;
  score: number;
  shift: number;
}

interface WorkingGroup {
  occurrences: MatchOccurrence[];
  score: number;
}

function foldedPitchDelta(a: number, b: number): number {
  let delta = a - b;
  while (delta > 6) delta -= 12;
  while (delta < -6) delta += 12;
  return delta;
}

function sampleContour(
  features: AudioFeatures,
  startFrame: number,
  endFrame: number,
): { contour: Float32Array; valid: Uint8Array; center: number } | null {
  const contour = new Float32Array(CONTOUR_POINTS);
  const valid = new Uint8Array(CONTOUR_POINTS);
  const span = endFrame - startFrame;
  const allPitches: number[] = [];
  let center = Number.NaN;

  for (let point = 0; point < CONTOUR_POINTS; point++) {
    const from = startFrame + Math.floor((point * span) / CONTOUR_POINTS);
    const to = Math.max(
      from + 1,
      startFrame + Math.floor(((point + 1) * span) / CONTOUR_POINTS),
    );
    const pitches: number[] = [];
    for (let frame = from; frame < Math.min(to, endFrame); frame++) {
      if (features.voiced[frame] && Number.isFinite(features.midi[frame])) {
        pitches.push(features.midi[frame]);
      }
    }
    if (pitches.length >= Math.max(1, Math.floor((to - from) * 0.35))) {
      contour[point] = median(pitches);
      valid[point] = 1;
      allPitches.push(...pitches);
      center = contour[point];
    }
  }
  if (!allPitches.length) return null;
  center = median(allPitches);
  for (let point = 0; point < CONTOUR_POINTS; point++) {
    if (valid[point]) contour[point] -= center;
  }
  return { contour, valid, center };
}

export function buildCandidateSegments(
  features: AudioFeatures,
  settings: AnalysisSettings,
): CandidateSegment[] {
  const minFrames = Math.max(8, Math.round(settings.minRepeatSec / features.hopSec));
  const targetHop = Math.max(2, Math.round(minFrames / 6));
  const durationHop = Math.ceil(features.frameCount / 18000);
  const hopFrames = Math.max(
    2,
    Math.min(Math.max(2, Math.floor(minFrames / 2)), Math.max(targetHop, durationHop)),
  );
  const candidates: CandidateSegment[] = [];

  for (
    let startFrame = 0;
    startFrame + minFrames <= features.frameCount;
    startFrame += hopFrames
  ) {
    const endFrame = startFrame + minFrames;
    const start = startFrame * features.hopSec;
    const end = Math.min(features.durationSec, endFrame * features.hopSec);
    let voicedCount = 0;
    const confidenceValues: number[] = [];
    const flatnessValues: number[] = [];
    const levelValues: number[] = [];
    for (let frame = startFrame; frame < endFrame; frame++) {
      if (features.voiced[frame]) voicedCount++;
      confidenceValues.push(features.confidence[frame]);
      flatnessValues.push(features.flatness[frame]);
      levelValues.push(features.rms[frame]);
    }
    const frameCount = endFrame - startFrame;
    const voicedRatio = voicedCount / frameCount;
    const confidence = median(confidenceValues);
    const flatness = median(flatnessValues);
    const level = median(levelValues);
    if (
      voicedRatio < MIN_VOICED_COVERAGE ||
      confidence < 0.3 ||
      flatness > 0.4 ||
      level < 0.006
    ) {
      continue;
    }
    const sampled = sampleContour(features, startFrame, endFrame);
    if (!sampled) continue;
    const validCount = sampled.valid.reduce((sum, value) => sum + value, 0);
    if (validCount < CONTOUR_POINTS * 0.65) continue;
    candidates.push({
      start,
      end,
      startFrame,
      endFrame,
      center: sampled.center,
      contour: sampled.contour,
      valid: sampled.valid,
      voicedRatio,
      confidence,
      flatness,
      level,
    });
  }
  return candidates;
}

export function compareCandidateSegments(
  a: CandidateSegment,
  b: CandidateSegment,
  settings: AnalysisSettings,
): { score: number; shift: number } | null {
  if (Math.abs(b.start - a.start) < settings.minGapSec) return null;
  if (b.start < a.end && a.start < b.end) return null;
  const shift = foldedPitchDelta(a.center, b.center);
  if (Math.abs(shift) > settings.transposeSemitones + 0.75) return null;
  let error = 0;
  let count = 0;
  for (let i = 0; i < CONTOUR_POINTS; i++) {
    if (!a.valid[i] || !b.valid[i]) continue;
    const difference = a.contour[i] - b.contour[i];
    error += difference * difference;
    count++;
  }
  if (count < CONTOUR_POINTS * 0.55) return null;
  const roughRmse = Math.sqrt(error / count);
  if (roughRmse > 1.9) return null;
  const { rmse, aligned } = alignedPitchError(a, b);
  if (aligned < CONTOUR_POINTS * 0.52) return null;
  const shape = Math.exp(-rmse / 2.25);
  const coverage = Math.min(a.voicedRatio, b.voicedRatio);
  const noisePenalty = clamp(
    1 - Math.max(0, Math.max(a.flatness, b.flatness) - 0.24) * 0.9,
    0.72,
    1,
  );
  const score = shape * (0.68 + coverage * 0.32) * noisePenalty;
  if (score < settings.similarityThreshold) return null;
  return { score, shift };
}

function alignedPitchError(
  a: CandidateSegment,
  b: CandidateSegment,
): { rmse: number; aligned: number } {
  const sizeA = CONTOUR_POINTS;
  const sizeB = CONTOUR_POINTS;
  const rows = sizeA + 1;
  const columns = sizeB + 1;
  const cost = new Float64Array(rows * columns).fill(Number.POSITIVE_INFINITY);
  const back = new Uint8Array(rows * columns);
  const at = (row: number, column: number) => row * columns + column;
  cost[at(0, 0)] = 0;

  for (let row = 1; row < rows; row++) {
    for (let column = 1; column < columns; column++) {
      const bothValid = a.valid[row - 1] && b.valid[column - 1];
      const difference = a.contour[row - 1] - b.contour[column - 1];
      const local = bothValid ? difference * difference : 0.18;
      const diagonal = cost[at(row - 1, column - 1)] + local;
      const horizontal = cost[at(row, column - 1)] + local * 0.78;
      const vertical = cost[at(row - 1, column)] + local * 0.78;
      let best = diagonal;
      let direction = 0;
      if (horizontal < best) {
        best = horizontal;
        direction = 1;
      }
      if (vertical < best) {
        best = vertical;
        direction = 2;
      }
      cost[at(row, column)] = best;
      back[at(row, column)] = direction;
    }
  }

  let row = sizeA;
  let column = sizeB;
  let error = 0;
  let aligned = 0;
  while (row > 0 && column > 0) {
    if (a.valid[row - 1] && b.valid[column - 1]) {
      const difference = a.contour[row - 1] - b.contour[column - 1];
      error += difference * difference;
      aligned++;
    }
    const direction = back[at(row, column)];
    if (direction === 1) column--;
    else if (direction === 2) row--;
    else {
      row--;
      column--;
    }
  }
  return {
    rmse: Math.sqrt(error / Math.max(1, aligned)),
    aligned,
  };
}

function overlapRatio(a: MatchOccurrence, b: MatchOccurrence): number {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return overlap / Math.max(0.001, Math.min(a.end - a.start, b.end - b.start));
}

function mergeIntervals(
  a: MatchOccurrence,
  b: MatchOccurrence,
): MatchOccurrence {
  return {
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    score: Math.max(a.score, b.score),
    shift: Math.abs(a.shift) > Math.abs(b.shift) ? a.shift : b.shift,
  };
}

function findOccurrence(
  group: WorkingGroup,
  candidate: MatchOccurrence,
): number {
  let bestIndex = -1;
  let bestOverlap = 0;
  group.occurrences.forEach((occurrence, index) => {
    const ratio = overlapRatio(occurrence, candidate);
    if (ratio > bestOverlap) {
      bestOverlap = ratio;
      bestIndex = index;
    }
  });
  return bestOverlap >= 0.45 ? bestIndex : -1;
}

function cleanOccurrences(occurrences: MatchOccurrence[]): MatchOccurrence[] {
  const sorted = [...occurrences].sort((a, b) => a.start - b.start);
  const result: MatchOccurrence[] = [];
  for (const occurrence of sorted) {
    const previous = result[result.length - 1];
    if (previous && overlapRatio(previous, occurrence) > 0.3) {
      result[result.length - 1] = mergeIntervals(previous, occurrence);
    } else {
      result.push({ ...occurrence });
    }
  }
  return result;
}

function mergeWorkingGroups(
  target: WorkingGroup,
  source: WorkingGroup,
): void {
  const merged = cleanOccurrences([...target.occurrences, ...source.occurrences]);
  target.occurrences = merged;
  target.score = Math.max(target.score, source.score);
}

export function groupRawPairs(
  pairs: RawPair[],
  settings: AnalysisSettings,
): MatchGroup[] {
  const groups: WorkingGroup[] = [];
  const sorted = [...pairs].sort((a, b) => b.score - a.score);
  for (const pair of sorted) {
    const left: MatchOccurrence = {
      start: pair.a.start,
      end: pair.a.end,
      score: pair.score,
      shift: pair.shift,
    };
    const right: MatchOccurrence = {
      start: pair.b.start,
      end: pair.b.end,
      score: pair.score,
      shift: pair.shift,
    };
    const leftGroups = groups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => findOccurrence(group, left) >= 0);
    const rightGroups = groups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => findOccurrence(group, right) >= 0);

    if (leftGroups.length && rightGroups.length) {
      const primary = leftGroups[0];
      for (const match of rightGroups) {
        if (match.group !== primary.group) {
          mergeWorkingGroups(primary.group, match.group);
          groups.splice(groups.indexOf(match.group), 1);
        }
      }
      const leftIndex = findOccurrence(primary.group, left);
      const rightIndex = findOccurrence(primary.group, right);
      if (leftIndex >= 0) {
        primary.group.occurrences[leftIndex] = mergeIntervals(
          primary.group.occurrences[leftIndex],
          left,
        );
      } else {
        primary.group.occurrences.push(left);
      }
      if (rightIndex >= 0) {
        primary.group.occurrences[rightIndex] = mergeIntervals(
          primary.group.occurrences[rightIndex],
          right,
        );
      } else {
        primary.group.occurrences.push(right);
      }
      primary.group.score = Math.max(primary.group.score, pair.score);
      continue;
    }

    if (leftGroups.length) {
      const group = leftGroups[0].group;
      const index = findOccurrence(group, left);
      group.occurrences[index] = mergeIntervals(group.occurrences[index], left);
      if (findOccurrence(group, right) < 0) group.occurrences.push(right);
      group.score = Math.max(group.score, pair.score);
      continue;
    }
    if (rightGroups.length) {
      const group = rightGroups[0].group;
      const index = findOccurrence(group, right);
      group.occurrences[index] = mergeIntervals(group.occurrences[index], right);
      if (findOccurrence(group, left) < 0) group.occurrences.push(left);
      group.score = Math.max(group.score, pair.score);
      continue;
    }
    groups.push({
      occurrences: [left, right],
      score: pair.score,
    });
  }

  return groups
    .map((group) => {
      group.occurrences = cleanOccurrences(group.occurrences);
      return group;
    })
    .filter((group) => {
      if (group.occurrences.length < 2) return false;
      for (let i = 1; i < group.occurrences.length; i++) {
        if (
          group.occurrences[i].start - group.occurrences[i - 1].end <
          settings.minGapSec
        ) {
          return false;
        }
      }
      return group.score >= settings.similarityThreshold;
    })
    .sort((a, b) => b.score - a.score)
    .map((group, index) => ({
      id: `match-${index + 1}`,
      score: group.score,
      occurrences: group.occurrences.sort((a, b) => a.start - b.start),
      status: "pending",
      note: "",
    }));
}

export function findRepeatedTakes(
  features: AudioFeatures,
  settings: AnalysisSettings,
  onProgress?: (value: number) => void,
): AnalysisResult {
  const normalized: AnalysisSettings = {
    minRepeatSec: clamp(settings.minRepeatSec, 0.8, 30),
    minGapSec: clamp(settings.minGapSec, 1, 3600),
    transposeSemitones: clamp(settings.transposeSemitones, 0, 12),
    similarityThreshold: clamp(settings.similarityThreshold, 0.5, 0.99),
  };
  const segments = buildCandidateSegments(features, normalized);
  const pairs: RawPair[] = [];
  let examined = 0;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const comparison = compareCandidateSegments(
        segments[i],
        segments[j],
        normalized,
      );
      if (comparison) {
        pairs.push({
          a: segments[i],
          b: segments[j],
          score: comparison.score,
          shift: comparison.shift,
        });
      }
    }
    examined++;
    if (i % 50 === 0) onProgress?.(examined / Math.max(1, segments.length));
  }
  const groups = groupRawPairs(pairs, normalized);
  const rejectedSec = features.stats.silentSec + features.stats.noisySec;
  features.stats.rejectedRegions = Math.max(
    features.stats.rejectedRegions,
    groups.filter((group) => group.occurrences.length < 2).length,
  );
  return {
    groups,
    scannedSec: features.durationSec,
    rejectedSec: rejectedSec + features.stats.noisySec,
    analyzedAt: Date.now(),
  };
}
