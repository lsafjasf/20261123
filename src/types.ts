export interface SegmentDescriptor {
  id: string;
  title: string;
  file: string;
  fragmentedFile?: string;
  color: string;
  ordinal: number;
}

export interface FixtureManifest {
  title: string;
  codec: string;
  generated: string;
  segments: SegmentDescriptor[];
}

export interface EncodedPacket {
  index: number;
  offset: number;
  size: number;
  timestamp: number;
  duration: number;
}

export interface EditEntry {
  segmentDuration: number;
  mediaTime: number;
  mediaRate: number;
}

export interface Mp4AudioInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  description: Uint8Array;
  packets: EncodedPacket[];
  mediaTimescale: number;
  movieTimescale: number;
  mediaDuration: number;
  frameSamples: number;
  totalDecodedSamples: number;
  edit: EditEntry | null;
  editDurationSamples: number | null;
  mediaTimeSamples: number | null;
  originalSamples: number | null;
  primingSamples: number | null;
  paddingSamples: number | null;
  warnings: string[];
}

export interface PcmAudio {
  sampleRate: number;
  channels: Float32Array[];
  decodeMode: "webcodecs-raw" | "webaudio-trimmed";
}

export interface AnalysisEvidence {
  kind: "container" | "waveform" | "correlation" | "validation";
  label: string;
  detail: string;
}

export type Confirmation = "confirmed" | "unconfirmed";

export interface SegmentAnalysis {
  descriptor: SegmentDescriptor;
  status: Confirmation;
  confidence: number;
  codec: string;
  sampleRate: number;
  channelCount: number;
  decodedSamples: number;
  primingSamples: number | null;
  retainedSamples: number | null;
  paddingSamples: number | null;
  leadingAudioSamples: number | null;
  trailingAudioSamples: number | null;
  retainedStart: number | null;
  retainedEnd: number | null;
  reason: string;
  evidence: AnalysisEvidence[];
  pcm: PcmAudio;
  mp4: Mp4AudioInfo;
}

export interface SeamReport {
  index: number;
  leftId: string;
  rightId: string;
  atSample: number;
  atSeconds: number;
  leftLast: number;
  rightFirst: number;
  step: number;
  localStep: number;
  stepRatio: number;
  hfRatio: number;
  peak: number;
  status: "pass" | "review";
}

export interface Playlist {
  sampleRate: number;
  channelCount: number;
  segments: SegmentAnalysis[];
  unconfirmed: SegmentAnalysis[];
  totalSamples: number;
  totalSeconds: number;
  pcm: Float32Array[];
  seams: SeamReport[];
  continuityPass: boolean;
}

export interface SeekTrial {
  round: number;
  seamIndex: number;
  atSeconds: number;
  renderedAt: number;
  step: number;
  expectedStep: number;
  passed: boolean;
}
