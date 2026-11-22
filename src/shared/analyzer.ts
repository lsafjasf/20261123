import { LoudnessMeter, amplitudeToDb, energyToLufs, integratedFromBlocks } from './loudness.ts';
import type {
  AdSegment,
  AnalysisResult,
  AudioMetadata,
  BlockMetric,
  LoudnessSettings,
  ProblemInterval,
  ProblemKind,
  SecondRow,
  SegmentStats,
  WaveformEnvelope
} from './types.ts';

const WAVEFORM_BUCKET_SECONDS = 0.05;

const PROBLEM_LABELS: Record<ProblemKind, string> = {
  'true-peak': '真峰值超限',
  'sample-peak': '采样峰偏高',
  'loudness-burst': '瞬时响度突发',
  silence: '静音段',
  'program-offset': '整段响度偏离',
  'ad-offset': '广告响度偏差'
};

function safeLoudness(value: number): number {
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function maxFinite(values: number[]): number {
  let result = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (Number.isFinite(value) && value > result) result = value;
  }
  return result;
}

function meanFinite(values: number[]): number {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    sum += value;
    count += 1;
  }
  return count > 0 ? sum / count : Number.NEGATIVE_INFINITY;
}

function center(block: BlockMetric): number {
  return (block.start + block.end) / 2;
}

function buildSegment(
  id: string,
  label: string,
  kind: 'program' | 'ad',
  start: number,
  end: number,
  blocks: BlockMetric[],
  settings: LoudnessSettings
): SegmentStats {
  const selected = blocks.filter((block) => {
    const middle = center(block);
    return middle >= start && middle < end;
  });
  const integrated = integratedFromBlocks(selected);
  const momentary = maxFinite(selected.map((block) => block.momentary));
  const shortTerm = maxFinite(selected.map((block) => block.shortTerm));
  let samplePeak = 0;
  let truePeak = 0;
  for (const block of selected) {
    if (block.samplePeak > samplePeak) samplePeak = block.samplePeak;
    if (block.truePeak > truePeak) truePeak = block.truePeak;
  }
  return {
    id,
    label,
    kind,
    start,
    end,
    duration: Math.max(0, end - start),
    integrated: integrated.loudness,
    momentaryMax: momentary,
    shortTermMax: shortTerm,
    samplePeak: amplitudeToDb(samplePeak),
    truePeak: amplitudeToDb(truePeak),
    gatedBlocks: integrated.gatedBlocks,
    deviation: integrated.loudness - settings.target
  };
}

function normalizeAds(ads: AdSegment[], duration: number): AdSegment[] {
  return ads
    .map((ad, index) => ({
      id: ad.id || `ad-${index + 1}`,
      label: ad.label.trim() || `广告 ${index + 1}`,
      start: Math.max(0, Math.min(duration, ad.start)),
      end: Math.max(0, Math.min(duration, ad.end))
    }))
    .filter((ad) => ad.end - ad.start >= 0.05)
    .sort((a, b) => a.start - b.start);
}

function blockInAds(block: BlockMetric, ads: AdSegment[]): string | null {
  const middle = center(block);
  for (const ad of ads) {
    if (middle >= ad.start && middle < ad.end) return ad.id;
  }
  return null;
}

