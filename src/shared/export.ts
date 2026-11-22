import type { AnalysisResult } from './types.ts';

export function reviewPackage(result: AnalysisResult): Record<string, unknown> {
  return {
    app: 'Loudness Desk',
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    scannedAt: result.scannedAt,
    metadata: result.metadata,
    settings: result.settings,
    summary: {
      integrated: result.integrated,
      momentaryMax: result.momentaryMax,
      shortTermMax: result.shortTermMax,
      samplePeak: result.samplePeak,
      truePeak: result.truePeak,
      gatedBlocks: result.gatedBlocks
    },
    program: result.program,
    ads: result.ads,
    intervals: result.intervals,
    seconds: result.seconds
  };
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function secondsCsv(result: AnalysisResult): string {
  const header = [
    'second', 'start_s', 'end_s', 'momentary_avg_lufs', 'momentary_max_lufs', 'short_term_lufs',
    'integrated_lufs', 'sample_peak_dbfs', 'true_peak_dbtp', 'segment', 'segment_id', 'flags'
  ];
  const lines = [header.join(',')];
  const number = (value: number): string => Number.isFinite(value) ? value.toFixed(3) : '';
  for (const row of result.seconds) {
    const ad = result.ads.find((item) => item.id === row.adId);
    lines.push([
      row.index + 1,
      row.start.toFixed(3),
      row.end.toFixed(3),
      number(row.momentary),
      number(row.momentaryMax),
      number(row.shortTerm),
      number(row.integrated),
      number(row.samplePeak),
      number(row.truePeak),
      ad ? ad.label : 'program',
      row.adId || '',
      row.flags.join('|')
    ].map(csvCell).join(','));
  }
  return `\uFEFF${lines.join('\n')}`;
}

export function safeBaseName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .slice(0, 64) || 'loudness';
}
