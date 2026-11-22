import { DEVICE_MODELS, DEVICE_ORDER } from './devices.ts';
import { measureLoudness } from './loudness.ts';
import { analyzeDevice } from './masking.ts';
import { renderCondition } from './render-device.ts';
import { mixToMono } from './signal-processing.ts';
import type {
  AnalysisReport,
  AudioBufferData,
  DeviceAnalysis,
  LoudnessSummary,
  StemGain,
  StemId,
} from './types.ts';
import { MODEL_NOTICE } from './types.ts';

const STEM_IDS: StemId[] = ['dialogue', 'music', 'effects'];

const silenceBuffer = (sampleRate: number, length: number): AudioBufferData => ({
  sampleRate,
  channels: [new Float32Array(length)],
  label: 'silence',
});

const normalizeLengths = (
  stems: Partial<Record<StemId, AudioBufferData>>,
): { padded: Record<StemId, AudioBufferData>; sampleRate: number; length: number } => {
  const reference = stems.dialogue ?? stems.music ?? stems.effects;
  if (!reference) throw new Error('至少需要提供一个音频分轨');
  const sampleRate = reference.sampleRate;
  for (const id of STEM_IDS) {
    const buffer = stems[id];
    if (buffer && buffer.sampleRate !== sampleRate) {
      throw new Error(`分轨 ${id} 采样率 ${buffer.sampleRate} 与参考 ${sampleRate} 不一致`);
    }
  }
  const length = Math.max(
    ...STEM_IDS.map((id) => stems[id]?.channels[0].length ?? 0),
  );
  const padded = {} as Record<StemId, AudioBufferData>;
  for (const id of STEM_IDS) {
    const buffer = stems[id] ?? silenceBuffer(sampleRate, length);
    if (buffer.channels[0].length === length) {
      padded[id] = buffer;
      continue;
    }
    const channels = buffer.channels.map((channel) => {
      const copy = new Float32Array(length);
      copy.set(channel, 0);
      return copy;
    });
    padded[id] = { ...buffer, channels };
  }
  return { padded, sampleRate, length };
};

const mixStems = (stems: Record<StemId, AudioBufferData>, gains: StemGain): AudioBufferData => {
  const length = stems.dialogue.channels[0].length;
  const mono = new Float32Array(length);
  for (const id of STEM_IDS) {
    const stemMono = mixToMono(stems[id]);
    const linear = Math.pow(10, gains[id] / 20);
    for (let i = 0; i < length; i += 1) mono[i] += stemMono[i] * linear;
  }
  return {
    sampleRate: stems.dialogue.sampleRate,
    channels: [mono],
    label: 'mix',
  };
};

export interface PipelineOptions {
  gains: StemGain;
  levelMatchTargetLufs?: number;
}

export const runAnalysis = (
  inputStems: Partial<Record<StemId, AudioBufferData>>,
  options: PipelineOptions,
): AnalysisReport => {
  const { padded, sampleRate, length } = normalizeLengths(inputStems);
  const gains: StemGain = { ...options.gains };

  let levelMatchApplied = false;
  if (typeof options.levelMatchTargetLufs === 'number') {
    // The optional A/B convenience applies one static gain to the whole mix.
    // It never modifies stem balance and is disabled by default in the UI.
    const previewMix = mixStems(padded, gains);
    const previewLoudness = measureLoudness(previewMix).integratedLufs;
    const trim = options.levelMatchTargetLufs - previewLoudness;
    for (const id of STEM_IDS) gains[id] += trim;
    levelMatchApplied = true;
  }

  const stemLevels = {} as Record<StemId, LoudnessSummary>;
  for (const id of STEM_IDS) stemLevels[id] = measureLoudness(padded[id]);
  const mix = mixStems(padded, gains);
  const mixLevels = measureLoudness(mix);

  const devices: DeviceAnalysis[] = DEVICE_ORDER.map((deviceId) => {
    const device = DEVICE_MODELS[deviceId];
    const condition = renderCondition(padded, gains, device);
    const result = analyzeDevice(condition, gains, device);
    const outputLoudness = measureLoudness({
      sampleRate,
      channels: [condition.rendered],
      label: deviceId,
    });
    return {
      deviceId,
      events: result.events,
      frames: result.frames,
      outputLoudness,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    modelNotice: MODEL_NOTICE,
    durationSec: length / sampleRate,
    sampleRate,
    stemLevels,
    mixLevels,
    devices,
    gainSettings: gains,
    levelMatchApplied,
  };
};
