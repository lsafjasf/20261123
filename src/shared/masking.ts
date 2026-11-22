import { dbToGain, dbToPower, mulberry32, powerToDb } from './dsp-math.ts';
import {
  ANALYSIS_BANDS,
  ANALYSIS_CONFIG,
  type DeviceModel,
} from './devices.ts';
import { computeBandFrames, type StemFrameBands } from './spectral.ts';
import type { RenderedCondition } from './render-device.ts';
import type {
  AnalysisEvent,
  FrameMetric,
  Severity,
  StemGain,
  StemId,
} from './types.ts';

const STEM_IDS: StemId[] = ['dialogue', 'music', 'effects'];
const BAND_COUNT = ANALYSIS_BANDS.length;

const noiseFrameDb = (device: DeviceModel, frameIndex: number): number[] => {
  const random = mulberry32(0x9e3779b9 ^ (frameIndex * 2654435761));
  return device.noiseFloorDb.map((floor) => floor + (random() - 0.5) * 3);
};

const severityForAudibility = (audibility: number): Severity => {
  if (audibility <= ANALYSIS_CONFIG.audibilityCritical) return 'critical';
  if (audibility <= ANALYSIS_CONFIG.audibilityWarn) return 'warning';
  return 'info';
};

const stemRowDb = (
  frame: StemFrameBands,
  stem: StemId,
  gains: StemGain,
): number[] => {
  const powers = frame.stemBandPower[stem];
  if (!powers) return new Array(BAND_COUNT).fill(-120);
  return Array.from(powers).map((power) => powerToDb(power) + gains[stem]);
};

interface FrameFlags {
  metric: FrameMetric;
  masked: boolean;
  maskedSeverity: Severity;
  clipped: boolean;
  softClipped: boolean;
}

const buildFrameMetric = (
  frame: StemFrameBands,
  frameIndex: number,
  gains: StemGain,
  device: DeviceModel,
): Omit<FrameFlags, 'clipped' | 'softClipped'> => {
  const stemBandDb = {} as Record<StemId, number[]>;
  for (const stem of STEM_IDS) stemBandDb[stem] = stemRowDb(frame, stem, gains);

  const noiseDb = noiseFrameDb(device, frameIndex);
  const peakSpeechDb = Math.max(...stemBandDb.dialogue);
  const mixBandDb = new Array(BAND_COUNT).fill(-120);
  for (let band = 0; band < BAND_COUNT; band += 1) {
    let linearSum = dbToPower(noiseDb[band]);
    for (const stem of STEM_IDS) {
      linearSum += dbToPower(stemBandDb[stem][band] + device.bandResponseDb[band]);
    }
    mixBandDb[band] = powerToDb(linearSum);
  }

  // Simplified SII-style audibility evaluated only over bands that actually
  // contain dialogue. Empty speech bands are pauses/band gaps, not masking.
  let weightedAudible = 0;
  let weightedTotal = 0;
  let weightedMasked = 0;
  for (let band = 0; band < BAND_COUNT; band += 1) {
    const speechDb = stemBandDb.dialogue[band] + device.bandResponseDb[band];
    const noisePower = dbToPower(noiseDb[band]);
    const maskerPower =
      dbToPower(stemBandDb.music[band] + device.bandResponseDb[band]) +
      dbToPower(stemBandDb.effects[band] + device.bandResponseDb[band]) +
      noisePower;
    const maskerDb = powerToDb(maskerPower);
    if (speechDb <= noiseDb[band] + 25) continue;
    // Ignore weak harmonics more than 35 dB below the dialogue peak: they
    // carry negligible intelligibility and would overstate masking.
    if (speechDb < peakSpeechDb - 35) continue;
    const weight = band >= 3 && band <= 10 ? 1.6 : 0.6;
    weightedTotal += weight;
    if (speechDb > maskerDb + 3) {
      weightedAudible += weight;
    } else {
      // Under the 3 dB intelligibility margin: partially or fully masked.
      weightedMasked += weight;
    }
  }
  const audibility = weightedTotal === 0 ? 1 : weightedAudible / weightedTotal;
  const maskedFraction = weightedTotal === 0 ? 0 : weightedMasked / weightedTotal;
  const activeBandCount = Math.round(weightedTotal);
  // Voice activity gate: frames without audible dialogue are pauses and must
  // never be reported as masked dialogue.
  const speechActive = activeBandCount >= 2;
  const masked =
    speechActive &&
    audibility <= ANALYSIS_CONFIG.audibilityWarn &&
    maskedFraction >= 0.2;
  return {
    metric: {
      timeSec: frame.timeSec,
      stemBandDb,
      mixBandDb,
      audibility,
      maskedFraction,
      truePeakDb: -120,
      limiterHits: 0,
    },
    masked,
    maskedSeverity: severityForAudibility(audibility),
  };
};

interface RunFlag {
  active: boolean;
  severity: Severity;
  timeSec: number;
}

