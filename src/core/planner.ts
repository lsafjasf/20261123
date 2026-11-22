/**
 * 切点规划器（纯函数，可在 Node 中直接测试）。
 *
 * 思路：不在每个节拍上切，而是把「每个片段边界应落在哪个节拍」建模成
 * 动态规划。阶段 = 片段边界，状态 = 候选节拍时刻，转移受最短停留约束，
 * 代价由「离自然边界多远、节拍强弱、片段强弱偏好」共同决定。
 */

import type { Beat, Clip, CutPoint, PlannerOptions } from "./types.ts";
import { clamp, snapToBeats } from "./timeline.ts";

export const DEFAULT_OPTIONS: PlannerOptions = {
  defaultMinDuration: 1.2,
  minDurationOverrides: {},
  downbeatBias: 0.6,
  maxSnapDistance: 0.45,
};

export function minDurationOf(clip: Clip, options: PlannerOptions): number {
  return options.minDurationOverrides[clip.id] ?? options.defaultMinDuration;
}

/** 片段自然边界时间（保持原顺序与总长）。 */
export function naturalBoundary(clips: readonly Clip[], boundary: number): number {
  if (boundary <= 0) return clips[0]?.start ?? 0;
  if (boundary >= clips.length) {
    const last = clips[clips.length - 1];
    return last ? last.start + last.duration : 0;
  }
  const left = clips[boundary - 1];
  return left.start + left.duration;
}

interface Candidate {
  time: number;
  beat: Beat | null;
}

/** 某个边界可选的切点：节拍候选 + 自然边界兜底。 */
function candidatesFor(
  clips: readonly Clip[],
  beats: readonly Beat[],
  boundary: number,
  options: PlannerOptions,
): Candidate[] {
  const natural = naturalBoundary(clips, boundary);
  const windowLo = natural - options.maxSnapDistance;
  const windowHi = natural + options.maxSnapDistance;
  const inWindow = beats.filter((b) => b.time >= windowLo && b.time <= windowHi);
  const candidates: Candidate[] = inWindow.map((beat) => ({ time: beat.time, beat }));
  if (!candidates.some((c) => Math.abs(c.time - natural) < 1e-6)) {
    candidates.push({ time: natural, beat: null });
  }
  candidates.sort((a, b) => a.time - b.time);
  return candidates;
}

/**
 * 单个候选代价。
 * - distCost：偏离自然边界会改变片段时长，偏离越大代价越高；
 * - beatCost：弱拍代价高，重拍代价低（downbeatBias 放大偏好）；
 * - weightCost：strong 片段更值得落在强拍，weak 片段对节拍不敏感。
 */
function candidateCost(
  candidate: Candidate,
  clip: Clip | undefined,
  natural: number,
  options: PlannerOptions,
): number {
  const distCost = Math.abs(candidate.time - natural) * 2.2;
  let beatCost: number;
  if (!candidate.beat) {
    beatCost = 0.55; // 没跟到拍：中性偏高的固定代价
  } else {
    const strengthPenalty = 1 - candidate.beat.strength;
    const downbeatPenalty = candidate.beat.downbeat ? 0 : options.downbeatBias;
    beatCost = strengthPenalty * 0.4 + downbeatPenalty * 0.6;
  }
  let weightFactor = 1;
  if (clip?.weight === "strong") weightFactor = 0.55;
  if (clip?.weight === "weak") weightFactor = 1.45;
  return distCost + beatCost * weightFactor;
}

interface DpNode {
  cost: number;
  prev: number;
}

export interface PlanResult {
  cuts: CutPoint[];
  /** 每个内部边界实际选中的候选是否吸附到了节拍。 */
  snapped: boolean[];
}

let cutSeq = 0;
const nextCutId = (): string => `cut-${Date.now().toString(36)}-${(cutSeq++).toString(36)}`;

/**
 * 规划全部切点。首尾固定为时间线起点/终点；内部边界用 DP 选节拍。
 * 已存在的手动切点（manual=true）原样保留，并作为硬约束参与规划。
 */
