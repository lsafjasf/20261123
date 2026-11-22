import { DEVICE_MODELS, STEM_LABELS } from '../shared/devices.ts';
import type { AnalysisReport, LoudnessSummary, StemId } from '../shared/types.ts';

const STEM_IDS: StemId[] = ['dialogue', 'music', 'effects'];

const row = (label: string, summary: LoudnessSummary): string =>
  `| ${label} | ${summary.integratedLufs.toFixed(1)} | ${summary.shortTermMaxLufs.toFixed(1)} | ${summary.truePeakDb.toFixed(1)} | ${summary.crestFactorDb.toFixed(1)} |`;

// Mirrors src/cli/report.ts so browser exports match CLI output without a
// network call. Keep both in sync when changing report fields.
export const reportToMarkdown = (report: AnalysisReport): string => {
  const lines: string[] = [];
  lines.push('# 课程混音本地检查报告', '');
  lines.push(`> ${report.modelNotice}`, '');
  lines.push(`- 时长：${report.durationSec.toFixed(2)} s，采样率：${report.sampleRate} Hz`);
  lines.push(
    '- 分轨增益（dB）：' +
      STEM_IDS.map((id) => `${STEM_LABELS[id]} ${report.gainSettings[id].toFixed(1)}`).join('，'),
  );
  lines.push(
    `- 响度对齐：${report.levelMatchApplied ? '已启用（仅监听对比）' : '关闭（默认）'}`,
    '',
    '## 响度与峰值',
    '',
    '| 对象 | 积分响度 LUFS | 短期最大 LUFS | 真峰 dBTP | 峰均比 dB |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const id of STEM_IDS) lines.push(row(STEM_LABELS[id], report.stemLevels[id]));
  lines.push(row('混音（含增益）', report.mixLevels), '');
  for (const device of report.devices) {
    const model = DEVICE_MODELS[device.deviceId];
    lines.push(`## ${model.label}`, '', `- 模型说明：${model.description}`);
    lines.push(
      `- 输出积分响度 ${device.outputLoudness.integratedLufs.toFixed(1)} dB，真峰 ${device.outputLoudness.truePeakDb.toFixed(1)} dB`,
    );
    if (device.events.length === 0) {
      lines.push('- 事件：未检测到超过阈值的掩蔽或削波时段。', '');
      continue;
    }
    lines.push(
      '',
      '| 类型 | 严重度 | 开始 s | 结束 s | 说明 |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const event of device.events) {
      lines.push(
        `| ${event.kind} | ${event.severity} | ${event.startSec.toFixed(2)} | ${event.endSec.toFixed(2)} | ${event.message} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
};

export const downloadText = (filename: string, content: string, mime: string): void => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};
