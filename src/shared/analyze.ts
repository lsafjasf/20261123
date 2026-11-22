import type { Anchor, AnalysisParams, AnalysisResult, AnalysisWindow, AudioTrack, WindowKind } from "./types.ts";
import { DEFAULT_PARAMS } from "./types.ts";
import { mixToMono } from "./wav.ts";
import { resampleLinear } from "./resample.ts";
import { rmsDb, windowFeatures } from "./features.ts";
import { gccPhat } from "./gcc.ts";
import { fitSegmented, weightedLinear, clamp01 } from "./fit.ts";

const ANALYSIS_RATE = 16000;

export interface PreparedTrack {
  mono: Float32Array;
  rate: number;
  original: AudioTrack;
}

export function prepareTrack(track: AudioTrack): PreparedTrack {
  const mono = mixToMono(track);
  const rate = track.sampleRate > ANALYSIS_RATE ? ANALYSIS_RATE : track.sampleRate;
  const resampled = track.sampleRate === rate ? mono : resampleLinear(mono, track.sampleRate, rate);
  return { mono: resampled, rate, original: track };
}

export function analyzeTracks(
  referenceTrack: AudioTrack,
  recordedTrack: AudioTrack,
  params: AnalysisParams = DEFAULT_PARAMS,
): AnalysisResult {
  const reference = prepareTrack(referenceTrack);
  const recorded = prepareTrack(recordedTrack);
  const duration = Math.min(referenceTrack.duration, recordedTrack.duration);
  const maxLag = Math.ceil((params.maxOffsetMs / 1000) * reference.rate);
  const windowLen = Math.round(params.windowSec * reference.rate);
  const hop = Math.round(params.hopSec * reference.rate);
  const windows: AnalysisWindow[] = [];

  let index = 0;
  for (let startSample = 0; startSample + windowLen <= duration * reference.rate; startSample += hop) {
    const endSample = startSample + windowLen;
    const refSlice = reference.mono.subarray(startSample, endSample);
    const recSlice = recorded.mono.subarray(startSample, endSample);
    const features = windowFeatures(refSlice, reference.rate);
    const levelDb = rmsDb(refSlice);
    const kind = classify(levelDb, features.periodicity, features.onsetCount, features.zcr, params);
    const usable = kind !== "silence" && kind !== "music";
    const window: AnalysisWindow = {
      index: index++,
      start: startSample / reference.rate,
      end: endSample / reference.rate,
      rms: features.rms,
      peak: features.peak,
      zcr: features.zcr,
      periodicity: features.periodicity,
      onsetCount: features.onsetCount,
      kind,
      usable,
      lagMs: null,
      corrPeak: 0,
      corrZ: 0,
      confidence: 0,
      excluded: !usable,
    };
    if (usable) {
      const correlation = gccPhat(refSlice, recSlice, maxLag);
      window.lagMs = (correlation.lagSamples / reference.rate) * 1000;
      window.corrPeak = correlation.peak;
      window.corrZ = correlation.zScore;
      window.confidence = confidenceFor(correlation.zScore, features, kind);
      window.excluded = window.confidence < 0.2 || correlation.zScore < 3;
    }
    windows.push(window);
  }

  const anchors: Anchor[] = windows
    .filter((w) => !w.excluded && w.lagMs !== null)
    .map((w) => ({
      t: (w.start + w.end) / 2,
      offsetMs: w.lagMs!,
      confidence: w.confidence,
      corrZ: w.corrZ,
      kind: w.kind,
      windowIndex: w.index,
    }));

  const globalFit = anchors.length >= 2
    ? weightedLinear(anchors)
    : { intercept: anchors[0]?.offsetMs ?? 0, slope: 0, weights: new Float64Array(0), residual: 0 };
  const segmented = fitSegmented(anchors, params.maxSegments, duration);
  if (segmented.segments.length === 0 && anchors.length === 1) {
    segmented.segments.push({
      index: 0,
      start: 0,
      end: duration,
      offsetMsAtStart: anchors[0]!.offsetMs,
      offsetMsAtEnd: anchors[0]!.offsetMs,
      slopeMsPerSec: 0,
      stretchFactor: 1,
      confidence: anchors[0]!.confidence * 0.5,
      residualMs: 0,
      anchorCount: 1,
      enabled: true,
    });
  }

  return {
    params,
    duration,
    refSampleRate: referenceTrack.sampleRate,
    recSampleRate: recordedTrack.sampleRate,
    windows,
    anchors,
    segments: segmented.segments,
    breakpoints: segmented.breakpoints,
    globalFit: {
      interceptMs: globalFit.intercept,
      slopeMsPerSec: globalFit.slope,
      residualMs: globalFit.residual,
    },
    createdAt: new Date().toISOString(),
  };
}

function classify(levelDb: number, periodicity: number, onsetCount: number, zcr: number, params: AnalysisParams): WindowKind {
  if (levelDb < params.silenceDb) return "silence";
  if (periodicity > params.periodicityLimit && onsetCount <= 1) return "music";
  if (onsetCount >= 2) return "transient";
  if (zcr > 0.12) return "ambient";
  return periodicity > params.periodicityLimit * 0.8 ? "music" : "ambient";
}

function confidenceFor(zScore: number, features: { onsetCount: number; peak: number; rms: number }, kind: WindowKind): number {
  const correlationPart = clamp01(1 - Math.exp(-(zScore - 3) / 4));
  const crest = features.peak / Math.max(1e-9, features.rms);
  const transientPart = kind === "transient" ? clamp01(Math.min(1, features.onsetCount / 3)) : 0.35;
  const crestPart = clamp01((crest - 2) / 8);
  return clamp01(0.55 * correlationPart + 0.25 * transientPart + 0.2 * crestPart);
}

export function offsetAt(result: AnalysisResult, t: number): number {
  const segments = result.segments.filter((s) => s.enabled);
  if (segments.length === 0) return result.globalFit.interceptMs + result.globalFit.slopeMsPerSec * t;
  const segment = segments.find((s) => t >= s.start && t < s.end) ?? segments[segments.length - 1]!;
  const span = Math.max(1e-9, segment.end - segment.start);
  const ratio = clamp01((t - segment.start) / span);
  return segment.offsetMsAtStart + (segment.offsetMsAtEnd - segment.offsetMsAtStart) * ratio;
}
