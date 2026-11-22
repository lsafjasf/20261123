import type {
  ConcealmentOptions,
  FillMethod,
  GapAnalysis,
  GapClassification,
  TransitionPlan
} from "./types.ts";
import { fitChannels } from "./dsp.ts";

export interface ConcealedGap {
  channels: Float32Array[];
  method: FillMethod;
  transitions: TransitionPlan;
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function patternLength(context: Float32Array, period: number): number {
  if (context.length === 0) return 1;
  if (period > 1 && period <= context.length) return period;
  return Math.min(context.length, 64);
}

function forwardExtension(
  context: Float32Array,
  frames: number,
  period: number
): Float32Array {
  const output = new Float32Array(frames);
  if (context.length === 0) return output;
  const length = patternLength(context, period);
  const start = Math.max(0, context.length - length);
  for (let index = 0; index < frames; index += 1) {
    output[index] = context[start + (index % length)];
  }
  return output;
}

function predecessorExtension(
  context: Float32Array,
  frames: number,
  period: number
): Float32Array {
  const output = new Float32Array(frames);
  if (context.length === 0) return output;
  if (period > 1 && period <= context.length) {
    for (let index = 0; index < frames; index += 1) {
      output[index] = context[modulo(index - frames, period)];
    }
    return output;
  }
  for (let index = 0; index < frames; index += 1) {
    output[index] = context[modulo(frames - 1 - index, context.length)];
  }
  return output;
}

function crossfade(
  lead: Float32Array,
  tail: Float32Array,
  curve: "linear" | "equal-power"
): Float32Array {
  const output = new Float32Array(lead.length);
  const denominator = Math.max(1, lead.length - 1);
  for (let index = 0; index < output.length; index += 1) {
    const t = index / denominator;
    if (curve === "equal-power") {
      output[index] = lead[index] * Math.cos(t * Math.PI / 2) +
        tail[index] * Math.sin(t * Math.PI / 2);
    } else {
      output[index] = lead[index] * (1 - t) + tail[index] * t;
    }
    output[index] = Math.max(-1, Math.min(1, output[index]));
  }
  return output;
}

function writeFadeOut(
  output: Float32Array,
  source: Float32Array,
  offset: number,
  count: number
): void {
  const denominator = Math.max(1, count - 1);
  for (let index = 0; index < count; index += 1) {
    output[offset + index] = source[index] * Math.pow(1 - index / denominator, 1.35);
  }
}

function writeFadeIn(
  output: Float32Array,
  source: Float32Array,
  offset: number,
  count: number
): void {
  const denominator = Math.max(1, count - 1);
  for (let index = 0; index < count; index += 1) {
    output[offset + index] = source[index] * Math.pow(index / denominator, 1.35);
  }
}

interface GapPlan {
  method: FillMethod;
  leadFrames: number;
  tailFrames: number;
  fullFrames: number;
  mutedFrames: number;
  curve: "linear" | "equal-power";
}

function planGap(
  classification: GapClassification,
  frames: number,
  sampleRate: number,
  options: ConcealmentOptions,
  analysis: GapAnalysis
): GapPlan {
  const blend = Math.max(1, Math.round(sampleRate * options.edgeBlendMs / 1000));
  const cap = Math.max(blend, Math.round(sampleRate * options.maxConcealMs / 1000));
  let leadFrames = Math.min(blend, Math.max(0, Math.floor(frames / 2)));
  let tailFrames = Math.min(blend, Math.max(0, frames - leadFrames));
  const curve = analysis.correlation >= 0.3 ? "linear" : "equal-power";

  if (classification === "true-pause") {
    return {
      method: "silence",
      leadFrames: 0,
      tailFrames: 0,
      fullFrames: 0,
      mutedFrames: frames,
      curve
    };
  }
  if (classification === "unrepairable") {
    return {
      method: "none",
      leadFrames: 0,
      tailFrames: 0,
      fullFrames: 0,
      mutedFrames: frames,
      curve
    };
  }
  if (classification === "onset-boundary") {
    leadFrames = 0;
    tailFrames = Math.min(blend, frames);
  } else if (classification === "offset-boundary") {
    leadFrames = Math.min(blend, frames);
    tailFrames = 0;
  }
  if (frames > cap) {
    return {
      method: "edge-fade",
      leadFrames,
      tailFrames,
      fullFrames: 0,
      mutedFrames: Math.max(0, frames - leadFrames - tailFrames),
      curve: "linear"
    };
  }
  if (classification === "speech-loss") {
    return {
      method: "pitch-continuation",
      leadFrames,
      tailFrames,
      fullFrames: frames,
      mutedFrames: 0,
      curve: "linear"
    };
  }
  if (classification === "music-boundary") {
    return {
      method: "equal-power-crossfade",
      leadFrames,
      tailFrames,
      fullFrames: frames,
      mutedFrames: 0,
      curve: "equal-power"
    };
  }
  return {
    method: "edge-fade",
    leadFrames,
    tailFrames,
    fullFrames: 0,
    mutedFrames: Math.max(0, frames - leadFrames - tailFrames),
    curve
  };
}

export function concealGap(input: {
  preChannels: readonly Float32Array[];
  postChannels: readonly Float32Array[];
  frames: number;
  sampleRate: number;
  classification: GapClassification;
  analysis: GapAnalysis;
  options: ConcealmentOptions;
}): ConcealedGap {
  const { frames, sampleRate, classification, analysis, options } = input;
  const channelCount = Math.max(1, input.preChannels.length, input.postChannels.length);
  const previous = fitChannels(input.preChannels, channelCount);
  const next = fitChannels(input.postChannels, channelCount);
  const plan = planGap(classification, frames, sampleRate, options, analysis);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));

  if (plan.method === "silence" || plan.method === "none" || frames === 0) {
    return {
      channels,
      method: plan.method,
      transitions: {
        leadFrames: 0,
        tailFrames: 0,
        synthesizedFrames: 0,
        mutedFrames: frames,
        curve: plan.curve
      }
    };
  }

  for (let channel = 0; channel < channelCount; channel += 1) {
    const pre = previous[channel];
    const post = next[channel];
    const output = channels[channel];
    const period = analysis.periodSamples;
    if (plan.fullFrames > 0) {
      const left = forwardExtension(pre, frames, period);
      const right = predecessorExtension(post, frames, period);
      const mixed = crossfade(left, right, plan.curve);
      output.set(mixed);
      continue;
    }
    if (classification !== "onset-boundary" && plan.leadFrames > 0) {
      const left = forwardExtension(pre, plan.leadFrames, period);
      writeFadeOut(output, left, 0, plan.leadFrames);
    }
    if (classification !== "offset-boundary" && plan.tailFrames > 0) {
      const right = predecessorExtension(post, plan.tailFrames, period);
      writeFadeIn(output, right, frames - plan.tailFrames, plan.tailFrames);
    }
  }

  return {
    channels,
    method: plan.method,
    transitions: {
      leadFrames: plan.leadFrames,
      tailFrames: plan.tailFrames,
      synthesizedFrames: plan.fullFrames > 0 ? frames : plan.leadFrames + plan.tailFrames,
      mutedFrames: plan.mutedFrames,
      curve: plan.curve
    }
  };
}
