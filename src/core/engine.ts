import {
  clamp,
  getDecision,
  getDecisionAt,
  getMainlineDurationMs,
  getPlacementAt,
} from "./manifest.ts";
import type { BranchManifest, ChoiceOption, Decision } from "./types.ts";

export type PlaybackMode = "main" | "branch";
export type PlaybackStatus = "playing" | "paused" | "choice" | "blocked" | "ended";

export interface BranchPlayback {
  decisionId: string;
  optionId: string;
  segmentId: string;
  elapsedMs: number;
  endMs: number;
  returnToMs: number;
  correct: boolean;
}

export interface PlayerState {
  mode: PlaybackMode;
  status: PlaybackStatus;
  mainTimeMs: number;
  activeDecisionId: string | null;
  branch: BranchPlayback | null;
}

export type PreloadState = "idle" | "loading" | "ready" | "failed";
export type PreloadMap = Record<string, PreloadState>;

export interface PreloadBlocker {
  segmentId: string;
  status: PreloadState;
}

export interface ReadinessResult {
  ready: boolean;
  blockers: PreloadBlocker[];
  segmentIds: string[];
}

export interface ChoiceResult {
  ok: boolean;
  state: PlayerState;
  reason?: "not-at-decision" | "unknown-option" | "preload-not-ready";
}

export function createInitialState(): PlayerState {
  return {
    mode: "main",
    status: "paused",
    mainTimeMs: 0,
    activeDecisionId: null,
    branch: null,
  };
}

export function seekMainline(
  manifest: BranchManifest,
  state: PlayerState,
  timeMs: number,
): PlayerState {
  const time = clamp(timeMs, 0, getMainlineDurationMs(manifest));
  const decision = getDecisionAt(manifest, time);
  return {
    ...state,
    mode: "main",
    status: "paused",
    mainTimeMs: time,
    activeDecisionId: decision?.id ?? null,
    branch: null,
  };
}

export function advanceMainline(
  manifest: BranchManifest,
  state: PlayerState,
  deltaMs: number,
): PlayerState {
  if (state.mode !== "main" || state.status !== "playing") return state;
  const total = getMainlineDurationMs(manifest);
  const from = clamp(state.mainTimeMs, 0, total);
  const target = clamp(from + Math.max(0, deltaMs), 0, total);
  const nextDecision = manifest.decisions
    .filter(
      (decision) =>
        decision.pauseAtMs > from &&
        decision.pauseAtMs <= target &&
        decision.timelineEndMs > decision.timelineStartMs,
    )
    .sort((a, b) => a.pauseAtMs - b.pauseAtMs)[0];

  if (nextDecision) {
    return {
      ...state,
      status: "choice",
      mainTimeMs: nextDecision.pauseAtMs,
      activeDecisionId: nextDecision.id,
    };
  }

  if (target >= total) {
    return {
      ...state,
      mainTimeMs: total,
      status: "ended",
      activeDecisionId: null,
    };
  }

  return {
    ...state,
    mainTimeMs: target,
    activeDecisionId: getDecisionAt(manifest, target)?.id ?? null,
  };
}

export function advanceBranch(
  state: PlayerState,
  deltaMs: number,
): PlayerState {
  if (state.mode !== "branch" || state.status !== "playing" || !state.branch) {
    return state;
  }
  const elapsedMs = Math.min(
    state.branch.endMs,
    state.branch.elapsedMs + Math.max(0, deltaMs),
  );
  return {
    ...state,
    branch: { ...state.branch, elapsedMs },
    status: elapsedMs >= state.branch.endMs ? "paused" : state.status,
  };
}

export function chooseOption(
  manifest: BranchManifest,
  state: PlayerState,
  decisionId: string,
  optionId: string,
  preloads: PreloadMap,
): ChoiceResult {
  if (state.mode !== "main") {
    return { ok: false, state, reason: "not-at-decision" };
  }
  const decision =
    getDecision(manifest, decisionId) ??
    (state.activeDecisionId ? getDecision(manifest, state.activeDecisionId) : undefined);
  if (!decision || !isTimeInDecision(state.mainTimeMs, decision)) {
    return { ok: false, state, reason: "not-at-decision" };
  }
  const option = decision.options.find((candidate) => candidate.id === optionId);
  if (!option) {
    return { ok: false, state, reason: "unknown-option" };
  }
  const readiness = evaluateDecisionReadiness(manifest, decision, preloads);
  if (!readiness.ready) {
    return { ok: false, state, reason: "preload-not-ready" };
  }

  return {
    ok: true,
    state: {
      ...state,
      mode: "branch",
      status: "playing",
      activeDecisionId: null,
      branch: {
        decisionId: decision.id,
        optionId: option.id,
        segmentId: option.targetSegmentId,
        elapsedMs: 0,
        endMs: option.targetEndMs,
        returnToMs: option.returnToMs,
        correct: option.correct,
      },
    },
  };
}