export function planCuts(
  clips: readonly Clip[],
  beats: readonly Beat[],
  options: PlannerOptions = DEFAULT_OPTIONS,
  existing: readonly CutPoint[] = [],
): PlanResult {
  if (clips.length === 0) return { cuts: [], snapped: [] };
  const totalEnd = naturalBoundary(clips, clips.length);
  const manualByBoundary = new Map<number, CutPoint>();
  for (const cut of existing) {
    if (!cut.manual) continue;
    const boundary = boundaryIndexOf(clips, cut.time);
    manualByBoundary.set(boundary, cut);
  }

  const stages: Candidate[][] = [];
  for (let b = 0; b <= clips.length; b++) {
    if (b === 0) {
      stages.push([{ time: clips[0].start, beat: null }]);
    } else if (b === clips.length) {
      stages.push([{ time: totalEnd, beat: null }]);
    } else if (manualByBoundary.has(b)) {
      const cut = manualByBoundary.get(b)!;
      stages.push([{ time: cut.time, beat: null }]);
    } else {
      stages.push(candidatesFor(clips, beats, b, options));
    }
  }

  // dp[stage][candidate] = 到达该状态的最小累计代价与前驱。
  const dp: DpNode[][] = stages.map(() => []);
  dp[0] = stages[0].map(() => ({ cost: 0, prev: -1 }));
  for (let stage = 1; stage < stages.length; stage++) {
    const clip = clips[stage - 1];
    const minDur = minDurationOf(clip, options);
    for (let j = 0; j < stages[stage].length; j++) {
      const cur = stages[stage][j];
      let best: DpNode = { cost: Infinity, prev: -1 };
      for (let k = 0; k < stages[stage - 1].length; k++) {
        const prevNode = dp[stage - 1][k];
        if (prevNode.cost === Infinity) continue;
        const prevTime = stages[stage - 1][k].time;
        if (cur.time - prevTime + 1e-9 < minDur) continue; // 最短停留硬约束
        const natural = naturalBoundary(clips, stage);
        const step = candidateCost(cur, clip, natural, options);
        const total = prevNode.cost + step;
        if (total < best.cost) best = { cost: total, prev: k };
      }
      dp[stage][j] = best;
    }
  }

  // 回溯。
  const chosen: Candidate[] = new Array(stages.length);
  let lastBest = 0;
  for (let j = 1; j < dp[dp.length - 1].length; j++) {
    if (dp[dp.length - 1][j].cost < dp[dp.length - 1][lastBest].cost) lastBest = j;
  }
  let ci = lastBest;
  for (let stage = stages.length - 1; stage >= 0; stage--) {
    chosen[stage] = stages[stage][ci];
    ci = dp[stage][ci].prev;
  }

  const cuts: CutPoint[] = [];
  const snapped: boolean[] = [];
  for (let b = 0; b <= clips.length; b++) {
    const candidate = chosen[b];
    const left = b > 0 ? clips[b - 1].id : null;
    const right = b < clips.length ? clips[b].id : null;
    const manualCut = manualByBoundary.get(b);
    if (manualCut) {
      cuts.push({ ...manualCut, leftClipId: left, rightClipId: right });
      snapped.push(false);
    } else {
      cuts.push({
        id: nextCutId(),
        time: candidate.time,
        suggestedTime: candidate.time,
        leftClipId: left,
        rightClipId: right,
        beatTime: candidate.beat ? candidate.beat.time : null,
        manual: false,
      });
      snapped.push(Boolean(candidate.beat));
    }
  }
  return { cuts, snapped };
}

/** 依据时间找到最近的片段边界下标（0..clips.length）。 */
export function boundaryIndexOf(clips: readonly Clip[], time: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let b = 0; b <= clips.length; b++) {
    const d = Math.abs(naturalBoundary(clips, b) - time);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}

/**
 * 单条拖动：只移动指定切点，其他切点保持不动。
 * 拖动受相邻两段最短停留约束，并在吸附窗口内贴节拍；
 * manual 置位，之后重算规划也不会覆盖它。
 */
export function dragCut(
  cuts: readonly CutPoint[],
  cutId: string,
  requestedTime: number,
  clips: readonly Clip[],
  beats: readonly Beat[],
  options: PlannerOptions,
): CutPoint[] {
  const index = cuts.findIndex((c) => c.id === cutId);
  if (index < 0) return cuts.slice();
  const cut = cuts[index];
  if (!cut.leftClipId || !cut.rightClipId) return cuts.slice(); // 首尾不动

  const leftClip = clips.find((c) => c.id === cut.leftClipId)!;
  const rightClip = clips.find((c) => c.id === cut.rightClipId)!;
  const prevCut = cuts[index - 1];
  const nextCut = cuts[index + 1];
  const minLeft = minDurationOf(leftClip, options);
  const minRight = minDurationOf(rightClip, options);
  const lo = prevCut ? prevCut.time + minLeft : 0;
  const hi = nextCut ? nextCut.time - minRight : Number.POSITIVE_INFINITY;

  const bounded = clamp(requestedTime, lo, hi);
  const snap = snapToBeats(bounded, beats, options.maxSnapDistance, true);
  let finalTime = bounded;
  let beatTime: number | null = null;
  if (snap.index >= 0) {
    const snappedTime = clamp(snap.time, lo, hi);
    finalTime = snappedTime;
    beatTime = snappedTime;
  }

  return cuts.map((c, i) =>
    i === index
      ? { ...c, time: finalTime, beatTime, manual: true }
      : c, // 其余切点对象原样保留，绝不联动
  );
}

/** 单条复位到系统建议时间（仍受最短停留约束）。 */
export function resetCut(
  cuts: readonly CutPoint[],
  cutId: string,
  clips: readonly Clip[],
  options: PlannerOptions,
): CutPoint[] {
  const index = cuts.findIndex((c) => c.id === cutId);
  if (index < 0) return cuts.slice();
  const cut = cuts[index];
  return dragCut(cuts, cutId, cut.suggestedTime, clips, [], options).map((c) =>
    c.id === cutId ? { ...c, manual: false, beatTime: c.beatTime } : c,
  );
}
