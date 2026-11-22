import { DEVICE_MODELS, STEM_LABELS } from '../shared/devices.ts';
import type { AnalysisReport, LoudnessSummary, StemId } from '../shared/types.ts';

const STEM_IDS: StemId[] = ['dialogue', 'music', 'effects'];

const fmtDb = (value: number): string =>
  Number.isFinite(value) ? `${value.toFixed(1)} dB` : '—';

const loudnessRow = (label: string, summary: LoudnessSummary): string =>
  `| ${label} | ${summary.integratedLufs.toFixed(1)} | ${summary.shortTermMaxLufs.toFixed(1)} | ${summary.truePeakDb.toFixed(1)} | ${summary.crestFactorDb.toFixed(1)} |`;

export const toMarkdown = (report: AnalysisReport): string => {
  const lines: string[] = [];
  lines.push('# 课程混音本地检查报告');
  lines.push('');
  lines.push(`> ${report.modelNotice}`);
  lines.push('');
  lines.push(
    `- 时长：${report.durationSec.toFixed(2)} s，采样率：${report.sampleRate} Hz`,
  );
  lines.push(
    `- 分轨增益（dB）：` +
      STEM_IDS.map((id) => `${STEM_LABELS[id]} ${report.gainSettings[id].toFixed(1)}`).join('，'),
  );
  lines.push(
    `- 响度对齐：${report.levelMatchApplied ? '已启用（仅监听对比，不改变掩蔽判定口径）' : '关闭（默认，不强制统一响度）'}`,
  );
  lines.push('');
  lines.push('## 响度与峰值');
  lines.push('');
  lines.push('| 对象 | 积分响度 LUFS | 短期最大 LUFS | 真峰 dBTP | 峰均比 dB |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const id of STEM_IDS) lines.push(loudnessRow(STEM_LABELS[id], report.stemLevels[id]));
  lines.push(loudnessRow('混音（含增益）', report.mixLevels));
  lines.push('');
  for (const device of report.devices) {
    const model = DEVICE_MODELS[device.deviceId];
    lines.push(`## ${model.label}`);
    lines.push('');
    lines.push(`- 模型说明：${model.description}`);
    lines.push(
      `- 输出积分响度 ${fmtDb(device.outputLoudness.integratedLufs)}，真峰 ${fmtDb(device.outputLoudness.truePeakDb)}`,
    );
    if (device.events.length === 0) {
      lines.push('- 事件：未检测到超过阈值的掩蔽或削波时段。');
      lines.push('');
      continue;
    }
    lines.push('');
    lines.push('| 类型 | 严重度 | 开始 s | 结束 s | 时长 s | 依据 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const event of device.events) {
      const evidence = Object.entries(event.evidence)
        .map(([key, value]) => `${key}=${value.toFixed(3)}`)
        .join(', ');
      lines.push(
        `| ${event.kind} | ${event.severity} | ${event.startSec.toFixed(2)} | ${event.endSec.toFixed(2)} | ${(event.endSec - event.startSec).toFixed(2)} | ${event.message}（${evidence}） |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
};