function buildSeconds(
  metadata: AudioMetadata,
  blocks: BlockMetric[],
  ads: AdSegment[],
  settings: LoudnessSettings
): SecondRow[] {
  const rowCount = Math.max(1, Math.ceil(metadata.duration));
  const grouped: BlockMetric[][] = Array.from({ length: rowCount }, () => []);
  for (const block of blocks) {
    const index = Math.max(0, Math.min(rowCount - 1, Math.floor(block.end - 1e-7)));
    grouped[index].push(block);
  }
  const rows: SecondRow[] = [];
  let lastShortTerm = Number.NEGATIVE_INFINITY;
  let lastIntegrated = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < rowCount; index += 1) {
    const rowBlocks = grouped[index];
    const momentaryValues = rowBlocks.map((block) => block.momentary);
    const momentaryMax = maxFinite(momentaryValues);
    const momentary = meanFinite(momentaryValues);
    let shortTerm = maxFinite(rowBlocks.map((block) => block.shortTerm));
    if (!Number.isFinite(shortTerm)) shortTerm = lastShortTerm;
    else lastShortTerm = shortTerm;
    let integrated = maxFinite(rowBlocks.map((block) => block.integrated));
    if (!Number.isFinite(integrated)) integrated = lastIntegrated;
    else lastIntegrated = integrated;
    let samplePeak = 0;
    let truePeak = 0;
    for (const block of rowBlocks) {
      if (block.samplePeak > samplePeak) samplePeak = block.samplePeak;
      if (block.truePeak > truePeak) truePeak = block.truePeak;
    }
    const start = index;
    const end = Math.min(metadata.duration, index + 1);
    const ad = ads.find((item) => (start + end) / 2 >= item.start && (start + end) / 2 < item.end);
    const flags: ProblemKind[] = [];
    const sampleDb = amplitudeToDb(samplePeak);
    const trueDb = amplitudeToDb(truePeak);
    if (trueDb > settings.truePeakLimit) flags.push('true-peak');
    if (sampleDb > settings.peakWarning) flags.push('sample-peak');
    if (momentaryMax > settings.target + settings.loudnessBurst) flags.push('loudness-burst');
    if (momentaryMax < settings.silenceThreshold) flags.push('silence');
    rows.push({
      index,
      start,
      end,
      momentary: safeLoudness(momentary),
      momentaryMax: safeLoudness(momentaryMax),
      shortTerm: safeLoudness(shortTerm),
      integrated: safeLoudness(integrated),
      samplePeak: sampleDb,
      truePeak: trueDb,
      adId: ad ? ad.id : null,
      flags
    });
  }
  return rows;
}

function problemDetail(kind: ProblemKind, metric: number, settings: LoudnessSettings): string {
  switch (kind) {
    case 'true-peak':
      return `真峰值 ${metric.toFixed(1)} dBTP，高于交付上限 ${settings.truePeakLimit.toFixed(1)} dBTP`;
    case 'sample-peak':
      return `采样峰值 ${metric.toFixed(1)} dBFS，超过预警线 ${settings.peakWarning.toFixed(1)} dBFS`;
    case 'loudness-burst':
      return `瞬时响度达到 ${metric.toFixed(1)} LUFS，超过目标 ${settings.target.toFixed(1)} + ${settings.loudnessBurst.toFixed(1)} LU`;
    case 'silence':
      return `400 ms 瞬时响度低于 ${settings.silenceThreshold.toFixed(1)} LUFS`;
    case 'program-offset':
      return `节目整合响度偏离目标 ${metric >= 0 ? '+' : ''}${metric.toFixed(1)} LU，容差 ±${settings.tolerance.toFixed(1)} LU`;
    case 'ad-offset':
      return `广告段与节目段响度相差 ${metric >= 0 ? '+' : ''}${metric.toFixed(1)} LU，建议复核衔接`;
  }
}

