import { Crossover, BAND_NAMES } from './crossover.js';
import { processBand, dbToLin, linToDb, type BandCompSettings } from './dynamics.js';
import { lookaheadLimit, oversampledPeakDb, samplePeakDb } from './limiter.js';
import { measureLoudness, type LoudnessResult } from './loudness.js';
import { analyzeTransients, type BandTransientReport } from './transient.js';

export interface EngineSettings {
  crossovers: number[];
  bands: BandCompSettings[];
  targetLufs: number;
  ceilingDb: number;
  maxMakeupDb: number;
  maxLimiterGrDb: number;
}

export interface BandResult {
  name: string;
  gainDb: Float32Array;
  envDb: Float32Array;
  output: Float32Array;      // processed band, time-aligned with input
  energyDb: Float32Array;    // short-term RMS, 50 ms hops
  peakDb: number;
}

export interface RenderResult {
  output: Float32Array;
  bands: BandResult[];
  limiterGainDb: Float32Array;
  loudnessBefore: LoudnessResult;
  loudnessAfter: LoudnessResult;
  peakBeforeDb: number;
  peakAfterDb: number;
  truePeakAfterDb: number;
  makeupDb: number;
  ceilingDb: number;
  ceilingOk: boolean;
  transient: BandTransientReport[];
}

const LIMITER_LOOKAHEAD_MS = 1.5;

function shortTermEnergy(x: Float32Array, fs: number, hopMs = 50): Float32Array {
  const hop = Math.max(1, Math.round(hopMs * 0.001 * fs));
  const count = Math.ceil(x.length / hop);
  const out = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    let sum = 0;
    const from = b * hop;
    const to = Math.min(x.length, from + hop);
    for (let i = from; i < to; i++) sum += x[i] * x[i];
    out[b] = linToDb(Math.sqrt(sum / Math.max(1, to - from)));
  }
  return out;
}

export function render(input: Float32Array, fs: number, settings: EngineSettings): RenderResult {
  const n = input.length;
  const crossover = new Crossover(fs, settings.crossovers, n);
  const bandInputs = settings.crossovers.map(() => new Float32Array(n));
  bandInputs.push(new Float32Array(n));
  crossover.split(input, bandInputs);

  const bands: BandResult[] = [];
  const sum = new Float32Array(n);
  for (let b = 0; b < bandInputs.length; b++) {
    const s = settings.bands[b];
    const r = processBand(bandInputs[b], fs, s);
    for (let i = 0; i < n; i++) sum[i] += r.output[i];
    bands.push({
      name: BAND_NAMES[b] ?? `Band ${b + 1}`,
      gainDb: r.gainDb,
      envDb: r.envDb,
      output: r.output,
      energyDb: shortTermEnergy(r.output, fs),
      peakDb: samplePeakDb(r.output),
    });
  }

  // Loudness normalization toward the target. Makeup is capped so the
  // limiter never has to shave more than maxLimiterGrDb, which bounds
  // how hard the master bus can be squashed (limits over-compression).
  const loudnessBefore = measureLoudness(input, fs);
  const loudnessSum = measureLoudness(sum, fs);
  const sumPeakDb = samplePeakDb(sum);
  let makeupDb = 0;
  if (isFinite(loudnessSum.integratedLufs)) {
    makeupDb = settings.targetLufs - loudnessSum.integratedLufs;
    makeupDb = Math.min(
      makeupDb,
      settings.maxMakeupDb,
      settings.ceilingDb - sumPeakDb + settings.maxLimiterGrDb,
    );
  }
  const makeupLin = dbToLin(makeupDb);
  const gained = new Float32Array(n);
  for (let i = 0; i < n; i++) gained[i] = sum[i] * makeupLin;

  const limited = lookaheadLimit(gained, fs, settings.ceilingDb, LIMITER_LOOKAHEAD_MS);
  const look = Math.max(1, Math.round(LIMITER_LOOKAHEAD_MS * 0.001 * fs));

  // Re-align the limiter output with the input (drop the lookahead delay).
  const output = new Float32Array(n);
  const limiterGainDb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i + look;
    output[i] = j < n ? limited.output[j] : 0;
    limiterGainDb[i] = j < n ? limited.gainDb[j] : 0;
  }

  const loudnessAfter = measureLoudness(output, fs);
  const peakAfterDb = samplePeakDb(output);
  const truePeakAfterDb = oversampledPeakDb(output);

  const transient = bands.map((band, b) => {
    const after = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = i + look;
      const lg = j < n ? dbToLin(limited.gainDb[j]) : 1;
      after[i] = band.output[i] * makeupLin * lg;
    }
    return analyzeTransients(band.name, bandInputs[b], after, fs);
  });

  return {
    output,
    bands,
    limiterGainDb,
    loudnessBefore,
    loudnessAfter,
    peakBeforeDb: samplePeakDb(input),
    peakAfterDb,
    truePeakAfterDb,
    makeupDb,
    ceilingDb: settings.ceilingDb,
    ceilingOk: truePeakAfterDb <= settings.ceilingDb + 0.05,
    transient,
  };
}
