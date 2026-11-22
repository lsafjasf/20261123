import { clamp, gainToDb, type ChannelMetrics } from "./domain.ts";

export interface AudioMetricState {
  baselineDb: number;
  previousDb: number;
  onsetFloor: number;
}

export interface SampleMetrics {
  energyDb: number;
  onset: number;
  peak: number;
}

export function initialMetricState(): AudioMetricState {
  return { baselineDb: -60, previousDb: -60, onsetFloor: -50 };
}

export function analyzeTimeDomain(samples: Float32Array, state: AudioMetricState): SampleMetrics {
  let sum = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    sum += value * value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  const energyDb = gainToDb(rms);
  const attack = energyDb - state.baselineDb;
  const delta = energyDb - state.previousDb;
  const transient = Math.max(0, attack - 1.5, delta * 0.72);
  const onset = clamp((transient - 2) / 13, 0, 1);
  state.baselineDb = state.baselineDb * 0.91 + energyDb * 0.09;
  state.previousDb = energyDb;
  return { energyDb, onset, peak };
}

export function analyzeChannel(samples: Float32Array, camera: ChannelMetrics["camera"], state: AudioMetricState): ChannelMetrics {
  const metrics = analyzeTimeDomain(samples, state);
  return { camera, energyDb: metrics.energyDb, onset: metrics.onset };
}
