// Report rendering: artifacts/report.md + console summary.

import type { TestConfig } from '../shared/matrix.ts';
import type { ConfigSummary, RunResult } from '../shared/result.ts';

export interface ReportInput {
  summaries: ConfigSummary[];
  configs: Map<string, TestConfig>;
  repeat: number;
  browserLabel: string;
  startedAt: string;
}

function fmt(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? '-' : value.toFixed(digits);
}

function fmtMs(stat: { mean: number; cv: number } | null): string {
  if (!stat) return '-';
  return `${stat.mean.toFixed(1)}±${(stat.cv * 100).toFixed(0)}%`;
}

export function renderMarkdown(input: ReportInput): string {
  const lines: string[] = [];
  const pass = input.summaries.filter((s) => s.conclusion === 'pass');
  const fail = input.summaries.filter((s) => s.conclusion === 'fail');
  const flaky = input.summaries.filter((s) => s.conclusion === 'flaky');
  lines.push('# 编码组合实测报告');
  lines.push('');
  lines.push(`- 时间: ${input.startedAt}`);
  lines.push(`- 浏览器: ${input.browserLabel}`);
  lines.push(`- 每配置重复: ${input.repeat} 次`);
  lines.push(`- 结论: 通过 ${pass.length} / 失败 ${fail.length} / 不稳定 ${flaky.length}（共 ${input.summaries.length} 组）`);
  lines.push('');
  lines.push('| 配置 | 结论 | 首帧 ms | 编码 ms | 峰值堆 MB | PSNR dB | MSE |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of input.summaries) {
    const heap = s.peakJsHeapBytes === null ? '-' : (s.peakJsHeapBytes / 1048576).toFixed(0);
    const mseRuns = s.runs.map((r) => r.mse).join(',');
    lines.push(
      `| ${s.configId} | ${s.conclusion}${s.stable ? '' : ' (flaky)'} | ${fmtMs(s.ttffMs)} | ${fmtMs(s.encodeMs)} | ${heap} | ${fmt(s.psnrDb?.mean)} | ${mseRuns} |`,
    );
  }
  lines.push('');

  const problems = [...fail, ...flaky];
  if (problems.length > 0) {
    lines.push('## 失败与不稳定配置（含最小复现）');
    lines.push('');
    for (const s of problems) {
      lines.push(`### ${s.configId}`);
      const cfg = input.configs.get(s.configId);
      if (cfg) {
        lines.push('');
        lines.push('配置参数：');
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(cfg, null, 2));
        lines.push('```');
      }
      lines.push('');
      lines.push(`- 失败阶段: ${s.failStages.join(', ') || '-'}`);
      const errors = [...new Set(s.runs.map((r) => r.error).filter((e): e is string => !!e))];
      for (const error of errors.slice(0, 3)) lines.push(`- 错误: \`${error}\``);
      const claimed = s.runs[0]?.claimedSupport;
      if (claimed) {
        lines.push(
          `- isConfigSupported 声称: encoder=${claimed.encoder} decoder=${claimed.decoder} mse=${claimed.mse}（实测与声称可能不一致，以实测为准）`,
        );
      }
      lines.push('- 最小复现：');
      lines.push(`  - 命令行: \`node src/node/harness.ts --only ${s.configId} --repeat ${input.repeat}\``);
      lines.push(`  - 手动: \`node src/node/harness.ts --only ${s.configId} --keep-server\`，浏览器打开打印的 URL`);
      lines.push('');
    }
  } else {
    lines.push('全部配置在重复运行下结论一致且通过。');
    lines.push('');
  }
  return lines.join('\n');
}

export function renderConsoleSummary(summaries: ConfigSummary[]): string {
  const lines: string[] = [];
  for (const s of summaries) {
    const mark = s.conclusion === 'pass' ? 'PASS' : s.conclusion === 'fail' ? 'FAIL' : 'FLAKY';
    lines.push(
      `${mark} ${s.configId} ttff=${fmtMs(s.ttffMs)} encode=${fmtMs(s.encodeMs)} psnr=${fmt(s.psnrDb?.mean)}`,
    );
  }
  return lines.join('\n');
}
