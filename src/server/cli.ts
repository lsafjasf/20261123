#!/usr/bin/env node
/** 命令行入口：demo 全流程演示 / serve 启动服务 / resume 查看续扫点 / export 导出清单。 */
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createApp } from './http.ts';
import { ScanStore } from './store.ts';
import { analyzeBundleDirect, exportMasterShotsCsv } from './pipeline.ts';
import { FIXTURE_SPECS, buildBundle } from './fixtures.ts';

interface CliArgs {
  command: string;
  options: Map<string, string>;
}

function parseArgs(argv: string[]): CliArgs {
  const [command = '', ...rest] = argv;
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        options.set(key, next);
        i += 1;
      } else {
        options.set(key, 'true');
      }
    }
  }
  return { command, options };
}

function openStore(options: Map<string, string>): ScanStore {
  const dir = resolve(options.get('data-dir') ?? './.scan-data');
  return new ScanStore(dir);
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'demo':
      runDemo(openStore(options));
      break;
    case 'serve': {
      const store = openStore(options);
      const port = Number(options.get('port') ?? 8787);
      const server = createApp(store);
      server.listen(port, () => {
        console.log(`视频筛选服务已启动: http://localhost:${port}`);
        console.log(`数据目录: ${store.rootDir}`);
      });
      break;
    }
    case 'resume': {
      const store = openStore(options);
      const states = store.listStates();
      if (states.length === 0) {
        console.log('没有可续扫的任务');
        break;
      }
      for (const state of states) {
        const percent = state.totalFrames
          ? ((state.lastFrameIndex + 1) / state.totalFrames * 100).toFixed(1)
          : '0.0';
        console.log(
          `${state.status.padEnd(8)} ${percent.padStart(6)}%  ${state.fileName}  续扫起始帧=${state.lastFrameIndex + 1}  批次=${state.nextBatchIndex}`,
        );
      }
      break;
    }
    case 'export': {
      const store = openStore(options);
      const outDir = resolve(options.get('out') ?? './exports');
      mkdirSync(outDir, { recursive: true });
      const path = `${outDir}/master-shots.csv`;
      writeFileSync(path, exportMasterShotsCsv(store));
      console.log(`已导出镜头总表: ${path}（${store.listResults().length} 个文件）`);
      break;
    }
    default:
      console.log('用法: node src/server/cli.ts <demo|serve|resume|export> [--data-dir ./.scan-data] [--port 8787]');
  }
}

function runDemo(store: ScanStore): void {
  console.log('生成程序化样本并跑完整分析流水线（样本刻意覆盖黑场/静止/抖动误判场景）\n');
  for (const spec of FIXTURE_SPECS) {
    const bundle = buildBundle(spec);
    const output = analyzeBundleDirect(store, bundle);
    const labels = output.result.labels.map((label) => label.label).join(',') || '-';
    console.log(
      `${spec.name}\n  ${spec.description}\n  标签: ${labels} | 镜头: ${output.result.shots.length} | 黑场 ${output.result.black.length} / 静止 ${output.result.freeze.length} / 抖动 ${output.result.shake.length}\n  清单目录: ${output.exportDir}`,
    );
  }
  console.log('\n重复扫描稳定性检查：重新分析同一指标包，结果必须一致');
  const first = analyzeBundleDirect(store, buildBundle(FIXTURE_SPECS[7]));
  const second = analyzeBundleDirect(store, buildBundle(FIXTURE_SPECS[7]));
  const stable =
    JSON.stringify(first.result.shots) === JSON.stringify(second.result.shots) &&
    JSON.stringify(first.result.labels) === JSON.stringify(second.result.labels);
  console.log(stable ? '结果一致 ✓' : '结果不一致 ✗');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
