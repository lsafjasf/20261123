import type { AnalysisResult, AudioTrack } from "./types.ts";
import { cubicAt } from "./resample.ts";
import { offsetAt } from "./analyze.ts";

export interface RenderOptions {
  targetSampleRate?: number;
  fadeMs?: number;
}

export function renderCorrected(recorded: AudioTrack, result: AnalysisResult, options: RenderOptions = {}): AudioTrack {
  const targetRate = options.targetSampleRate ?? result.refSampleRate;
  const channels = recorded.channels.map((channel) =>
    renderChannel(channel, recorded.sampleRate, targetRate, result),
  );
  return {
    name: `${stripExt(recorded.name)}-aligned.wav`,
    sampleRate: targetRate,
    channels,
    duration: channels[0]!.length / targetRate,
  };
}

function renderChannel(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
  result: AnalysisResult,
): Float32Array {
  const outputLength = Math.ceil((result.duration || input.length / inputRate) * outputRate);
  const output = new Float32Array(outputLength);
  for (let frame = 0; frame < outputLength; frame++) {
    const cameraT = frame / outputRate;
    const offsetMs = offsetAt(result, cameraT);
    const recPosition = cameraT + offsetMs / 1000;
    const sourceIndex = recPosition * inputRate;
    if (sourceIndex < 0 || sourceIndex >= input.length - 2) {
      output[frame] = 0;
      continue;
    }
    output[frame] = cubicAt(input, sourceIndex);
  }
  return output;
}

export function mixPreview(
  reference: AudioTrack,
  aligned: AudioTrack,
  length: number,
): AudioTrack {
  const channels: Float32Array[] = [];
  const channelCount = Math.max(reference.channels.length, aligned.channels.length);
  for (let ch = 0; ch < channelCount; ch++) {
    const ref = reference.channels[Math.min(ch, reference.channels.length - 1)]!;
    const al = aligned.channels[Math.min(ch, aligned.channels.length - 1)]!;
    const mixed = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      mixed[i] = (ref[i] ?? 0) * 0.5 + (al[i] ?? 0) * 0.5;
    }
    channels.push(mixed);
  }
  return { name: "preview-mix.wav", sampleRate: aligned.sampleRate, channels, duration: length / aligned.sampleRate };
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}
