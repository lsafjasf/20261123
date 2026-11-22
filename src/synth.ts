import {
  beatCrossings,
  computeTiming,
  type BeatCrossing,
  type SampleTiming,
  type TapeConfig,
  rateAt,
  SAMPLE_RATE,
  sourcePositionAt,
} from "./model.js";

const TAU = Math.PI * 2;

export interface AudioAnalysis {
  peak: number;
  postImpactPeak: number;
  postImpactNonZero: number;
  lastNonZeroSample: number;
  impactSampleIsZero: boolean;
  checkedTailSamples: number;
}

export interface RenderResult {
  config: TapeConfig;
  timing: SampleTiming;
  left: Float32Array;
  right: Float32Array;
  crossings: BeatCrossing[];
  analysis: AudioAnalysis;
  sourcePeak: number;
}

function hashNoise(value: number): number {
  let x = value | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x ^= x >>> 16;
  return ((x >>> 0) / 0xffffffff) * 2 - 1;
}

function triangle(phase: number): number {
  const wrapped = phase - Math.floor(phase);
  return 1 - 4 * Math.abs(wrapped - 0.5);
}

function pan(sample: number, amount: number, channel: number): number {
  return channel === 0 ? sample * (1 - amount * 0.45) : sample * (1 + amount * 0.45);
}

function musicSample(timeSec: number, bpm: number, channel: number, sampleIndex: number): number {
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const beatIndex = Math.floor(timeSec / beatSec);
  const beatAge = timeSec - beatIndex * beatSec;
  const barIndex = Math.floor(timeSec / barSec);
  const barAge = timeSec - barIndex * barSec;
  const beatInBar = ((beatIndex % 4) + 4) % 4;
  let mix = 0;

  const kickEnv = Math.exp(-beatAge * 8.2) * Math.min(1, beatAge / 0.0035);
  const kickPhase = TAU * (45 * beatAge + ((142 - 45) * (1 - Math.exp(-beatAge * 19))) / 19);
  const kick = Math.sin(kickPhase) * kickEnv * 0.48;
  mix += pan(kick, -0.04, channel);

  if (beatInBar === 1 || beatInBar === 3) {
    const snareNoise = hashNoise(sampleIndex + channel * 7919);
    const snareTone = Math.sin(TAU * 188 * beatAge);
    const snare = (snareNoise * 0.16 + snareTone * 0.08) * Math.exp(-beatAge * 16);
    mix += snare;
  }

  const eighthSec = beatSec / 2;
  const hatIndex = Math.floor(timeSec / eighthSec);
  const hatAge = timeSec - hatIndex * eighthSec;
  const hatNoise = hashNoise(sampleIndex + channel * 1297) - hashNoise(sampleIndex - 3 + channel * 1297);
  const hat = hatNoise * 0.047 * Math.exp(-hatAge * 37) * (hatIndex % 2 === 0 ? 1 : 0.64);
  mix += pan(hat, hatIndex % 2 === 0 ? -0.4 : 0.34, channel);

  const bassNotes = [55, 55, 65.406, 49];
  const bassFreq = bassNotes[beatInBar];
  const bassEnv = Math.min(1, beatAge / 0.008) * Math.exp(-beatAge * 2.1);
  const bassPhase = TAU * bassFreq * beatAge;
  const bass = (Math.sin(bassPhase) * 0.15 + triangle(bassPhase) * 0.035) * bassEnv;
  const duck = 1 - Math.exp(-beatAge * 12) * 0.42;
  mix += bass * duck;

  const sixteenthSec = beatSec / 4;
  const leadIndex = Math.floor(timeSec / sixteenthSec);
  const leadAge = timeSec - leadIndex * sixteenthSec;
  const leadPattern = [440, 523.251, 659.255, 523.251, 392, 493.883, 587.33, 493.883];
  const leadFreq = leadPattern[((leadIndex % 8) + 8) % 8] * (barIndex % 2 === 0 ? 1 : 0.5);
  const leadEnv = Math.min(1, leadAge / 0.004) * Math.exp(-leadAge * 8.6);
  const lead = triangle(TAU * leadFreq * leadAge) * 0.055 * leadEnv * duck;
  mix += pan(lead, leadIndex % 2 === 0 ? -0.24 : 0.24, channel);

  const padEnv = Math.min(1, barAge / 0.22) * Math.exp(-barAge * 0.72);
  const chord = [220, 261.626, 329.628];
  let pad = 0;
  for (let voice = 0; voice < chord.length; voice += 1) {
    const detune = voice === 1 ? 1.003 : 1;
    const phase = TAU * chord[voice] * detune * barAge;
    pad += Math.sin(phase + channel * 0.08) * 0.022 + triangle(phase) * 0.006;
  }
  mix += pad * padEnv * duck * 0.72;

  const engineFreq = 58 + Math.sin(TAU * 0.17 * timeSec) * 1.6;
  const engine = Math.sin(TAU * engineFreq * timeSec + channel * 0.2) * 0.024;
  const rumble = hashNoise(sampleIndex + channel * 3301) * 0.006;
  mix += engine + rumble;

  return Math.tanh(mix * 1.18) * 0.72;
}