const summarizeRuns = (
  flags: RunFlag[],
  kind: AnalysisEvent['kind'],
  deviceId: DeviceModel['id'],
  message: (severity: Severity) => string,
  evidenceFor: (start: number, end: number) => Record<string, number>,
): AnalysisEvent[] => {
  const events: AnalysisEvent[] = [];
  let runStart = -1;
  let runSeverity: Severity = 'info';
  const flush = (endIndex: number): void => {
    if (runStart < 0) return;
    if (endIndex - runStart >= ANALYSIS_CONFIG.minEventFrames) {
      events.push({
        kind,
        deviceId,
        startSec: flags[runStart].timeSec,
        endSec:
          flags[endIndex - 1].timeSec + ANALYSIS_CONFIG.hopSec,
        severity: runSeverity,
        message: message(runSeverity),
        evidence: evidenceFor(runStart, endIndex),
      });
    }
    runStart = -1;
  };
  flags.forEach((flag, index) => {
    if (!flag.active) {
      flush(index);
      return;
    }
    if (runStart < 0) {
      runStart = index;
      runSeverity = flag.severity;
    } else if (
      flag.severity === 'critical' ||
      (flag.severity === 'warning' && runSeverity === 'info')
    ) {
      runSeverity = flag.severity;
    }
  });
  flush(flags.length);
  return events;
};

// Collects per-frame peak and limiter engagement from the rendered signal so
// clipping events align with the actual modelled output stage.
const collectClipStats = (
  condition: RenderedCondition,
  frames: FrameFlags[],
  device: DeviceModel,
): void => {
  const clipLevel = dbToGain(device.clipThresholdDb);
  const ceilingLevel = dbToGain(device.ceilingDb);
  const frameSamples = Math.max(
    1,
    Math.round(condition.sampleRate * ANALYSIS_CONFIG.hopSec),
  );
  frames.forEach((entry) => {
    const center = Math.round(entry.metric.timeSec * condition.sampleRate);
    const start = Math.max(0, center - Math.floor(frameSamples / 2));
    const end = Math.min(condition.rendered.length, start + frameSamples);
    let peak = 0;
    let limiterHits = 0;
    for (let i = start; i < end; i += 1) {
      const magnitude = Math.abs(condition.rendered[i]);
      if (magnitude > peak) peak = magnitude;
      if (magnitude >= ceilingLevel) limiterHits += 1;
    }
    entry.metric.truePeakDb = peak === 0 ? -120 : 20 * Math.log10(peak);
    entry.metric.limiterHits = limiterHits;
    entry.clipped = peak >= clipLevel;
    entry.softClipped =
      !entry.clipped && limiterHits >= frameSamples * 0.02;
  });
};

export interface MaskingResult {
  frames: FrameMetric[];
  events: AnalysisEvent[];
}

// Runs the full heuristic masking/clipping analysis for one device model.
export const analyzeDevice = (
  condition: RenderedCondition,
  gains: StemGain,
  device: DeviceModel,
): MaskingResult => {
  const bandFrames = computeBandFrames(
    condition.gainedStems,
    condition.sampleRate,
  );
  const frames: FrameFlags[] = bandFrames.map((frame, frameIndex) => ({
    ...buildFrameMetric(frame, frameIndex, gains, device),
    clipped: false,
    softClipped: false,
  }));
  collectClipStats(condition, frames, device);

  const maskingFlags: RunFlag[] = frames.map((entry) => ({
    active: entry.masked,
    severity: entry.maskedSeverity,
    timeSec: entry.metric.timeSec,
  }));
  const clipFlags: RunFlag[] = frames.map((entry) => ({
    active: entry.clipped,
    severity: 'critical',
    timeSec: entry.metric.timeSec,
  }));
  const softClipFlags: RunFlag[] = frames.map((entry) => ({
    active: entry.softClipped,
    severity: 'warning',
    timeSec: entry.metric.timeSec,
  }));

  const maskingEvents = summarizeRuns(
    maskingFlags,
    'masking',
    device.id,
    (severity) =>
      severity === 'critical'
        ? '对白被音乐/效果声或环境底噪严重掩蔽，预计可懂度明显下降'
        : '对白存在可闻掩蔽，建议降低音乐/效果声或提升对白频段',
    (start, end) => ({
      minAudibility: Math.min(
        ...frames.slice(start, end).map((entry) => entry.metric.audibility),
      ),
      maxMaskedFraction: Math.max(
        ...frames.slice(start, end).map((entry) => entry.metric.maskedFraction),
      ),
    }),
  );
  const clipEvents = summarizeRuns(
    clipFlags,
    'clipping',
    device.id,
    () => '输出达到该近似模型的硬削波阈值，存在可闻失真风险',
    (start, end) => ({
      peakDb: Math.max(
        ...frames.slice(start, end).map((entry) => entry.metric.truePeakDb),
      ),
      thresholdDb: device.clipThresholdDb,
    }),
  );
  const softClipEvents = summarizeRuns(
    softClipFlags,
    'softclip',
    device.id,
    () => '限幅器持续介入，动态被压缩，听感可能发“扁”',
    (start, end) => ({
      limiterHitRatio:
        frames.slice(start, end).reduce(
          (sum, entry) => sum + entry.metric.limiterHits,
          0,
        ) /
        Math.max(
          1,
          (end - start) *
            Math.round(condition.sampleRate * ANALYSIS_CONFIG.hopSec),
        ),
    }),
  );

  return {
    frames: frames.map((entry) => entry.metric),
    events: [...maskingEvents, ...clipEvents, ...softClipEvents].sort(
      (a, b) => a.startSec - b.startSec,
    ),
  };
};
