// Browser entry point. Runs exactly one (config, runIndex) pair per page
// load so memory measurements are isolated, then posts the result back
// to the harness.

import type { TestConfig } from '../shared/matrix.ts';
import type { RunResult, FailStage } from '../shared/result.ts';
import { runPipeline, probeSupport, startMemorySampler, StageError } from './pipeline.ts';
import { runMseCheck } from './mse.ts';
import { measureClockSkew } from './audioClock.ts';

interface BenchOptions {
  minPsnrDb: number;
  mseTimeoutMs: number;
}

interface ConfigResponse {
  config: TestConfig;
  options: BenchOptions;
}

function logLine(text: string): void {
  const el = document.getElementById('log');
  if (el) el.textContent += text + '\n';
  console.log(text);
}

async function postResult(result: RunResult): Promise<void> {
  await fetch('/api/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
  });
}

function baseResult(configId: string, runIndex: number, startedAt: string): RunResult {
  return {
    configId,
    runIndex,
    status: 'fail',
    claimedSupport: { encoder: null, decoder: null, mse: null },
    timing: {
      generateMs: null,
      encodeMs: null,
      firstChunkMs: null,
      decodeMs: null,
      ttffMs: null,
      mseMs: null,
    },
    memory: { peakJsHeapBytes: null },
    quality: { mae: null, psnrDb: null, framesCompared: 0 },
    frames: { expected: 0, encoded: 0, decoded: 0 },
    mse: 'skipped',
    userAgent: navigator.userAgent,
    platform: navigator.platform ?? 'unknown',
    startedAt,
    durationMs: 0,
  };
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const configId = params.get('config');
  const runIndex = Number(params.get('run') ?? '0');
  if (!configId) {
    logLine('missing ?config= parameter');
    return;
  }
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const result = baseResult(configId, runIndex, startedAt);
  const sampler = startMemorySampler();

  try {
    const response = await fetch(`/api/config?id=${encodeURIComponent(configId)}`);
    if (!response.ok) throw new Error(`config fetch failed: ${response.status}`);
    const { config, options } = (await response.json()) as ConfigResponse;
    logLine(`running ${config.id} (run ${runIndex})`);

    result.claimedSupport = await probeSupport(config);
    const output = await runPipeline(config, options.minPsnrDb, result.claimedSupport);
    result.timing = output.timing;
    result.quality = output.quality;
    result.frames = output.frames;

    const mse = await runMseCheck(config, output.chunks, output.decoderDescription, options.mseTimeoutMs);
    result.mse = mse.status;
    result.mseNote = mse.note;
    result.timing.mseMs = mse.durationMs;
    if (mse.status === 'fail') {
      throw new StageError('mse', mse.note);
    }

    const skew = await measureClockSkew(400);
    result.audioClockSkewMs = skew.skewMs;

    result.status = 'pass';
  } catch (err) {
    result.status = 'fail';
    if (err instanceof StageError) {
      result.failStage = err.stage;
      result.error = err.message;
    } else {
      result.failStage = 'harness' as FailStage;
      result.error = String(err);
    }
  } finally {
    result.memory.peakJsHeapBytes = sampler.stop();
    result.durationMs = performance.now() - start;
  }

  logLine(`${result.status.toUpperCase()} ${result.configId} ${result.error ?? ''}`);
  try {
    await postResult(result);
    logLine('result posted');
  } catch (err) {
    logLine(`failed to post result: ${String(err)}`);
  }
}

main();
