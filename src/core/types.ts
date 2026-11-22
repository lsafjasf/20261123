export interface AudioPacket {
  sequence: number;
  sampleRate: number;
  channels: Float32Array[];
  timestampUs?: number;
  origin?: "received" | "concealed";
}

export interface ConcealmentOptions {
  maxConcealMs: number;
  edgeBlendMs: number;
  pauseRms: number;
  activeRms: number;
  boundaryCorrelation: number;
  minPeriodHz: number;
  maxPeriodHz: number;
  analysisMs: number;
  silentChannelDb: number;
}

export type GapClassification =
  | "true-pause"
  | "speech-loss"
  | "music-boundary"
  | "onset-boundary"
  | "offset-boundary"
  | "rate-boundary"
  | "unrepairable";

export type FillMethod =
  | "silence"
  | "pitch-continuation"
  | "equal-power-crossfade"
  | "edge-fade"
  | "none";

export interface GapAnalysis {
  preRms: number;
  postRms: number;
  correlation: number;
  periodSamples: number;
  periodRatio: number;
  zeroCrossingRatio: number;
  levelDeltaDb: number;
  preActive: boolean;
  postActive: boolean;
}

export interface TransitionPlan {
  leadFrames: number;
  tailFrames: number;
  synthesizedFrames: number;
  mutedFrames: number;
  curve: "linear" | "equal-power";
}

export interface ChannelDiagnostic {
  channel: number;
  status: "ok" | "copied" | "rebuilt" | "muted";
  sourceChannel?: number;
  invalidSamples?: number;
}

export interface ConcealmentInterval {
  id: string;
  startSequence: number;
  endSequence: number;
  missingPackets: number;
  outputSequence: number;
  sampleRate: number;
  frames: number;
  startTimeSec: number;
  endTimeSec: number;
  classification: GapClassification;
  method: FillMethod;
  analysis: GapAnalysis;
  transitions: TransitionPlan;
  channels: ChannelDiagnostic[];
  corruptPackets: number;
  sampleRateChange: boolean;
  stateBefore: AlgorithmState;
  stateAfter: AlgorithmState;
}

export interface AlgorithmState {
  revision: number;
  status: "idle" | "tracking" | "concealing" | "resyncing" | "complete";
  lastSequence: number | null;
  lastSampleRate: number | null;
  lastPacketFrames: number | null;
  packetsAccepted: number;
  packetsRejected: number;
  packetsConcealed: number;
  gapsRepaired: number;
  framesEmitted: number;
  framesConcealed: number;
  framesMuted: number;
  corruptChannelsRepaired: number;
  rateTransitions: number;
  lastClassification: GapClassification | null;
  lastMethod: FillMethod | null;
  lastEvent: string;
}

export interface RepairEvent {
  atSec: number;
  kind:
    | "packet"
    | "gap-repaired"
    | "rate-change"
    | "channel-repaired"
    | "corrupt-packet"
    | "resync"
    | "complete";
  sequence: number | null;
  message: string;
  state: AlgorithmState;
}

export interface RepairStats {
  inputPackets: number;
  outputPackets: number;
  acceptedPackets: number;
  rejectedPackets: number;
  gaps: number;
  consecutiveLossGaps: number;
  missingPackets: number;
  repairedFrames: number;
  mutedFrames: number;
  rateTransitions: number;
  corruptChannels: number;
  durationSec: number;
}

export interface RepairReport {
  packets: AudioPacket[];
  intervals: ConcealmentInterval[];
  events: RepairEvent[];
  state: AlgorithmState;
  stats: RepairStats;
}
