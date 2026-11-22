#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { decodeWav } from '../shared/wav-codec.ts';
import { runAnalysis } from '../shared/analysis-pipeline.ts';
import type { StemGain, StemId } from '../shared/types.ts';
import { toMarkdown } from './report.ts';
import { runSelfTest } from './selftest.ts';

interface CliArgs {
  stems: Partial<Record<StemId, string>>;
  outJson?: string;
  outMarkdown?: string;
  gains: StemGain;
  levelMatch?: number;
  selftest: boolean;
  demo: boolean;
}

const DEFAULT_GAINS: StemGain = { dialogue: 0, music: 0, effects: 0 };

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {
    stems: {},
    gains: { ...DEFAULT_GAINS },
    selftest: false,
    demo: false,
  };
  const gainFlag: Record<string, StemId> = {
    '--dialogue-gain': 'dialogue',
    '--music-gain': 'music',
    '--effects-gain': 'effects',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--selftest') {
      args.selftest = true;
    } else if (flag === '--demo') {
      args.demo = true;
    } else if (flag === '--dialogue' || flag === '--music' || flag === '--effects') {
      const stem = flag.slice(2) as StemId;
      args.stems[stem] = next;
      i += 1;
    } else if (flag === '--json') {
      args.outJson = next;
      i += 1;
    } else if (flag === '--markdown') {
      args.outMarkdown = next;
      i += 1;
    } else if (flag === '--level-match') {
      args.levelMatch = Number(next);
      i += 1;
    } else if (flag in gainFlag) {
      args.gains[gainFlag[flag]] = Number(next);
      i += 1;
    } else if (flag === '--help' || flag === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`未知参数：${flag}`);
    }
  }
  return args;
};

const printHelp = (): void => {
  process.stdout.write(
    [
      '用法：',
      '  node src/cli/index.ts --dialogue d.wav --music m.wav --effects e.wav [选项]',
      '  node src/cli/index.ts --demo --json report.json --markdown report.md',
      '  node src/cli/index.ts --selftest',
      '',
      '选项：',
      '  --dialogue/--music/--effects <path>  分轨 WAV（PCM/float，可只给部分）',
      '  --dialogue-gain/--music-gain/--effects-gain <dB>  分轨开关与微调（-96 视为静音）',
      '  --level-match <LUFS>  可选监听对齐，默认关闭；不影响分轨平衡',
      '  --json <path>         写入完整 JSON 报告',
      '  --markdown <path>     写入 Markdown 报告',
      '',
    ].join('\n'),
  );
};

const loadStems = async (
  paths: Partial<Record<StemId, string>>,
): Promise<Parameters<typeof runAnalysis>[0]> => {
  const loaded: Parameters<typeof runAnalysis>[0] = {};
  for (const [stem, path] of Object.entries(paths) as [StemId, string][]) {
    const bytes = new Uint8Array(await readFile(resolve(path)));
    loaded[stem] = decodeWav(bytes, stem);
  }
  return loaded;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) {
    await runSelfTest();
    return;
  }
  const stems = args.demo
    ? (await import('../shared/fixtures.ts')).synthesizeFixture()
    : await loadStems(args.stems);
  if (!args.demo && Object.keys(args.stems).length === 0) {
    printHelp();
    throw new Error('请至少提供一个分轨，或使用 --demo / --selftest');
  }
  const report = runAnalysis(stems, {
    gains: args.gains,
    levelMatchTargetLufs: args.levelMatch,
  });
  if (args.outJson) {
    await mkdir(dirname(resolve(args.outJson)), { recursive: true });
    await writeFile(resolve(args.outJson), JSON.stringify(report, null, 2));
  }
  if (args.outMarkdown) {
    await mkdir(dirname(resolve(args.outMarkdown)), { recursive: true });
    await writeFile(resolve(args.outMarkdown), toMarkdown(report));
  }
  process.stdout.write(`${toMarkdown(report)}\n`);
  process.stdout.write(`\nJSON 事件总数：${report.devices.reduce((n, d) => n + d.events.length, 0)}\n`);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`错误：${message}\n`);
  process.exit(1);
});
