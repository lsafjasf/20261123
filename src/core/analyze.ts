import type {
  ConcealmentOptions,
  GapAnalysis,
  GapClassification
} from "./types.ts";
import {
  bestCorrelation,
  estimatePeriod,
  head,
  levelDeltaDb,
  mixToMono,
  rms,
  tail,
  zeroCrossingRate
} from "./dsp.ts";

export interface GapAnalysisInput {
  preChannels: readonly Float32Array[];
  postChannels: readonly Float32Array[];
  sampleRate: number;
  options: ConcealmentOptions;
  rateChanged: boolean;
}

export function analyzeGap(input: GapAnalysisInput): GapAnalysis {
  const { sampleRate, options } = input;
  const analysisFrames = Math.max(32, Math.round(sampleRate * options.analysisMs / 1000));
  const preMono = mixToMono(input.preChannels);
  const postMono = mixToMono(input.postChannels);
  const pre = tail(preMono, analysisFrames);
  const post = head(postMono, analysisFrames);
  const preRms = rms(input.preChannels, Math.max(0, preMono.length - analysisFrames));
  const postRms = rms(input.postChannels, 0, analysisFrames);
  const preActive = preRms >= options.activeRms;
  const postActive = postRms >= options.activeRms;
  const minLag = Math.max(2, Math.floor(sampleRate / options.maxPeriodHz));
  const maxLag = Math.floor(sampleRate / options.minPeriodHz);
  const correlation = pre.length > 8 && post.length > 8
    ? bestCorrelation(pre, post, maxLag)
    : 0;
  const prePeriod = estimatePeriod(
    pre,
    sampleRate,
    options.minPeriodHz,
    options.maxPeriodHz
  );
  const postPeriod = estimatePeriod(
    post,
    sampleRate,
    options.minPeriodHz,
    options.maxPeriodHz
  );
  const periodRatio = prePeriod > 0 && postPeriod > 0
    ? Math.max(prePeriod, postPeriod) / Math.min(prePeriod, postPeriod)
    : 1;
  const preZcr = zeroCrossingRate(pre);
  const postZcr = zeroCrossingRate(post);
  const zcrLow = Math.min(preZcr, postZcr);
  const zcrHigh = Math.max(preZcr, postZcr);
  const zeroCrossingRatio = zcrLow > 1e-5 ? zcrHigh / zcrLow : 1;

  return {
    preRms,
    postRms,
    correlation: Math.max(0, correlation),
    periodSamples: Math.max(prePeriod, postPeriod, minLag),
    periodRatio,
    zeroCrossingRatio,
    levelDeltaDb: levelDeltaDb(preRms, postRms),
    preActive,
    postActive
  };
}

export function classifyGap(
  analysis: GapAnalysis,
  options: ConcealmentOptions,
  rateChanged: boolean
): GapClassification {
  if (!analysis.preActive && !analysis.postActive) return "true-pause";
  if (rateChanged) return "rate-boundary";
  if (!analysis.preActive) return "onset-boundary";
  if (!analysis.postActive) return "offset-boundary";

  const timbreJump = analysis.periodRatio > 1.34 || analysis.zeroCrossingRatio > 1.65;
  const levelJump = Math.abs(analysis.levelDeltaDb) > 22;
  if (analysis.correlation < options.boundaryCorrelation || timbreJump ||
      (levelJump && analysis.correlation < 0.62)) {
    return "music-boundary";
  }
  return "speech-loss";
}
