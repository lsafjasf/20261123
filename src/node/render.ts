/**
 * 离线渲染 CLI（仅用 Node 标准库）：
 *   node src/node/render.ts --seed 20261123 --duration 12 --out artifacts/mix
 * 输出 <out>.wav、<out>.metrics.json、<out>.schedule.json。
 * 同 seed + 同事件流参数两次运行产出字节相同的 WAV。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CollisionMixer } from '../core/mixer.ts';
import { generateScenario } from '../core/scenario.ts';
import { encodeWavPcm16 } from '../core/wav.ts';

interface CliOptions {
  seed: number;
  duration: number;
  rate: number;
  out: string;
}

export function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      seed: { type: 'string', default: '20261123' },
      duration: { type: 'string', default: '12' },
      rate: { type: 'string', default: '14' },
      out: { type: 'string', default: 'artifacts/mix' },
    },
    strict: true,
  });
  return {
    seed: Number(values.seed),
    duration: Number(values.duration),
    rate: Number(values.rate),
    out: String(values.out),
  };
}

export function renderOffline(options: CliOptions) {
  const events = generateScenario({
    seed: options.seed,
    duration: options.duration,
    collisionsPerSecond: options.rate,
  });
  const mixer = new CollisionMixer(options.seed, events);
  const result = mixer.renderAll();
  const wav = encodeWavPcm16(result.pcm, result.sampleRate);

  const summary = {
    seed: options.seed,
    duration: options.duration,
    collisionsPerSecond: options.rate,
    sampleRate: result.sampleRate,
    totalSamples: result.totalSamples,
    eventCount: events.length,
    accepted: mixer.scheduleRecords.filter((r) => r.accepted).length,
    rotated: mixer.scheduleRecords.filter((r) => r.reason === 'rotated').length,
    stolen: mixer.scheduleRecords.filter((r) => r.reason === 'stolen').length,
    tooSlow: mixer.scheduleRecords.filter((r) => r.reason === 'too_slow').length,
    masterPeak: Math.max(...result.metrics.map((m) => m.masterPeak)),
  };

  return { wav, result, events, summary, schedule: mixer.scheduleRecords };
}

function main(): void {
  const options = parseCli(process.argv.slice(2));
  const { wav, result, events, summary, schedule } = renderOffline(options);
  const outBase = resolve(options.out);
  mkdirSync(dirname(outBase), { recursive: true });
  writeFileSync(`${outBase}.wav`, wav);
  writeFileSync(
    `${outBase}.metrics.json`,
    JSON.stringify({ summary, metrics: result.metrics, events }),
  );
  writeFileSync(
    `${outBase}.schedule.json`,
    JSON.stringify(schedule),
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(`WAV: ${outBase}.wav (${wav.length} bytes)`);
}

const invokedPath = process.argv[1] ?? '';
if (invokedPath.endsWith('render.ts')) {
  main();
}
