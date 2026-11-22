/**
 * 语音活动检测（VAD）与切点校验，全部为纯函数。
 * 浏览器侧用 WebAudio 解码出 PCM 后调用 detectSpeech；Node 测试用合成 PCM。
 */

import type { CutIssue, CutPoint, SpeechSpan } from "./types.ts";
import { clamp } from "./timeline.ts";

export interface VadOptions {
  /** 帧长（秒）。 */
  frameSize: number;
  /** 帧间步进（秒）。 */
  hopSize: number;
  /** 噪声底估计取最低多少比例帧的能量分位。 */
  noisePercentile: number;
  /** 阈值 = 噪声底 * 该倍数。 */
  thresholdMultiplier: number;
  /** 过零率窗口：人声谐波的过零率明显低于镲片/白噪。 */
  zcrMin: number;
  zcrMax: number;
  /** 进入语音后允许的短暂停顿（秒），防止字间断开。 */
  hangover: number;
  /** 最短说话区间（秒），短于此视为噪声。 */
  minSpanDuration: number;
}

export const DEFAULT_VAD: VadOptions = {
  frameSize: 0.03,
  hopSize: 0.01,
  noisePercentile: 0.2,
  thresholdMultiplier: 2.4,
  zcrMin: 0.008,
  zcrMax: 0.3,
  hangover: 0.18,
  minSpanDuration: 0.45,
};

interface FrameFeatures {
  time: number;
  energy: number;
  zcr: number;
}

/** 分帧特征：RMS 能量与过零率。 */
export function frameEnergies(
  pcm: Float32Array,
  sampleRate: number,
  options: VadOptions = DEFAULT_VAD,
): FrameFeatures[] {
  const frameLen = Math.max(1, Math.round(options.frameSize * sampleRate));
  const hop = Math.max(1, Math.round(options.hopSize * sampleRate));
  const frames: FrameFeatures[] = [];
  for (let start = 0; start + frameLen <= pcm.length; start += hop) {
    let sum = 0;
    let crossings = 0;
    let prevSample = 0;
    for (let i = 0; i < frameLen; i++) {
      const sample = pcm[start + i];
      sum += sample * sample;
      if (i > 0 && (prevSample >= 0) !== (sample >= 0)) crossings++;
      prevSample = sample;
    }
    frames.push({
      time: start / sampleRate,
      energy: Math.sqrt(sum / frameLen),
      zcr: crossings / frameLen,
    });
  }
  return frames;
}

/** 线性时间选择分位数（避免引入排序以外的依赖）。 */
function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = clamp(Math.floor(q * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[index];
}

/** 从单声道 PCM 检测说话区间，带 hangover 合并与最短时长过滤。 */
export function detectSpeech(
  pcm: Float32Array,
  sampleRate: number,
  options: VadOptions = DEFAULT_VAD,
): SpeechSpan[] {
  const frames = frameEnergies(pcm, sampleRate, options);
  if (frames.length === 0) return [];
  const noiseFloor = percentile(
    frames.map((f) => f.energy),
    options.noisePercentile,
  );
  const threshold = Math.max(1e-5, noiseFloor * options.thresholdMultiplier);

  // 语音判定 = 能量够高 + 谐波型过零率。
  // 镲片/白噪过零率接近 0.5 被排除；低频鼓的单次瞬态即使过线，
  // 也会被 minSpanDuration（需持续多帧）过滤掉。
  const isVoiceFrame = (frame: FrameFeatures): boolean =>
    frame.energy >= threshold &&
    frame.zcr >= options.zcrMin &&
    frame.zcr <= options.zcrMax;

  const spans: SpeechSpan[] = [];
  let active = false;
  let spanStart = 0;
  let lastVoice = 0;
  let energySum = 0;
  let energyCount = 0;

  const closeSpan = (endTime: number): void => {
    const duration = endTime - spanStart;
    if (duration >= options.minSpanDuration) {
      spans.push({
        start: spanStart,
        end: endTime,
        level: energyCount ? energySum / energyCount : 0,
      });
    }
    active = false;
    energySum = 0;
    energyCount = 0;
  };

  for (const frame of frames) {
    const isVoice = isVoiceFrame(frame);
    if (isVoice) {
      if (!active) {
        active = true;
        spanStart = frame.time;
      }
      lastVoice = frame.time;
      energySum += frame.energy;
      energyCount++;
    } else if (active && frame.time - lastVoice > options.hangover) {
      closeSpan(lastVoice + options.frameSize);
    }
  }
  if (active) closeSpan(lastVoice + options.frameSize);
  return spans;
}

/** 多声道混音为单声道（WebAudio 解码常见多声道）。 */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const length = Math.max(...channels.map((c) => c.length));
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    mono[i] = sum / channels.length;
  }
  return mono;
}

/**
 * 校验切点：
 * - speech-split：切点落在说话区间内部（给边界留 60ms 容差）；
 * - too-short：相邻切点间隔低于给定最小时长；
 * - out-of-range：切点超出时间线范围。
 */
export function validateCuts(
  cuts: readonly CutPoint[],
  speech: readonly SpeechSpan[],
  timelineDuration: number,
  minDurations: Record<string, number> = {},
  tolerance = 0.06,
): CutIssue[] {
  const issues: CutIssue[] = [];
  const sorted = cuts.slice().sort((a, b) => a.time - b.time);

  for (const cut of sorted) {
    if (cut.time < -1e-6 || cut.time > timelineDuration + 1e-6) {
      issues.push({
        cutId: cut.id,
        kind: "out-of-range",
        time: cut.time,
        message: `切点 ${cut.time.toFixed(3)}s 超出时间线 0..${timelineDuration.toFixed(3)}s`,
      });
    }
    for (const span of speech) {
      if (cut.time > span.start + tolerance && cut.time < span.end - tolerance) {
        issues.push({
          cutId: cut.id,
          kind: "speech-split",
          time: cut.time,
          message: `切点切断了说话区间 ${span.start.toFixed(2)}s–${span.end.toFixed(2)}s`,
        });
        break;
      }
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].time - sorted[i - 1].time;
    const rightId = sorted[i].rightClipId;
    const min = rightId ? minDurations[rightId] : undefined;
    if (min !== undefined && gap + 1e-9 < min) {
      issues.push({
        cutId: sorted[i].id,
        kind: "too-short",
        time: sorted[i].time,
        message: `片段仅 ${gap.toFixed(2)}s，短于最短停留 ${min.toFixed(2)}s`,
      });
    }
  }
  return issues;
}

/**
 * 为落在说话区间内的切点给出安全替代位置：
 * 优先移到说话区间之前（带容差），否则移到之后，并夹在相邻切点之间。
 */
export function suggestSafeTime(
  cut: CutPoint,
  speech: readonly SpeechSpan[],
  neighbors: { prevTime: number; nextTime: number },
  tolerance = 0.08,
): number {
  for (const span of speech) {
    if (cut.time > span.start && cut.time < span.end) {
      const before = span.start - tolerance;
      if (before >= neighbors.prevTime + tolerance) {
        return clamp(before, neighbors.prevTime, neighbors.nextTime);
      }
      return clamp(span.end + tolerance, neighbors.prevTime, neighbors.nextTime);
    }
  }
  return cut.time;
}
