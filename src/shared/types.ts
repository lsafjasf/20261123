// Shared data structures used by the Node CLI/server and the browser UI.

export type StemId = 'dialogue' | 'music' | 'effects';

export type DeviceId =
  | 'monitor-headphones'
  | 'phone-speaker'
  | 'car-cabin'
  | 'laptop-speaker';

export interface StemGain {
  dialogue: number;
  music: number;
  effects: number;
}

// A decoded mono/stem or mix buffer with an explicit sample rate.
export interface AudioBufferData {
  sampleRate: number;
  // One Float32Array per channel; values are linear amplitude, not dB.
  channels: Float32Array[];
  label: string;
}

// A fixed-loudness band of a Bark-ish scale used by the heuristic model.
export interface AnalysisBand {
  index: number;
  lowHz: number;
  highHz: number;
  centerHz: number;
}

export type EventKind = 'masking' | 'clipping' | 'softclip';
export type Severity = 'info' | 'warning' | 'critical';

export interface AnalysisEvent {
  kind: EventKind;
  deviceId: DeviceId | 'pre-device';
  startSec: number;
  endSec: number;
  severity: Severity;
  // Human readable explanation of what the heuristic detected.
  message: string;
  // Numeric evidence (dB values, ratios...) attached for the report.
  evidence: Record<string, number>;
}

export interface LoudnessSummary {
  // BS.1770-4 style gated integrated loudness, dBFS/LUFS equivalent for
  // files with no absolute level reference.
  integratedLufs: number;
  // Highest 400 ms short-term loudness window.
  shortTermMaxLufs: number;
  truePeakDb: number;
  crestFactorDb: number;
}

export interface FrameMetric {
  // Frame center time in seconds.
  timeSec: number;
  // Per-stem band power in dB, indexed by AnalysisBand.index.
  stemBandDb: Record<StemId, number[]>;
  // Mix band power after gains, device response and cabin noise.
  mixBandDb: number[];
  // Dialogue audibility ratio 0..1 estimated by the simplified SII model.
  audibility: number;
  // Estimated masked fraction of the dialogue bands.
  maskedFraction: number;
  // True peak of the frame for the current rendered condition.
  truePeakDb: number;
  // Count of samples at/over the limiter threshold (soft clip indicator).
  limiterHits: number;
}

export interface DeviceAnalysis {
  deviceId: DeviceId;
  events: AnalysisEvent[];
  frames: FrameMetric[];
  outputLoudness: LoudnessSummary;
}

export interface AnalysisReport {
  generatedAt: string;
  modelNotice: string;
  durationSec: number;
  sampleRate: number;
  stemLevels: Record<StemId, LoudnessSummary>;
  mixLevels: LoudnessSummary;
  devices: DeviceAnalysis[];
  gainSettings: StemGain;
  // True only if the optional manual level-match was enabled.
  levelMatchApplied: boolean;
}

export const MODEL_NOTICE =
  '近似模型（heuristic approximation）：结果由本地 DSP 与经验模型估算，' +
  '不是真机测量，也不替代专业声学测量或母带质检。';
