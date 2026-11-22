import { applyBiquadCascade, highpassCoeffs, lowpassCoeffs } from './dsp-math.ts';
import {
  applyGain,
  applyOutputStage,
  resampleLinear,
  sumSignals,
  truePeakDb,
} from './signal-processing.ts';
import type { DeviceModel } from './devices.ts';
import type { AudioBufferData, StemGain, StemId } from './types.ts';

const STEM_IDS: StemId[] = ['dialogue', 'music', 'effects'];

export interface RenderedCondition {
  sampleRate: number;
  // Gained, mixed mono signal before the device output stage.
  preDevice: Float32Array;
  // Filtered signal entering the output stage.
  filtered: Float32Array;
  // Signal after the modelled limiter/hard clip.
  rendered: Float32Array;
  limiterHits: number;
  clipHits: number;
  truePeakDb: number;
  gainedStems: Record<StemId, Float32Array>;
}

const toMonoAtRate = (
  buffer: AudioBufferData | undefined,
  targetRate: number,
): Float32Array => {
  if (!buffer) return new Float32Array(0);
  const length = buffer.channels[0].length;
  const mono = new Float32Array(length);
  for (const channel of buffer.channels) {
    for (let i = 0; i < length; i += 1) mono[i] += channel[i] / buffer.channels.length;
  }
  return resampleLinear(mono, buffer.sampleRate, targetRate);
};

// Renders one approximate playback condition in the time domain. The spectral
// colouration (per-band response and ambient noise) is handled separately in
// the masking model; this chain covers filtering and output limiting.
export const renderCondition = (
  stems: Partial<Record<StemId, AudioBufferData>>,
  gains: StemGain,
  device: DeviceModel,
): RenderedCondition => {
  const reference = stems.dialogue ?? stems.music ?? stems.effects;
  if (!reference) throw new Error('至少需要一个音频分轨才能渲染条件');
  const sampleRate = reference.sampleRate;
  const length = Math.max(
    ...STEM_IDS.map((id) => {
      const buffer = stems[id];
      if (!buffer) return 0;
      const mono = toMonoAtRate(buffer, sampleRate);
      return mono.length;
    }),
  );
  const gainedStems = {} as Record<StemId, Float32Array>;
  for (const id of STEM_IDS) {
    const mono = toMonoAtRate(stems[id], sampleRate);
    const padded = new Float32Array(length);
    padded.set(mono, 0);
    gainedStems[id] = applyGain(padded, gains[id]);
  }
  const preDevice = sumSignals(STEM_IDS.map((id) => gainedStems[id]));
  const filtered = applyBiquadCascade(preDevice, [
    highpassCoeffs(sampleRate, device.highPassHz),
    lowpassCoeffs(sampleRate, device.lowPassHz),
  ]);
  const stage = applyOutputStage(filtered, device.ceilingDb, device.clipThresholdDb);
  return {
    sampleRate,
    preDevice,
    filtered,
    rendered: stage.output,
    limiterHits: stage.limiterHits,
    clipHits: stage.clipHits,
    truePeakDb: truePeakDb(stage.output),
    gainedStems,
  };
};