function mergeFlaggedSeconds(
  kind: ProblemKind,
  seconds: SecondRow[],
  settings: LoudnessSettings
): ProblemInterval[] {
  const matches = seconds.filter((row) => row.flags.includes(kind));
  if (matches.length === 0) return [];
  const intervals: ProblemInterval[] = [];
  let first = matches[0];
  let previous = matches[0];
  const flush = (): void => {
    const start = first.start;
    const end = previous.end;
    let metric = 0;
    if (kind === 'true-peak') metric = maxFinite(matches.filter((row) => row.start >= start && row.end <= end).map((row) => row.truePeak));
    if (kind === 'sample-peak') metric = maxFinite(matches.filter((row) => row.start >= start && row.end <= end).map((row) => row.samplePeak));
    if (kind === 'loudness-burst') metric = maxFinite(matches.filter((row) => row.start >= start && row.end <= end).map((row) => row.momentaryMax));
    if (kind === 'silence') metric = maxFinite(matches.filter((row) => row.start >= start && row.end <= end).map((row) => row.momentaryMax));
    const severity: ProblemInterval['severity'] =
      kind === 'true-peak' ? 'critical' : kind === 'loudness-burst' && metric > settings.target + settings.loudnessBurst + 4 ? 'critical' : 'warning';
    intervals.push({
      id: `${kind}-${start}-${end}`,
      kind,
      label: PROBLEM_LABELS[kind],
      start,
      end,
      duration: end - start,
      severity,
      detail: problemDetail(kind, metric, settings),
      metric
    });
  };
  for (let index = 1; index < matches.length; index += 1) {
    const row = matches[index];
    if (row.index === previous.index + 1) {
      previous = row;
    } else {
      flush();
      first = row;
      previous = row;
    }
  }
  flush();
  return intervals;
}

function buildProblems(
  seconds: SecondRow[],
  program: SegmentStats,
  ads: SegmentStats[],
  settings: LoudnessSettings
): ProblemInterval[] {
  const intervals: ProblemInterval[] = [
    ...mergeFlaggedSeconds('true-peak', seconds, settings),
    ...mergeFlaggedSeconds('sample-peak', seconds, settings),
    ...mergeFlaggedSeconds('loudness-burst', seconds, settings),
    ...mergeFlaggedSeconds('silence', seconds, settings)
  ];
  const offset = program.integrated - settings.target;
  if (Number.isFinite(program.integrated) && Math.abs(offset) > settings.tolerance) {
    intervals.push({
      id: `program-offset-${program.start}-${program.end}`,
      kind: 'program-offset',
      label: PROBLEM_LABELS['program-offset'],
      start: 0,
      end: program.end,
      duration: program.duration,
      severity: Math.abs(offset) > settings.tolerance + 1.5 ? 'critical' : 'warning',
      detail: problemDetail('program-offset', offset, settings),
      metric: offset
    });
  }
  for (const ad of ads) {
    if (!Number.isFinite(ad.integrated) || !Number.isFinite(program.integrated)) continue;
    const delta = ad.integrated - program.integrated;
    if (Math.abs(delta) <= 1.5) continue;
    intervals.push({
      id: `ad-offset-${ad.id}`,
      kind: 'ad-offset',
      label: `${PROBLEM_LABELS['ad-offset']} · ${ad.label}`,
      start: ad.start,
      end: ad.end,
      duration: ad.duration,
      severity: Math.abs(delta) > 3 ? 'critical' : 'warning',
      detail: problemDetail('ad-offset', delta, settings),
      metric: delta
    });
  }
  const order: Record<ProblemInterval['severity'], number> = { critical: 0, warning: 1, info: 2 };
  return intervals.sort((a, b) => a.start - b.start || order[a.severity] - order[b.severity]);
}

export class StreamAnalyzer {
  private readonly meter: LoudnessMeter;
  private readonly sampleRate: number;
  private readonly bucketFrames: number;
  private readonly waveformMin: number[] = [];
  private readonly waveformMax: number[] = [];
  private bucketMin = Number.POSITIVE_INFINITY;
  private bucketMax = Number.NEGATIVE_INFINITY;
  private bucketFramesUsed = 0;
  private finalized = false;
  private lastMetadata: AudioMetadata | null = null;

  constructor(sampleRate: number, channels: number) {
    this.sampleRate = sampleRate;
    this.meter = new LoudnessMeter(sampleRate, channels);
    this.bucketFrames = Math.max(1, Math.round(sampleRate * WAVEFORM_BUCKET_SECONDS));
  }

