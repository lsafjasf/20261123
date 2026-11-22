export type EventKind = "clean" | "emotional" | "impulse";
export type EditAction = "keep" | "restore" | "shorten" | "fade" | "attenuate";
export type MonitorMode = "source" | "processed";

export interface PcmAudio {
  sampleRate: number;
  length: number;
  channels: Float32Array[];
}

export interface FrameFeature {
  index: number;
  start: number;
  end: number;
  rmsDb: number;
  peakDb: number;
  zcr: number;
  centroidHz: number;
  flatness: number;
  lowRatio: number;
  voiceRatio: number;
  highRatio: number;
  crest: number;
  voiced: boolean;
  transient: boolean;
}

export interface RoomWindow {
  start: number;
  end: number;
  rmsDb: number;
  score: number;
}

export interface TimeSpan {
  start: number;
  end: number;
}

export interface EventEvidence {
  rmsDb: number;
  peakDb: number;
  noiseLikeness: number;
  lowBandRatio: number;
  distanceToSpeechMs: number;
  crest: number;
  durationMs: number;
  localFloorDb: number;
  seamRmsDb: number;
}

export interface BreathEvent {
  id: string;
  start: number;
  end: number;
  kind: EventKind;
  confidence: number;
  autoKind: EventKind;
  action: EditAction;
  autoAction: EditAction;
  manualKind: EventKind | null;
  note: string;
  evidence: EventEvidence;
  reasons: string[];
  roomWindowIndex: number;
}

export interface AnalysisConfig {
  frameSize: number;
  hopSize: number;
  policy: number;
  minEventMs: number;
  mergeGapMs: number;
}

export interface AnalysisResult {
  sampleRate: number;
  length: number;
  duration: number;
  channelCount: number;
  peakDb: number;
  noiseFloorDb: number;
  frames: FrameFeature[];
  events: BreathEvent[];
  speechSpans: TimeSpan[];
  roomWindows: RoomWindow[];
  analyzedAt: number;
  config: AnalysisConfig;
}

export interface MapSpan {
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  mode: "exact" | "edited" | "synthetic";
  eventId: string | null;
}

export interface SeamAudit {
  eventId: string;
  outputStart: number;
  outputEnd: number;
  lengthSamples: number;
  sourceStart: number;
  sourceEnd: number;
  noiseFloorDb: number;
  seamRmsDb: number;
  fadeSamples: number;
  faded: boolean;
}

export interface EventMap {
  eventId: string;
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  removedSamples: number;
}

export interface ProcessedAudio {
  pcm: PcmAudio;
  spans: MapSpan[];
  seams: SeamAudit[];
  eventMaps: EventMap[];
  eventsUsed: BreathEvent[];
  removedSamples: number;
  modifiedOutputSamples: number;
  exactSourceSamples: number;
  removedFrames: number;
  modifiedOutputFrames: number;
  exactSourceFrames: number;
  expectedDuration: number;
  shortenRatio: number;
}

export interface EditManifest {
  schema: "breath-gate-edit-manifest/v1";
  generator: string;
  createdAt: string;
  source: {
    name: string;
    sampleRate: number;
    channels: number;
    samplesPerChannel: number;
    durationSeconds: number;
  };
  output: {
    sampleRate: number;
    channels: number;
    samplesPerChannel: number;
    durationSeconds: number;
    peakDbfs: number;
    peakSample: number;
    sha256: string;
  };
  policy: {
    shortenRatio: number;
    seamMs: number;
    fadeMs: number;
    attenuationDb: number;
  };
  events: Array<{
    id: string;
    kind: EventKind;
    autoKind: EventKind;
    action: EditAction;
    manualKind: EventKind | null;
    sourceStartSample: number;
    sourceEndSample: number;
    outputStartSample: number;
    outputEndSample: number;
    removedSamples: number;
    note: string;
    evidence: EventEvidence;
  }>;
  seams: Array<{
    eventId: string;
    outputStartSample: number;
    outputEndSample: number;
    sourceStartSample: number;
    sourceEndSample: number;
    noiseFloorDb: number;
    seamRmsDb: number;
    fadeSamples: number;
  }>;
  exactSpans: Array<{
    sourceStartSample: number;
    sourceEndSample: number;
    outputStartSample: number;
    outputEndSample: number;
  }>;
  totals: {
    exactSourceSamples: number;
    modifiedOutputSamples: number;
    removedSamples: number;
    exactSourceFrames: number;
    modifiedOutputFrames: number;
    removedFrames: number;
    editCount: number;
    seamCount: number;
  };
}

export interface ExportVerification {
  duration: {
    pass: boolean;
    expected: number;
    actual: number;
    deltaSamples: number;
  };
  peak: {
    pass: boolean;
    expected: number;
    actual: number;
    dbfs: number;
    clippedSamples: number;
  };
  untouched: {
    pass: boolean;
    spans: number;
    samples: number;
    maxDifference: number;
  };
  webCodecs: {
    available: boolean;
    frames: number;
    peak: number;
    pass: boolean;
  };
  pass: boolean;
}

export const ACTION_LABELS: Record<EditAction, string> = {
  keep: "保留",
  restore: "恢复",
  shorten: "缩短",
  fade: "淡出",
  attenuate: "降低",
};

export const KIND_LABELS: Record<EventKind, string> = {
  clean: "可清理气口",
  emotional: "情绪呼吸",
  impulse: "低频冲激",
};
