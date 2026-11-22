/**
 * Shared domain types for the multi-track film delivery toolkit.
 * These types are imported by both the Node.js CLI (type-stripped at runtime)
 * and the browser application (served as source with type annotations removed).
 */

/** Logical role of a delivered audio track. */
export type TrackKind = 'dialogue-zh' | 'dialogue-en' | 'music' | 'unknown';

/** Human-facing labels keyed by track kind. */
export const TRACK_LABELS: Record<TrackKind, string> = {
  'dialogue-zh': '中文对白',
  'dialogue-en': 'English Dialogue',
  music: '音乐说明 / Music & Effects',
  unknown: '未识别 / Unknown',
};

/** A de-interleaved PCM buffer: one Float32Array per channel. */
export interface PcmBuffer {
  sampleRate: number;
  channels: Float32Array[];
}

/** Result of parsing a supported audio container. */
export interface DecodedTrack {
  fileName: string;
  kind: TrackKind;
  sampleRate: number;
  channelCount: number;
  /** Duration in seconds, derived from frame count / sample rate. */
  durationSec: number;
  pcm: PcmBuffer;
}

/** EBU R128 style loudness measurements. */
export interface LoudnessMeasurement {
  /** Integrated loudness in LUFS (gated, K-weighted). */
  integratedLufs: number;
  /** Loudness range in LU (short-term 10th/95th percentile spread). */
  loudnessRange: number;
  /** Sample peak in dBFS (4x oversampled). */
  truePeakDbfs: number;
  /** RMS in dBFS over the full program, for quick sanity comparison. */
  rmsDbfs: number;
}

/** Severity levels for an anomaly entry. */
export type Severity = 'error' | 'warning' | 'info';

/** A single quality-control finding. */
export interface Anomaly {
  code: string;
  severity: Severity;
  track: string;
  message: string;
  /** Optional location in seconds within the track. */
  atSec?: number;
  /** Optional machine-readable context values. */
  detail?: Record<string, number | string>;
}

/** One row of the delivery track matrix. */
export interface TrackMatrixRow {
  fileName: string;
  kind: TrackKind;
  label: string;
  channelCount: number;
  sampleRate: number;
  durationSec: number;
  integratedLufs: number;
  loudnessRange: number;
  truePeakDbfs: number;
  /** Tail silence length in seconds measured from the last non-silent frame. */
  tailSilenceSec: number;
  /** Head silence length in seconds before the first non-silent frame. */
  headSilenceSec: number;
  status: 'ok' | 'flagged';
}

/** Full analysis report emitted by the CLI and the browser. */
export interface AnalysisReport {
  generatedAt: string;
  referenceDurationSec: number | null;
  targetIntegratedLufs: number;
  matrix: TrackMatrixRow[];
  anomalies: Anomaly[];
  /** Pairwise loudness deltas in LU against the loudest reference track. */
  loudnessDeltas: { track: string; kind: TrackKind; deltaLu: number }[];
}

/** Tunable QC thresholds. Every value has a documented default. */
export interface QcThresholds {
  /** Allowed duration spread versus the longest track, in seconds. */
  durationToleranceSec: number;
  /** Integrated loudness target in LUFS (EBU R128 default -24). */
  targetIntegratedLufs: number;
  /** Allowed deviation from target integrated loudness, in LU. */
  loudnessToleranceLu: number;
  /** Maximum permitted loudness difference between tracks, in LU. */
  maxInterTrackDeltaLu: number;
  /** True peak ceiling in dBTP. */
  truePeakCeilingDbfs: number;
  /** Level below which a frame counts as silent, in dBFS. */
  silenceThresholdDbfs: number;
  /** Analysis window for silence scanning, in milliseconds. */
  silenceWindowMs: number;
  /** Tail silence longer than this is flagged (seconds). */
  maxTailSilenceSec: number;
  /** A tail shorter than this is flagged as a clipped "short tail" (seconds). */
  minTailSilenceSec: number;
}

export const DEFAULT_THRESHOLDS: QcThresholds = {
  durationToleranceSec: 1.0,
  targetIntegratedLufs: -24,
  loudnessToleranceLu: 2.0,
  maxInterTrackDeltaLu: 3.0,
  truePeakCeilingDbfs: -1.0,
  silenceThresholdDbfs: -50,
  silenceWindowMs: 40,
  maxTailSilenceSec: 2.0,
  minTailSilenceSec: 0.1,
};
