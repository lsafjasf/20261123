import type { PcmBuffer, TrackKind } from './types.ts';

/**
 * Dialogue-first default mix.
 * Dialogue (zh or en) is summed and used as a side-chain control signal.
 * When dialogue energy rises, the music/effects bed gain is smoothly ducked
 * with attack/release smoothing so the language switch never restarts playback.
 */
export interface MixOptions {
  /** Maximum attenuation applied to the music bed during dialogue, in dB. */
  duckDepthDb: number;
  /** Envelope follower attack time in seconds. */
  attackSec: number;
  /** Envelope follower release time in seconds. */
  releaseSec: number;
  /** Analysis window for the side-chain envelope, in milliseconds. */
  windowMs: number;
  /** Linear gain applied to the summed dialogue. */
  dialogueGain: number;
  /** Linear gain applied to the music bed before ducking. */
  musicGain: number;
}

export const DEFAULT_MIX_OPTIONS: MixOptions = {
  duckDepthDb: -9,
  attackSec: 0.02,
  releaseSec: 0.25,
  windowMs: 20,
  dialogueGain: 1,
  musicGain: 0.9,
};

export interface MixResult {
  mix: PcmBuffer;
  /** Per-window ducking coefficient (0..1 attenuation multiplier). */
  duckCurve: number[];
  windowSec: number;
}

function sumDialogue(
  tracks: { kind: TrackKind; pcm: PcmBuffer }[],
  frameCount: number,
  channelCount: number,
): Float32Array[] {
  const out: Float32Array[] = Array.from({ length: channelCount }, () => new Float32Array(frameCount));
  for (const track of tracks) {
    track.pcm.channels.forEach((channel, ch) => {
      const target = out[Math.min(ch, channelCount - 1)];
      for (let i = 0; i < Math.min(channel.length, frameCount); i++) target[i] += channel[i];
    });
  }
  return out;
}

/** Build a dialogue-first mix. All inputs must share sample rate and length. */
export function buildDialogueFirstMix(
  inputs: { kind: TrackKind; pcm: PcmBuffer }[],
  activeDialogue: TrackKind,
  options: MixOptions = DEFAULT_MIX_OPTIONS,
): MixResult {
  const sampleRate = inputs[0]?.pcm.sampleRate ?? 48000;
  const channelCount = Math.max(...inputs.map((t) => t.pcm.channels.length));
  const frameCount = Math.max(...inputs.map((t) => t.pcm.channels[0].length));
  const windowFrames = Math.max(1, Math.floor((options.windowMs / 1000) * sampleRate));

  const dialogue = sumDialogue(
    inputs.filter((t) => t.kind === activeDialogue),
    frameCount,
    channelCount,
  );
  const music = inputs.filter((t) => t.kind === 'music');

  // Side-chain envelope from mono dialogue level, one value per window.
  const windowCount = Math.ceil(frameCount / windowFrames);
  const duckCurve: number[] = new Array(windowCount).fill(1);
  const minGain = Math.pow(10, options.duckDepthDb / 20);
  const attackCoef = Math.exp(-1 / (options.attackSec * sampleRate / windowFrames));
  const releaseCoef = Math.exp(-1 / (options.releaseSec * sampleRate / windowFrames));

  let smoothed = 0;
  for (let w = 0; w < windowCount; w++) {
    const start = w * windowFrames;
    const end = Math.min(start + windowFrames, frameCount);
    let energy = 0;
    let count = 0;
    for (const channel of dialogue) {
      for (let i = start; i < end; i++) {
        energy += channel[i] * channel[i];
        count++;
      }
    }
    const rms = count > 0 ? Math.sqrt(energy / count) : 0;
    // Normalize dialogue presence to roughly full-scale speech.
    const presence = Math.min(1, rms / 0.2);
    const targetGain = 1 - (1 - minGain) * presence;
    const coef = targetGain < smoothed ? attackCoef : releaseCoef;
    smoothed = targetGain + coef * (smoothed - targetGain);
    duckCurve[w] = smoothed;
  }

  const mix: Float32Array[] = Array.from({ length: channelCount }, () => new Float32Array(frameCount));
  const duckAt = (frame: number): number =>
    duckCurve[Math.min(windowCount - 1, Math.floor(frame / windowFrames))];

  for (let frame = 0; frame < frameCount; frame++) {
    const duck = duckAt(frame);
    for (let ch = 0; ch < channelCount; ch++) {
      let sample = 0;
      if (dialogue[ch]) sample += dialogue[ch][frame] * options.dialogueGain;
      for (const bed of music) {
        const source = bed.pcm.channels[Math.min(ch, bed.pcm.channels.length - 1)];
        if (frame < source.length) sample += source[frame] * options.musicGain * duck;
      }
      mix[ch][frame] = sample;
    }
  }

  return {
    mix: { sampleRate, channels: mix },
    duckCurve,
    windowSec: options.windowMs / 1000,
  };
}

/**
 * Switch the spoken language without rebuilding the graph: returns a new
 * mix using the same ducking parameters. The video element keeps playing.
 */
export function switchDialogueLanguage(
  inputs: { kind: TrackKind; pcm: PcmBuffer }[],
  language: TrackKind,
  options?: MixOptions,
): MixResult {
  return buildDialogueFirstMix(inputs, language, options);
}
