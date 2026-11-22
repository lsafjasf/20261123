// Result schema and repeat-run stability classification.

export type FailStage =
  | 'probe'
  | 'generate'
  | 'encode'
  | 'decode'
  | 'deviation'
  | 'mse'
  | 'timeout'
  | 'harness';

export interface RunTiming {
  generateMs: number | null;
  encodeMs: number | null;
  firstChunkMs: number | null; // encode start -> first encoded chunk
  decodeMs: number | null;
  ttffMs: number | null; // decode start -> first decoded frame (time to first frame)
  mseMs: number | null;
}

export interface RunQuality {
  mae: number | null;
  psnrDb: number | null;
  framesCompared: number;
}

export interface RunResult {
  configId: string;
  runIndex: number;
  status: 'pass' | 'fail';
  failStage?: FailStage;
  error?: string;
  claimedSupport: {
    encoder: boolean | null;
    decoder: boolean | null;
    mse: boolean | null;
  };
  timing: RunTiming;
  memory: { peakJsHeapBytes: number | null };
  quality: RunQuality;
  frames: { expected: number; encoded: number; decoded: number };
  mse: 'pass' | 'fail' | 'skipped';
  mseNote?: string;
  audioClockSkewMs?: number | null;
  userAgent: string;
  platform: string;
  startedAt: string;
  durationMs: number;
}

export type Conclusion = 'pass' | 'fail' | 'flaky';

export interface ConfigSummary {
  configId: string;
  runs: RunResult[];
  conclusion: Conclusion;
  stable: boolean;
  failStages: string[];
  ttffMs: { mean: number; cv: number } | null;
  encodeMs: { mean: number; cv: number } | null;
  peakJsHeapBytes: number | null;
  psnrDb: { mean: number; min: number } | null;
}

import { distribution } from './metrics.ts';

function summarizeNumbers(values: Array<number | null>): { mean: number; cv: number } | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  const d = distribution(present);
  return { mean: d.mean, cv: d.cv };
}

export function summarizeConfig(configId: string, runs: RunResult[]): ConfigSummary {
  const statuses = new Set(runs.map((r) => r.status));
  const conclusion: Conclusion = statuses.size === 1 ? (runs[0].status as Conclusion) : 'flaky';
  const failStages = [...new Set(runs.filter((r) => r.failStage).map((r) => r.failStage as string))];
  const heaps = runs
    .map((r) => r.memory.peakJsHeapBytes)
    .filter((v): v is number => v !== null);
  const psnrs = runs.map((r) => r.quality.psnrDb).filter((v): v is number => v !== null);
  return {
    configId,
    runs,
    conclusion,
    stable: statuses.size === 1,
    failStages,
    ttffMs: summarizeNumbers(runs.map((r) => r.timing.ttffMs)),
    encodeMs: summarizeNumbers(runs.map((r) => r.timing.encodeMs)),
    peakJsHeapBytes: heaps.length ? Math.max(...heaps) : null,
    psnrDb: psnrs.length
      ? { mean: psnrs.reduce((a, b) => a + b, 0) / psnrs.length, min: Math.min(...psnrs) }
      : null,
  };
}
