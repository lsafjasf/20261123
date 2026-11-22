/**
 * WebAudio 适配层：负责解码文件、离线渲染混音 PCM。
 * 所有 DSP 计算仍在 dsp.ts / speech.ts 的纯函数里完成，便于 Node 单测。
 */

import { detectBeats, DEFAULT_BEAT_CONFIG, type BeatConfig } from "./dsp.ts";
import { DEFAULT_VAD, detectSpeech, downmixToMono, type VadOptions } from "../core/speech.ts";
import type { Beat, SpeechSpan } from "../core/types.ts";

export interface AudioBufferLike {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

export async function decodeAudioFile(
  bytes: ArrayBuffer | Uint8Array,
  ctx?: BaseAudioContext,
): Promise<AudioBuffer> {
  const context = ctx ?? new OfflineAudioContext(1, 1, 48000);
  const buffer = bytes instanceof Uint8Array ? bytes.buffer.slice(0) : bytes;
  return context.decodeAudioData(buffer);
}

export function bufferToMono(buffer: AudioBufferLike): Float32Array {
  const channels: Float32Array[] = [];
  for (let i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }
  return downmixToMono(channels);
}

export interface AnalysisResult {
  pcm: Float32Array;
  sampleRate: number;
  durationSec: number;
  beats: Beat[];
  speech: SpeechSpan[];
}

/** 同一条 PCM 同时驱动节拍检测与语音检测，保证共享时间坐标。 */
export function analyzeAudio(
  buffer: AudioBufferLike,
  beatConfig: BeatConfig = DEFAULT_BEAT_CONFIG,
  vadOptions: VadOptions = DEFAULT_VAD,
): AnalysisResult {
  const pcm = bufferToMono(buffer);
  const beats = detectBeats(pcm, buffer.sampleRate, beatConfig);
  const speech = detectSpeech(pcm, buffer.sampleRate, vadOptions);
  return {
    pcm,
    sampleRate: buffer.sampleRate,
    durationSec: buffer.length / buffer.sampleRate,
    beats,
    speech,
  };
}

/**
 * 用 OfflineAudioContext 把多个 AudioBuffer 按时间线偏移混成一条 PCM，
 * 供最终导出的音轨使用（与画面共享同一秒级时间坐标）。
 */
export async function renderMixToPcm(
  tracks: { buffer: AudioBuffer; offsetSec: number; gain?: number }[],
  durationSec: number,
  sampleRate: number,
): Promise<AudioBuffer> {
  const length = Math.ceil(durationSec * sampleRate);
  const ctx = new OfflineAudioContext(2, Math.max(1, length), sampleRate);
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  for (const track of tracks) {
    const source = ctx.createBufferSource();
    source.buffer = track.buffer;
    const gain = ctx.createGain();
    gain.gain.value = track.gain ?? 1;
    source.connect(gain).connect(master);
    source.start(track.offsetSec);
  }
  return ctx.startRendering();
}

/** 播放时实时分析回调（预览页面用 AnalyserNode 画波形）。 */
export function createAnalyser(ctx: AudioContext): {
  analyser: AnalyserNode;
  pull: (target: Uint8Array) => Uint8Array;
} {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.75;
  return {
    analyser,
    pull: (target: Uint8Array) => {
      analyser.getByteTimeDomainData(target as Uint8Array<ArrayBuffer>);
      return target;
    },
  };
}
