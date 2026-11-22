/**
 * 应用状态与 reducer。所有写操作走不可变更新，
 * 拖动切点时只替换被拖的那一条 CutPoint，数组里其他对象引用不变。
 */

import type {
  Beat,
  Clip,
  CutIssue,
  CutPoint,
  PlannerOptions,
  Project,
  SpeechSpan,
} from "../core/types.ts";
import { DEFAULT_OPTIONS, dragCut, planCuts, resetCut } from "../core/planner.ts";
import { validateCuts } from "../core/speech.ts";

export interface AppState {
  project: Project;
  planner: PlannerOptions;
  selectedCutId: string | null;
  issues: CutIssue[];
  playhead: number;
  pxPerSec: number;
  waveform: Float32Array;
  dirty: boolean;
}

export type Action =
  | { type: "load"; project: Project; waveform: Float32Array }
  | { type: "replan" }
  | { type: "drag-cut"; cutId: string; requestedTime: number }
  | { type: "reset-cut"; cutId: string }
  | { type: "select"; cutId: string | null }
  | { type: "set-playhead"; time: number }
  | { type: "set-zoom"; pxPerSec: number }
  | { type: "set-weight"; clipId: string; weight: Clip["weight"] }
  | { type: "set-min-duration"; clipId: string | null; seconds: number }
  | { type: "set-in-point"; clipId: string; inPoint: number }
  | { type: "set-bias"; downbeatBias: number; maxSnapDistance: number };

export function initialState(): AppState {
  return {
    project: { clips: [], beats: [], cuts: [], speech: [], duration: 0 },
    planner: structuredClone(DEFAULT_OPTIONS),
    selectedCutId: null,
    issues: [],
    playhead: 0,
    pxPerSec: 26,
    waveform: new Float32Array(0),
    dirty: false,
  };
}

function recomputeIssues(state: AppState): CutIssue[] {
  return validateCuts(
    state.project.cuts,
    state.project.speech,
    state.project.duration,
    state.planner.minDurationOverrides,
  );
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "load": {
      const planned = planCuts(action.project.clips, action.project.beats, state.planner);
      const project: Project = { ...action.project, cuts: planned.cuts };
      const next: AppState = {
        ...state,
        project,
        waveform: action.waveform,
        selectedCutId: null,
        playhead: 0,
        dirty: false,
      };
      return { ...next, issues: recomputeIssues(next) };
    }
    case "replan": {
      const planned = planCuts(state.project.clips, state.project.beats, state.planner, state.project.cuts);
      const next: AppState = {
        ...state,
        project: { ...state.project, cuts: planned.cuts },
        dirty: true,
      };
      return { ...next, issues: recomputeIssues(next) };
    }
    case "drag-cut": {
      const cuts = dragCut(
        state.project.cuts,
        action.cutId,
        action.requestedTime,
        state.project.clips,
        state.project.beats,
        state.planner,
      );
      const next: AppState = {
        ...state,
        project: { ...state.project, cuts },
        selectedCutId: action.cutId,
        dirty: true,
      };
      return { ...next, issues: recomputeIssues(next) };
    }
    case "reset-cut": {
      const cuts = resetCut(
        state.project.cuts,
        action.cutId,
        state.project.clips,
        state.planner,
      );
      const next: AppState = { ...state, project: { ...state.project, cuts }, dirty: true };
      return { ...next, issues: recomputeIssues(next) };
    }
    case "select":
      return { ...state, selectedCutId: action.cutId };
    case "set-playhead":
      return { ...state, playhead: action.time };
    case "set-zoom":
      return { ...state, pxPerSec: action.pxPerSec };
    case "set-weight": {
      const clips = state.project.clips.map((clip) =>
        clip.id === action.clipId ? { ...clip, weight: action.weight } : clip,
      );
      const next: AppState = { ...state, project: { ...state.project, clips }, dirty: true };
      const replanned = planCuts(clips, state.project.beats, state.planner, state.project.cuts);
      next.project.cuts = replanned.cuts;
      return { ...next, issues: recomputeIssues(next) };
    }
    case "set-min-duration": {
      const overrides = { ...state.planner.minDurationOverrides };
      if (action.clipId) overrides[action.clipId] = action.seconds;
      const planner: PlannerOptions = { ...state.planner, minDurationOverrides: overrides };
      const next: AppState = { ...state, planner, dirty: true };
      const replanned = planCuts(state.project.clips, state.project.beats, planner, state.project.cuts);
      next.project.cuts = replanned.cuts;
      return { ...next, issues: recomputeIssues(next) };
    }
    case "set-in-point": {
      const clips = state.project.clips.map((clip) =>
        clip.id === action.clipId
          ? { ...clip, source: { ...clip.source, inPoint: Math.max(0, action.inPoint) } }
          : clip,
      );
      return { ...state, project: { ...state.project, clips }, dirty: true };
    }
    case "set-bias": {
      const planner: PlannerOptions = {
        ...state.planner,
        downbeatBias: action.downbeatBias,
        maxSnapDistance: action.maxSnapDistance,
      };
      const next: AppState = { ...state, planner, dirty: true };
      const replanned = planCuts(state.project.clips, state.project.beats, planner, state.project.cuts);
      next.project.cuts = replanned.cuts;
      return { ...next, issues: recomputeIssues(next) };
    }
    default:
      return state;
  }
}

export function cutById(state: AppState, cutId: string | null): CutPoint | null {
  if (!cutId) return null;
  return state.project.cuts.find((cut) => cut.id === cutId) ?? null;
}

export function beatsOf(state: AppState): Beat[] {
  return state.project.beats;
}

export function speechOf(state: AppState): SpeechSpan[] {
  return state.project.speech;
}