export function finishBranch(
  manifest: BranchManifest,
  state: PlayerState,
): PlayerState {
  if (state.mode !== "branch" || !state.branch) return state;
  const decision = getDecision(manifest, state.branch.decisionId);
  const option = decision?.options.find(
    (candidate) => candidate.id === state.branch?.optionId,
  );
  if (!decision || !option) {
    return {
      ...state,
      mode: "main",
      status: "blocked",
      branch: null,
      activeDecisionId: null,
    };
  }

  if (!option.correct) {
    return returnToDecision(manifest, state);
  }

  const time = clamp(option.returnToMs, 0, getMainlineDurationMs(manifest));
  return {
    mode: "main",
    status: "playing",
    mainTimeMs: time,
    activeDecisionId: getDecisionAt(manifest, time)?.id ?? null,
    branch: null,
  };
}

export function returnToDecision(
  manifest: BranchManifest,
  state: PlayerState,
): PlayerState {
  const branch = state.branch;
  if (!branch) return state;
  const decision = getDecision(manifest, branch.decisionId);
  const time = decision?.timelineStartMs ?? state.mainTimeMs;
  return {
    mode: "main",
    status: "choice",
    mainTimeMs: clamp(time, 0, getMainlineDurationMs(manifest)),
    activeDecisionId: decision?.id ?? null,
    branch: null,
  };
}

export function pausePlayback(state: PlayerState): PlayerState {
  if (state.status === "choice" || state.status === "blocked") return state;
  return { ...state, status: "paused" };
}

export function resumePlayback(state: PlayerState): PlayerState {
  if (state.status === "ended") {
    return { ...state, status: "playing", mainTimeMs: 0, mode: "main" };
  }
  return { ...state, status: "playing" };
}

export function getDecisionPreloadIds(
  manifest: BranchManifest,
  decision: Decision,
): string[] {
  const ids = new Set<string>();

  decision.options.forEach((option) => {
    ids.add(option.targetSegmentId);
    const returnPlacement = getPlacementAt(manifest, option.returnToMs);
    if (returnPlacement) ids.add(returnPlacement.segment.id);
  });

  const endPlacement = getPlacementAt(
    manifest,
    Math.max(decision.timelineStartMs, decision.timelineEndMs - 1),
  );
  const firstAfter = endPlacement
    ? manifest.mainline[endPlacement.index + 1]
    : undefined;
  if (firstAfter) ids.add(firstAfter.segmentId);

  return [...ids];
}

export function evaluateDecisionReadiness(
  manifest: BranchManifest,
  decision: Decision,
  preloads: PreloadMap,
): ReadinessResult {
  const segmentIds = getDecisionPreloadIds(manifest, decision);
  const blockers = segmentIds
    .filter((segmentId) => preloads[segmentId] !== "ready")
    .map((segmentId) => ({
      segmentId,
      status: preloads[segmentId] ?? "idle",
    }));
  return {
    ready: blockers.length === 0 && segmentIds.length > 0,
    blockers,
    segmentIds,
  };
}

export function canPlayOption(
  manifest: BranchManifest,
  option: ChoiceOption,
  preloads: PreloadMap,
): boolean {
  if (preloads[option.targetSegmentId] !== "ready") return false;
  const returnPlacement = getPlacementAt(manifest, option.returnToMs);
  return Boolean(
    returnPlacement && preloads[returnPlacement.segment.id] === "ready",
  );
}

export function isTimeInDecision(timeMs: number, decision: Decision): boolean {
  return (
    timeMs >= decision.timelineStartMs && timeMs <= decision.timelineEndMs
  );
}

export function decisionAtPlayerTime(
  manifest: BranchManifest,
  state: PlayerState,
): Decision | undefined {
  if (state.mode !== "main") return undefined;
  return (
    (state.activeDecisionId
      ? getDecision(manifest, state.activeDecisionId)
      : undefined) ?? getDecisionAt(manifest, state.mainTimeMs)
  );
}
