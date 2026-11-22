import { clamp, dbToGain, gainToDb } from './dsp-math.ts';
import type { AudioBufferData } from './types.ts';

export const mixToMono = (buffer: AudioBufferData): Float32Array => {
  const length = buffer.channels[0].length;
  const mono = new Float32Array(length);
  for (const channel of buffer.channels) {
    for (let i = 0; i < length; i += 1) {
      mono[i] += channel[i] / buffer.channels.length;
    }
  }
  return mono;
};

// 4x linear interpolation oversampled peak, a pragmatic true-peak proxy.
export const truePeakDb = (signal: Float32Array): number => {
  let peak = 0;
  const factor = 4;
  for (let i = 0; i < signal.length - 1; i += 1) {
    const current = Math.abs(signal[i]);
    if (current > peak) peak = current;
    const next = Math.abs(signal[i + 1]);
    for (let step = 1; step < factor; step += 1) {
      const fraction = step / factor;
      const interp = Math.abs(signal[i] * (1 - fraction) + signal[i + 1] * fraction);
      if (interp > peak) peak = interp;
    }
    if (next > peak) peak = next;
  }
  return gainToDb(peak);
};

// Look-ahead-free soft limiter followed by a hard ceiling. The threshold is
// expressed in dB; compression above it uses an instantaneous knee.
export const applyOutputStage = (
  signal: Float32Array,
  ceilingDb: number,
  clipThresholdDb: number,
): { output: Float32Array; limiterHits: number; clipHits: number } => {
  const ceiling = dbToGain(ceilingDb);
  const clipLevel = dbToGain(clipThresholdDb);
  const output = new Float32Array(signal.length);
  let limiterHits = 0;
  let clipHits = 0;
  for (let i = 0; i < signal.length; i += 1) {
    const sample = signal[i];
    const magnitude = Math.abs(sample);
    if (magnitude > ceiling) {
      limiterHits += 1;
      // Soft knee: smoothly compress overshoot instead of a brick wall.
      const overshootDb = gainToDb(magnitude) - ceilingDb;
      const compressedDb = ceilingDb + overshootDb / 4;
      const compressed = clamp(dbToGain(compressedDb), 0, clipLevel);
      output[i] = Math.sign(sample) * compressed;
    } else {
      output[i] = sample;
    }
    if (Math.abs(output[i]) >= clipLevel) {
      clipHits += 1;
      output[i] = Math.sign(output[i]) * clipLevel;
    }
  }
  return { output, limiterHits, clipHits };
};

export const applyGain = (signal: Float32Array, gainDb: number): Float32Array => {
  const gain = dbToGain(gainDb);
  const output = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i += 1) {
    output[i] = signal[i] * gain;
  }
  return output;
};

// Resamples with linear interpolation. The analysis models only need
// approximate rates for cross-rate comparisons.
export const resampleLinear = (
  signal: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array => {
  if (fromRate === toRate) return signal.slice();
  const ratio = fromRate / toRate;
  const length = Math.floor(signal.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const fraction = position - left;
    const right = Math.min(left + 1, signal.length - 1);
    output[i] = signal[left] * (1 - fraction) + signal[right] * fraction;
  }
  return output;
};

export const sumSignals = (signals: Float32Array[]): Float32Array => {
  if (signals.length === 0) return new Float32Array(0);
  const length = signals[0].length;
  const output = new Float32Array(length);
  for (const signal of signals) {
    for (let i = 0; i < length; i += 1) {
      output[i] += signal[i];
    }
  }
  return output;
};
