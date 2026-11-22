import type { AnalysisReport } from '../core/types.ts';

/** Escape a CSV cell following RFC 4180. */
function csvCell(value: string | number): string {
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** Render the track matrix as CSV text. */
export function matrixToCsv(report: AnalysisReport): string {
  const header = [
    'file', 'kind', 'label', 'channels', 'sampleRate', 'durationSec',
    'integratedLufs', 'loudnessRange', 'truePeakDbfs', 'headSilenceSec',
    'tailSilenceSec', 'status',
  ];
  const lines = [header.join(',')];
  for (const row of report.matrix) {
    lines.push([
      row.fileName, row.kind, row.label, row.channelCount, row.sampleRate,
      row.durationSec.toFixed(3), row.integratedLufs.toFixed(2),
      row.loudnessRange.toFixed(2), row.truePeakDbfs.toFixed(2),
      row.headSilenceSec.toFixed(3), row.tailSilenceSec.toFixed(3), row.status,
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/** Render the anomaly list as CSV text. */
export function anomaliesToCsv(report: AnalysisReport): string {
  const header = ['severity', 'code', 'track', 'atSec', 'message'];
  const lines = [header.join(',')];
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...report.anomalies].sort((a, b) => order[a.severity] - order[b.severity]);
  for (const item of sorted) {
    lines.push([
      item.severity, item.code, item.track, item.atSec?.toFixed(3) ?? '', item.message,
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/** Compact, deterministic JSON representation for machine export. */
export function reportToJson(report: AnalysisReport): string {
  return JSON.stringify(report, null, 2) + '\n';
}
