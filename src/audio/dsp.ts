/**
 * 节拍检测 DSP 纯函数。
 * 流程：分帧能量 -> 频谱/能量通量 onset -> 峰值挑选 -> 自相关估 BPM
 * -> 相位对齐得到节拍序列 -> 通量加权强度与每 4 拍重拍标记。
 */

import type { Beat } from "../core/types.ts";

export interface BeatConfig {
  frameSize: number;
  hopSize: number;
  minBpm: number;
  maxBpm: number;
  /** 峰值阈值（相对 onset 均值的倍数）。 */
  peakThreshold: number;
  /** 两个 onset 之间的最小间隔（秒）。 */
  minPeakGap: number;
  /** 每多少拍标一个重拍。 */
  beatsPerBar: number;
}

export const DEFAULT_BEAT_CONFIG: BeatConfig = {
  frameSize: 0.046,
  hopSize: 0.023,
  minBpm: 60,
  maxBpm: 180,
  peakThreshold: 1.35,
  minPeakGap: 0.18,
  beatsPerBar: 4,
};

/** Hann 窗。 */
export function hannWindow(length: number): Float32Array {
  const window = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, length - 1)));
  }
  return window;
}

/** 分帧 + 窗函数，返回每帧 RMS 能量。 */
export function energyEnvelope(
  pcm: Float32Array,
  sampleRate: number,
  config: BeatConfig,
): { time: number; energy: number }[] {
  const frameLen = Math.round(config.frameSize * sampleRate);
  const hop = Math.round(config.hopSize * sampleRate);
  const window = hannWindow(frameLen);
  const out: { time: number; energy: number }[] = [];
  for (let start = 0; start + frameLen <= pcm.length; start += hop) {
    let sum = 0;
    for (let i = 0; i < frameLen; i++) {
      const sample = pcm[start + i] * window[i];
      sum += sample * sample;
    }
    out.push({ time: start / sampleRate, energy: Math.sqrt(sum / frameLen) });
  }
  return out;
}

/**
 * 能量通量 onset 曲线：当前帧相对前一帧的正向能量差，
 * 再做局部均值归一化，使不同响度的歌阈值可比。
 */
export function onsetCurve(envelope: { time: number; energy: number }[]): number[] {
  const raw = envelope.map((frame, i) =>
    i === 0 ? 0 : Math.max(0, frame.energy - envelope[i - 1].energy),
  );
  const localWindow = 8;
  return raw.map((value, i) => {
    const lo = Math.max(0, i - localWindow);
    const hi = Math.min(raw.length, i + localWindow + 1);
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += raw[j];
    const localMean = sum / (hi - lo);
    return localMean > 1e-9 ? value / localMean : 0;
  });
}

/** 在 onset 曲线上做峰值挑选（阈值 + 最小间隔）。 */
export function pickOnsets(
  envelope: { time: number }[],
  onset: number[],
  config: BeatConfig,
): { time: number; strength: number }[] {
  const mean = onset.reduce((a, b) => a + b, 0) / Math.max(1, onset.length);
  const threshold = mean * config.peakThreshold;
  const peaks: { time: number; strength: number }[] = [];
  for (let i = 1; i < onset.length - 1; i++) {
    if (onset[i] <= threshold) continue;
    if (onset[i] <= onset[i - 1] || onset[i] < onset[i + 1]) continue;
    const time = envelope[i].time;
    if (peaks.length && time - peaks[peaks.length - 1].time < config.minPeakGap) {
      if (onset[i] > peaks[peaks.length - 1].strength) peaks[peaks.length - 1] = { time, strength: onset[i] };
      continue;
    }
    peaks.push({ time, strength: onset[i] });
  }
  return peaks;
}

/** 无偏自相关（lag 单位 = 帧）。 */
export function autocorrelate(values: number[], maxLag: number): number[] {
  const result = new Array(maxLag + 1).fill(0);
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i + lag < values.length; i++) {
      sum += values[i] * values[i + lag];
      count++;
    }
    result[lag] = count ? sum / count : 0;
  }
  return result;
}

/** 用 onset 自相关估计主周期（秒）与 BPM，限制在音乐常用区间。 */
export function estimatePeriod(
  onset: number[],
  frameHopSec: number,
  config: BeatConfig,
): { periodSec: number; bpm: number } {
  const minLag = Math.round(60 / config.maxBpm / frameHopSec);
  const maxLag = Math.round(60 / config.minBpm / frameHopSec);
  const corr = autocorrelate(onset, Math.min(onset.length - 1, maxLag));
  let bestLag = minLag;
  let bestValue = -Infinity;
  for (let lag = Math.max(1, minLag); lag <= Math.min(maxLag, corr.length - 1); lag++) {
    if (corr[lag] > bestValue) {
      bestValue = corr[lag];
      bestLag = lag;
    }
  }
  const periodSec = bestLag * frameHopSec;
  return { periodSec, bpm: 60 / periodSec };
}

/**
 * 以估计周期生成规则节拍网格，相位对齐到最强 onset；
 * 再用每个节拍邻域内的 onset 强度打标，每 beatsPerBar 拍标重拍。
 */
export function buildBeats(
  envelope: { time: number; energy: number }[],
  onset: number[],
  config: BeatConfig,
  durationSec: number,
): Beat[] {
  const frameHopSec = config.hopSize;
  const { periodSec } = estimatePeriod(onset, frameHopSec, config);
  const onsets = pickOnsets(envelope, onset, config);

  // 相位：选择落在某个强 onset 上、且整体与 onset 对齐误差最小的起点。
  let phase = 0;
  let bestScore = -Infinity;
  for (const candidate of onsets.slice(0, Math.min(onsets.length, 24))) {
    let score = 0;
    for (const peak of onsets) {
      const distance = Math.abs(((peak.time - candidate.time) % periodSec + periodSec) % periodSec);
      const wrapped = Math.min(distance, periodSec - distance);
      if (wrapped < config.minPeakGap) score += peak.strength;
    }
    if (score > bestScore) {
      bestScore = score;
      phase = candidate.time;
    }
  }

  const maxStrength = Math.max(1e-9, ...onsets.map((o) => o.strength));
  const beats: Beat[] = [];
  let index = 0;
  for (let time = phase; time <= durationSec; time += periodSec, index++) {
    const nearest = onsets.reduce(
      (best, peak) => (Math.abs(peak.time - time) < Math.abs(best.time - time) ? peak : best),
      onsets[0] ?? { time, strength: 0 },
    );
    const jitter = Math.abs(nearest.time - time);
    const strength = jitter < periodSec / 2 ? nearest.strength / maxStrength : 0.25;
    beats.push({
      time: Number(time.toFixed(4)),
      strength: Number(clamp01(strength).toFixed(3)),
      downbeat: index % config.beatsPerBar === 0,
    });
  }
  return beats;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 一站式入口：单声道 PCM -> Beat[]。 */
export function detectBeats(
  pcm: Float32Array,
  sampleRate: number,
  config: BeatConfig = DEFAULT_BEAT_CONFIG,
): Beat[] {
  const envelope = energyEnvelope(pcm, sampleRate, config);
  if (envelope.length < 4) return [];
  const onset = onsetCurve(envelope);
  return buildBeats(envelope, onset, config, pcm.length / sampleRate);
}