  push(channels: Float32Array[], frameCount: number): void {
    for (let frame = 0; frame < frameCount; frame += 1) {
      let minimum = Number.POSITIVE_INFINITY;
      let maximum = Number.NEGATIVE_INFINITY;
      for (const channel of channels) {
        const sample = channel[frame] || 0;
        if (sample < minimum) minimum = sample;
        if (sample > maximum) maximum = sample;
      }
      if (minimum < this.bucketMin) this.bucketMin = minimum;
      if (maximum > this.bucketMax) this.bucketMax = maximum;
      this.bucketFramesUsed += 1;
      if (this.bucketFramesUsed >= this.bucketFrames) this.flushWaveformBucket();
    }
    this.meter.push(channels, frameCount);
  }

  finish(
    metadata: AudioMetadata,
    adsInput: AdSegment[],
    settings: LoudnessSettings,
    warnings: string[] = []
  ): AnalysisResult {
    if (!this.finalized) {
      if (this.bucketFramesUsed > 0) this.flushWaveformBucket();
      this.meter.finish();
      this.finalized = true;
    }
    this.lastMetadata = metadata;
    return this.build(metadata, adsInput, settings, warnings);
  }

  update(adsInput: AdSegment[], settings: LoudnessSettings, warnings: string[] = []): AnalysisResult | null {
    if (!this.finalized || !this.lastMetadata) return null;
    return this.build(this.lastMetadata, adsInput, settings, warnings);
  }

  private build(
    metadata: AudioMetadata,
    adsInput: AdSegment[],
    settings: LoudnessSettings,
    warnings: string[]
  ): AnalysisResult {
    const blocks = this.meter.blocks;
    const ads = normalizeAds(adsInput, metadata.duration);
    const seconds = buildSeconds(metadata, blocks, ads, settings);
    const allIntegrated = integratedFromBlocks(blocks);
    const programBlocks = blocks.filter((block) => !blockInAds(block, ads));
    const program = buildSegment('program', '节目（不含广告）', 'program', 0, metadata.duration, programBlocks, settings);
    const adStats = ads.map((ad) => buildSegment(ad.id, ad.label, 'ad', ad.start, ad.end, blocks, settings));
    const intervals = buildProblems(seconds, program, adStats, settings);
    const waveform: WaveformEnvelope = {
      bucketSeconds: WAVEFORM_BUCKET_SECONDS,
      min: this.waveformMin,
      max: this.waveformMax
    };
    return {
      metadata,
      settings: { ...settings },
      seconds,
      blocks,
      waveform,
      integrated: allIntegrated.loudness,
      momentaryMax: maxFinite(blocks.map((block) => block.momentary)),
      shortTermMax: maxFinite(blocks.map((block) => block.shortTerm)),
      samplePeak: amplitudeToDb(this.meter.samplePeakLinear),
      truePeak: amplitudeToDb(this.meter.truePeakLinear),
      gatedBlocks: allIntegrated.gatedBlocks,
      ads: adStats,
      program,
      intervals,
      scannedAt: new Date().toISOString(),
      warnings
    };
  }

  private flushWaveformBucket(): void {
    this.waveformMin.push(Number.isFinite(this.bucketMin) ? this.bucketMin : 0);
    this.waveformMax.push(Number.isFinite(this.bucketMax) ? this.bucketMax : 0);
    this.bucketMin = Number.POSITIVE_INFINITY;
    this.bucketMax = Number.NEGATIVE_INFINITY;
    this.bucketFramesUsed = 0;
  }
}

export function summarizeAtTime(result: AnalysisResult, time: number): { momentary: number; shortTerm: number; integrated: number } {
  if (result.blocks.length === 0 || !Number.isFinite(time)) {
    return { momentary: Number.NEGATIVE_INFINITY, shortTerm: Number.NEGATIVE_INFINITY, integrated: Number.NEGATIVE_INFINITY };
  }
  let low = 0;
  let high = result.blocks.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (result.blocks[middle].end <= time + 1e-7) low = middle;
    else high = middle - 1;
  }
  const block = result.blocks[low];
  const row = result.seconds[Math.max(0, Math.min(result.seconds.length - 1, Math.floor(time)))];
  return {
    momentary: block.momentary,
    shortTerm: block.shortTerm,
    integrated: row ? row.integrated : block.integrated
  };
}
