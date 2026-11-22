export type TrackKind = "video" | "audio";

export interface VideoTrackInfo {
  codec: string;
  width: number;
  height: number;
  description: Buffer;
}

export interface AudioTrackInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  description: Buffer;
}

export interface MediaSample {
  kind: TrackKind;
  ptsMs: number;
  durationMs: number;
  keyframe: boolean;
  data: Buffer;
}

export interface SourceSnapshot {
  generation: number;
  state: "online" | "offline";
  since: number;
  protocol: string;
  lastSeenAt: number;
  video: VideoTrackInfo | null;
  audio: AudioTrackInfo | null;
  reconnectCount: number;
}

export interface RelayLimits {
  gopCacheBytes: number;
  gopCacheCount: number;
  clientQueueBytes: number;
  maxFrameBytes: number;
  maxClients: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  gopCacheBytes: 24 * 1024 * 1024,
  gopCacheCount: 3,
  clientQueueBytes: 8 * 1024 * 1024,
  maxFrameBytes: 4 * 1024 * 1024,
  maxClients: 128,
};

export interface ClientMetrics {
  id: number;
  remote: string;
  connectedAt: number;
  state: "joining" | "live" | "slow" | "closed";
  queuedBytes: number;
  droppedBytes: number;
  skippedFrames: number;
  sentBytes: number;
  lastAckAt: number;
  reportedQueueMs: number;
}

export interface RelayStats {
  source: SourceSnapshot;
  cache: {
    gops: number;
    samples: number;
    bytes: number;
    limitBytes: number;
    limitGops: number;
    oversizeDrops: number;
  };
  clients: ClientMetrics[];
  totals: {
    ingressSamples: number;
    egressFrames: number;
    slowEvents: number;
    sourceReconnects: number;
  };
}

export function emptySource(generation = 0): SourceSnapshot {
  return {
    generation,
    state: "offline",
    since: 0,
    protocol: "none",
    lastSeenAt: 0,
    video: null,
    audio: null,
    reconnectCount: 0,
  };
}