const sourceCache = new Map<string, {
  left: Float32Array;
  right: Float32Array;
  peak: number;
}>();

function buildSource(config: TapeConfig, sampleRate: number): {
  left: Float32Array;
  right: Float32Array;
  peak: number;
} {
  const cacheKey = [
    config.bpm.toFixed(9),
    config.impactSec.toFixed(9),
    sampleRate,
  ].join("|");
  const cached = sourceCache.get(cacheKey);
  if (cached) return cached;

  const duration = config.impactSec + 0.35;
  const length = Math.ceil(duration * sampleRate) + 4;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  let peak = 0;

  for (let index = 0; index < length; index += 1) {
    const timeSec = index / sampleRate;
    left[index] = musicSample(timeSec, config.bpm, 0, index);
    right[index] = musicSample(timeSec, config.bpm, 1, index);
    peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
  }

  const scale = peak > 0.92 ? 0.92 / peak : 1;
  if (scale !== 1) {
    for (let index = 0; index < length; index += 1) {
      left[index] *= scale;
      right[index] *= scale;
    }
    peak *= scale;
  }
  const source = { left, right, peak };
  sourceCache.set(cacheKey, source);
  while (sourceCache.size > 4) {
    const first = sourceCache.keys().next().value;
    if (first === undefined) break;
    sourceCache.delete(first);
  }
  return source;
}

function readLinear(data: Float32Array, position: number): number {
  const index = Math.floor(position);
  const next = Math.min(data.length - 1, index + 1);
  const fraction = position - index;
  return data[index] * (1 - fraction) + data[next] * fraction;
}

function analyze(left: Float32Array, right: Float32Array, impactSample: number): AudioAnalysis {
  let peak = 0;
  let postImpactPeak = 0;
  let postImpactNonZero = 0;
  let lastNonZeroSample = -1;
  let impactSampleIsZero = false;

  for (let index = 0; index < left.length; index += 1) {
    const level = Math.max(Math.abs(left[index]), Math.abs(right[index]));
    peak = Math.max(peak, level);
    if (level > 0) lastNonZeroSample = index;
    if (index >= impactSample) {
      postImpactPeak = Math.max(postImpactPeak, level);
      if (level !== 0) postImpactNonZero += 1;
    }
  }
  impactSampleIsZero =
    left[impactSample] === 0 && right[impactSample] === 0;

  return {
    peak,
    postImpactPeak,
    postImpactNonZero,
    lastNonZeroSample,
    impactSampleIsZero,
    checkedTailSamples: left.length - impactSample,
  };
}

export function renderTapeStop(config: TapeConfig, sampleRate = SAMPLE_RATE): RenderResult {
  const timing = computeTiming(config, sampleRate);
  const source = buildSource(config, sampleRate);
  const left = new Float32Array(timing.totalSamples);
  const right = new Float32Array(timing.totalSamples);
  const fadeSamples = Math.max(1, Math.round(0.004 * sampleRate));
  const fadeStart = timing.impactSample - fadeSamples;
  let filterLeft = 0;
  let filterRight = 0;

  for (let index = 0; index < timing.impactSample; index += 1) {
    const timeSec = index / sampleRate;
    const rate = rateAt(timeSec, config);
    const sourcePosition = sourcePositionAt(timeSec, config);
    const rawLeft = readLinear(source.left, sourcePosition * sampleRate);
    const rawRight = readLinear(source.right, sourcePosition * sampleRate);
    const cutoff = 380 + 19_620 * Math.pow(rate, 0.52);
    const alpha = 1 - Math.exp((-TAU * cutoff) / sampleRate);
    filterLeft += alpha * (rawLeft - filterLeft);
    filterRight += alpha * (rawRight - filterRight);
    const fade = index < fadeStart ? 1 : Math.max(0, (timing.impactSample - index) / fadeSamples);
    left[index] = Math.fround(filterLeft * fade);
    right[index] = Math.fround(filterRight * fade);
  }

  left[timing.impactSample] = 0;
  right[timing.impactSample] = 0;

  let renderPeak = 0;
  for (let index = 0; index < timing.impactSample; index += 1) {
    renderPeak = Math.max(renderPeak, Math.abs(left[index]), Math.abs(right[index]));
  }
  if (renderPeak > 0 && renderPeak !== 0.88) {
    const masterGain = 0.88 / renderPeak;
    for (let index = 0; index < timing.impactSample; index += 1) {
      left[index] = Math.fround(left[index] * masterGain);
      right[index] = Math.fround(right[index] * masterGain);
    }
  }

  return {
    config,
    timing,
    left,
    right,
    crossings: beatCrossings(config, sampleRate),
    analysis: analyze(left, right, timing.impactSample),
    sourcePeak: source.peak,
  };
}

