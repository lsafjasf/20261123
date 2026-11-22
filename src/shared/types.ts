export interface LoudnessSettings {
  target: number;
  tolerance: number;
  truePeakLimit: number;
  peakWarning: number;
  loudnessBurst: number;
  silenceThreshold: number;
}

export interface AdSegment {
  id: string;
  label: string;
  start: number;
  end: number;
}

export interface AudioMetadata {
  fileName: string;
  fileSize: number;
  format: string;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  duration: number;
  decoder: 'wav-stream' | 'webcodecs-adts';
  streaming: boolean;
}

export interface BlockMetric {
  start: number;
  end: number;
  momentary: number;
  shortTerm: number;
  integrated: number;
  energy: number;
  samplePeak: number;
  truePeak: number;
}

export interface SecondRow {
  index: number;
  start: number;
  end: number;
  momentary: number;
  momentaryMax: number;
  shortTerm: number;
  integrated: number;
  samplePeak: number;
  truePeak: number;
  adId: string | null;
  flags: ProblemKind[];
}

export interface SegmentStats {
  id: string;
  label: string;
  kind: 'program' | 'ad';
  start: number;
  end: number;
  duration: number;
  integrated: number;
  momentaryMax: number;
  shortTermMax: number;
  samplePeak: number;
  truePeak: number;
  gatedBlocks: number;
  deviation: number;
}

export type ProblemKind =
  | 'true-peak'
  | 'sample-peak'
  | 'loudness-burst'
  | 'silence'
  | 'program-offset'
  | 'ad-offset';

export interface ProblemInterval {
  id: string;
  kind: ProblemKind;
  label: string;
  start: number;
  end: number;
  duration: number;
  severity: 'critical' | 'warning' | 'info';
  detail: string;
  metric: number;
}

export interface WaveformEnvelope {
  bucketSeconds: number;
  min: number[];
  max: number[];
}

export interface AnalysisResult {
  metadata: AudioMetadata;
  settings: LoudnessSettings;
  seconds: SecondRow[];
  blocks: BlockMetric[];
  waveform: WaveformEnvelope;
  integrated: number;
  momentaryMax: number;
  shortTermMax: number;
  samplePeak: number;
  truePeak: number;
  gatedBlocks: number;
  ads: SegmentStats[];
  program: SegmentStats;
  intervals: ProblemInterval[];
  scannedAt: string;
  warnings: string[];
}

export interface AnalysisRequest {
  ads: AdSegment[];
  settings: LoudnessSettings;
}

export type WorkerRequest =
  | { type: 'start'; file: File; request: AnalysisRequest }
  | { type: 'set-ads'; ads: AdSegment[] }
  | { type: 'set-settings'; settings: LoudnessSettings }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' };

export type WorkerResponse =
  | { type: 'metadata'; metadata: AudioMetadata }
  | { type: 'progress'; ratio: number; seconds: number; elapsed: number; state: 'scanning' | 'paused' }
  | { type: 'result'; result: AnalysisResult }
  | { type: 'error'; message: string };

export const DEFAULT_SETTINGS: LoudnessSettings = {
  target: -14,
  tolerance: 1,
  truePeakLimit: -1,
  peakWarning: -3,
  loudnessBurst: 8,
  silenceThreshold: -60
};

export const PRESETS: Array<{ id: string; name: string; detail: string; settings: LoudnessSettings }> = [
  {
    id: 'streaming',
    name: '流媒体交付',
    detail: '-14 LUFS / -1 dBTP',
    settings: { ...DEFAULT_SETTINGS }
  },
  {
    id: 'podcast',
    name: '播客 / 口播',
    detail: '-16 LUFS / -1 dBTP',
    settings: { ...DEFAULT_SETTINGS, target: -16, tolerance: 1 }
  },
  {
    id: 'broadcast',
    name: '广播 EBU R128',
    detail: '-23 LUFS / -1 dBTP',
    settings: { ...DEFAULT_SETTINGS, target: -23, tolerance: 1 }
  }
];

export function formatLufs(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}

export function formatDb(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)}` : '—';
}

export function formatTime(seconds: number, withMillis = false): string {
  if (!Number.isFinite(seconds)) return '--:--';
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor((safe % 1) * 1000);
  const base = hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return withMillis ? `${base}.${String(millis).padStart(3, '0')}` : base;
}
