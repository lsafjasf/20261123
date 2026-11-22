export interface AnalysisSettings {
  minRepeatSec: number;
  minGapSec: number;
  transposeSemitones: number;
  similarityThreshold: number;
}

export interface PitchFrame {
  time: number;
  midi: number | null;
  confidence: number;
  rms: number;
  flatness: number;
  voiced: boolean;
}

export interface AudioFeatures {
  durationSec: number;
  sampleRate: number;
  hopSec: number;
  frameCount: number;
  midi: Float32Array;
  confidence: Float32Array;
  rms: Float32Array;
  flatness: Float32Array;
  voiced: Uint8Array;
  stats: {
    voicedSec: number;
    silentSec: number;
    noisySec: number;
    rejectedRegions: number;
  };
}

export interface MatchOccurrence {
  start: number;
  end: number;
  score: number;
  shift: number;
}

export type MatchStatus = "pending" | "confirmed" | "rejected";

export interface MatchGroup {
  id: string;
  score: number;
  occurrences: MatchOccurrence[];
  status: MatchStatus;
  note: string;
}

export interface AnalysisResult {
  groups: MatchGroup[];
  scannedSec: number;
  rejectedSec: number;
  analyzedAt: number;
}

export interface AnalyzeRequest {
  type: "analyze";
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  settings: AnalysisSettings;
}

export interface AnalyzeProgress {
  type: "progress";
  phase: "features" | "matching";
  value: number;
  detail: string;
}

export interface AnalyzeComplete {
  type: "complete";
  features: AudioFeatures;
  result: AnalysisResult;
}

export interface AnalyzeFailure {
  type: "error";
  message: string;
}

export type WorkerReply = AnalyzeProgress | AnalyzeComplete | AnalyzeFailure;
export type AnalyzeResponse = AnalyzeComplete | AnalyzeFailure;

export interface PlaylistEntry {
  group: number;
  take: number;
  start: number;
  end: number;
  score: number;
}
