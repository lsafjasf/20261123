// Central app state + project (comp decision) model.

import type { Segmentation } from "../shared/dsp.ts";
import type { SentenceMetrics } from "../shared/metrics.ts";
import type { CompPlan } from "../shared/comp.ts";

export interface Project {
  version: 1;
  takeNames: string[];
  refTake: number;
  fadeMs: number;
  choices: number[]; // choices[sentence] = take index
}

export interface AppState {
  takeNames: string[];
  pcm: Float32Array[]; // mono, all at sampleRate
  sampleRate: number;
  segs: Segmentation[];
  aligned: number[][];
  metrics: SentenceMetrics[][];
  refTake: number;
  choices: number[];
  fadeMs: number;
  plan: CompPlan | null;
  compPcm: Float32Array | null;
  selectedSentence: number;
}

export const state: AppState = {
  takeNames: [],
  pcm: [],
  sampleRate: 48000,
  segs: [],
  aligned: [],
  metrics: [],
  refTake: 0,
  choices: [],
  fadeMs: 12,
  plan: null,
  compPcm: null,
  selectedSentence: 0,
};

export function toProject(): Project {
  return {
    version: 1,
    takeNames: state.takeNames,
    refTake: state.refTake,
    fadeMs: state.fadeMs,
    choices: state.choices.slice(),
  };
}

export function applyProject(p: Project): string[] {
  const warnings: string[] = [];
  if (p.takeNames.length !== state.takeNames.length || p.takeNames.some((n, i) => n !== state.takeNames[i])) {
    warnings.push("工程里的 take 列表与当前加载的不一致，已按位置套用选择。");
  }
  state.refTake = Math.min(p.refTake, Math.max(0, state.takeNames.length - 1));
  state.fadeMs = p.fadeMs;
  const n = state.segs[state.refTake]?.sentences.length ?? 0;
  state.choices = Array.from({ length: n }, (_, i) => {
    const c = p.choices[i];
    return typeof c === "number" && c >= 0 && c < state.takeNames.length ? c : state.refTake;
  });
  return warnings;
}
