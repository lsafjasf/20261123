import {
  DEFAULT_LIMITS,
  emptySource,
  type ClientMetrics,
  type MediaSample,
  type RelayLimits,
  type RelayStats,
  type SourceSnapshot,
} from "./media.ts";
import { encodeMediaFrame, sourceWireState, WireFlags, WireKind } from "./wire.ts";

export interface RelayClient {
  readonly id: number;
  readonly remote: string;
  readonly connectedAt: number;
  push(frame: Buffer, media: boolean, keyframe: boolean): void;
  pushText(text: string): void;
  close(reason: string): void;
  metrics(now: number): ClientMetrics;
}

interface Gop {
  keyframePts: number;
  samples: MediaSample[];
  bytes: number;
}

export class GopCache {
  private gops: Gop[] = [];
  private current: Gop | null = null;
  private bytes = 0;
  private oversizeDrops = 0;
  private readonly maxBytes: number;
  private readonly maxGops: number;

  constructor(maxBytes: number, maxGops: number) {
    this.maxBytes = maxBytes;
    this.maxGops = maxGops;
  }

  reset(): void {
    this.gops = [];
    this.current = null;
    this.bytes = 0;
  }

  add(sample: MediaSample): boolean {
    if (sample.kind === "video" && sample.keyframe) {
      if (this.current) this.gops.push(this.current);
      this.current = { keyframePts: sample.ptsMs, samples: [], bytes: 0 };
    }
    if (!this.current) return false;
    this.current.samples.push(sample);
    this.current.bytes += sample.data.byteLength;
    this.bytes += sample.data.byteLength;
    this.trim();
    return this.current?.samples.includes(sample) ?? false;
  }

  snapshot(): { keyframePts: number; samples: MediaSample[] } | null {
    if (!this.current || this.current.samples.length === 0) return null;
    return {
      keyframePts: this.current.keyframePts,
      samples: this.current.samples.slice(),
    };
  }

  stats(): { gops: number; samples: number; bytes: number; oversizeDrops: number } {
    const all = this.current ? [...this.gops, this.current] : this.gops;
    return {
      gops: all.length,
      samples: all.reduce((sum, gop) => sum + gop.samples.length, 0),
      bytes: this.bytes,
      oversizeDrops: this.oversizeDrops,
    };
  }

  private trim(): void {
    while (
      (this.gops.length + (this.current ? 1 : 0) > this.maxGops || this.bytes > this.maxBytes) &&
      this.gops.length > 0
    ) {
      const removed = this.gops.shift();
      if (!removed) break;
      this.bytes -= removed.bytes;
    }
    if (this.current && this.current.bytes > this.maxBytes) {
      this.bytes -= this.current.bytes;
      this.current = null;
      this.oversizeDrops++;
    }
  }
}

export class RelayHub {
  readonly limits: RelayLimits;
  readonly source: SourceSnapshot;
  private readonly gopCache: GopCache;
  private readonly clients = new Map<number, RelayClient>();
  private nextClientId = 1;
  private ingressSamples = 0;
  private egressFrames = 0;
  private slowEvents = 0;
  private lastDiagAt = 0;
  private sourceCloseHandler: (() => void) | null = null;
  private sourceStaleAfterMs = 5000;
  private lastPts = new Map<"video" | "audio", number>();

  constructor(limits: Partial<RelayLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.source = emptySource();
    this.gopCache = new GopCache(this.limits.gopCacheBytes, this.limits.gopCacheCount);
  }

  beginSource(protocol: string, closeHandler: () => void): number {
    const previousClose = this.sourceCloseHandler;
    if (this.source.generation > 0) this.source.reconnectCount++;
    this.source.generation++;
    this.source.state = "online";
    this.source.protocol = protocol;
    this.source.since = Date.now();
    this.source.lastSeenAt = Date.now();
    this.source.video = null;
    this.source.audio = null;
    this.lastPts.clear();
    this.sourceCloseHandler = closeHandler;
    this.gopCache.reset();
    this.broadcastText({
      type: "source",
      ...sourceWireState(this.source),
    });
    if (previousClose) queueMicrotask(previousClose);
    return this.source.generation;
  }

  endSource(generation: number, reason: string): void {
    if (generation !== this.source.generation) return;
    if (this.source.state === "offline") return;
    this.source.state = "offline";
    this.source.since = Date.now();
    this.sourceCloseHandler = null;
    this.broadcastText({
      type: "source",
      reason,
      ...sourceWireState(this.source),
    });
  }

  setVideoConfig(track: NonNullable<SourceSnapshot["video"]>): void {
    const previous = this.source.video;
    if (
      previous &&
      previous.codec === track.codec &&
      previous.width === track.width &&
      previous.height === track.height &&
      previous.description.equals(track.description)
    ) {
      return;
    }
    this.source.video = track;
    this.source.lastSeenAt = Date.now();
    this.broadcastText({
      type: "track-config",
      video: { codec: track.codec, width: track.width, height: track.height },
    });
    this.broadcastBinary(
      encodeMediaFrame(
        WireKind.VideoConfig,
        { ptsMs: 0, durationMs: 0 },
        track.description,
        WireFlags.Replay,
        0,
      ),
      false,
      true,
    );
  }

  setAudioConfig(track: NonNullable<SourceSnapshot["audio"]>): void {
    const previous = this.source.audio;
    if (
      previous &&
      previous.codec === track.codec &&
      previous.sampleRate === track.sampleRate &&
      previous.channels === track.channels &&
      previous.description.equals(track.description)
    ) {
      return;
    }
    this.source.audio = track;
    this.source.lastSeenAt = Date.now();
    this.broadcastText({
      type: "track-config",
      audio: {
        codec: track.codec,
        sampleRate: track.sampleRate,
        channels: track.channels,
      },
    });
    this.broadcastBinary(
      encodeMediaFrame(
        WireKind.AudioConfig,
        { ptsMs: 0, durationMs: 0 },
        track.description,
        WireFlags.Replay,
        0,
      ),
      false,
      true,
    );
  }

  ingest(sample: MediaSample): void {
    if (this.source.state !== "online") return;
    if (sample.data.byteLength > this.limits.maxFrameBytes) return;
    const previousPts = this.lastPts.get(sample.kind);
    if (previousPts !== undefined) {
      const delta = sample.ptsMs - previousPts;
      if (delta > 0 && delta < 2000) sample.durationMs = delta;
    }
    this.lastPts.set(sample.kind, sample.ptsMs);
    this.source.lastSeenAt = Date.now();
    this.ingressSamples++;
    this.gopCache.add(sample);
    const kind = sample.kind === "video" ? WireKind.VideoSample : WireKind.AudioSample;
    let flags = sample.keyframe ? WireFlags.Keyframe : 0;
    if (sample.kind === "video" && sample.keyframe) flags |= WireFlags.GopStart;
    const frame = encodeMediaFrame(kind, sample, sample.data, flags, this.ingressSamples);
    this.broadcastBinary(frame, true, sample.keyframe);
  }

  attachClient(client: RelayClient): boolean {
    if (this.clients.size >= this.limits.maxClients) {
      client.close("server-full");
      return false;
    }
    this.clients.set(client.id, client);
    try {
      client.pushText(
        JSON.stringify({
          type: "hello",
          clientId: client.id,
          limits: {
            clientQueueBytes: this.limits.clientQueueBytes,
            gopCacheBytes: this.limits.gopCacheBytes,
          },
          source: sourceWireState(this.source),
        }),
      );
      this.sendSnapshot(client, false);
      this.sendDiagnostics(client);
    } catch {
      this.clients.delete(client.id);
      client.close("write-error");
      return false;
    }
    return true;
  }

  detachClient(id: number): void {
    this.clients.delete(id);
  }

  nextId(): number {
    return this.nextClientId++;
  }

  replay(client: RelayClient): void {
    if (!this.clients.has(client.id)) return;
    this.sendSnapshot(client, true);
  }

  noteSlowEvent(): void {
    this.slowEvents++;
  }

  getSource(): SourceSnapshot {
    return { ...this.source };
  }

  isCurrentSource(generation: number): boolean {
    return this.source.generation === generation;
  }

  checkSourceAlive(now = Date.now()): void {
    if (this.source.state !== "online") return;
    if (now - this.source.lastSeenAt <= this.sourceStaleAfterMs) return;
    this.source.state = "offline";
    this.source.since = now;
    const handler = this.sourceCloseHandler;
    this.sourceCloseHandler = null;
    this.broadcastText({
      type: "source",
      reason: "source-timeout",
      ...sourceWireState(this.source),
    });
    handler?.();
  }

  tick(now = Date.now()): void {
    this.checkSourceAlive(now);
    if (now - this.lastDiagAt < 900) return;
    this.lastDiagAt = now;
    for (const client of this.clients.values()) this.sendDiagnostics(client);
  }

  stats(): RelayStats {
    const cache = this.gopCache.stats();
    return {
      source: this.getSource(),
      cache: {
        gops: cache.gops,
        samples: cache.samples,
        bytes: cache.bytes,
        limitBytes: this.limits.gopCacheBytes,
        limitGops: this.limits.gopCacheCount,
        oversizeDrops: cache.oversizeDrops,
      },
      clients: [...this.clients.values()].map((client) => client.metrics(Date.now())),
      totals: {
        ingressSamples: this.ingressSamples,
        egressFrames: this.egressFrames,
        slowEvents: this.slowEvents,
        sourceReconnects: this.source.reconnectCount,
      },
    };
  }

  private sendSnapshot(client: RelayClient, replay: boolean): void {
    const replayFlag = replay ? WireFlags.Replay : 0;
    if (this.source.video) {
      client.push(
        encodeMediaFrame(
          WireKind.VideoConfig,
          { ptsMs: 0, durationMs: 0 },
          this.source.video.description,
          WireFlags.Replay,
          0,
        ),
        false,
        true,
      );
    }
    if (this.source.audio) {
      client.push(
        encodeMediaFrame(
          WireKind.AudioConfig,
          { ptsMs: 0, durationMs: 0 },
          this.source.audio.description,
          WireFlags.Replay,
          0,
        ),
        false,
        true,
      );
    }
    const gop = this.gopCache.snapshot();
    if (!gop) return;
    for (const sample of gop.samples) {
      let flags = replayFlag | (sample.keyframe ? WireFlags.Keyframe : 0);
      if (sample.kind === "video" && sample.keyframe) flags |= WireFlags.GopStart;
      client.push(
        encodeMediaFrame(
          sample.kind === "video" ? WireKind.VideoSample : WireKind.AudioSample,
          sample,
          sample.data,
          flags,
          this.ingressSamples,
        ),
        true,
        sample.keyframe,
      );
    }
  }

  private sendDiagnostics(client: RelayClient): void {
    const stats = this.stats();
    client.pushText(JSON.stringify({ type: "diag", ...stats, self: client.metrics(Date.now()) }));
  }

  private broadcastBinary(frame: Buffer, media: boolean, keyframe: boolean): void {
    this.egressFrames++;
    for (const client of this.clients.values()) {
      try {
        client.push(frame, media, keyframe);
      } catch {
        this.clients.delete(client.id);
        client.close("write-error");
      }
    }
  }

  private broadcastText(value: Record<string, unknown>): void {
    const text = JSON.stringify(value);
    for (const client of this.clients.values()) {
      try {
        client.pushText(text);
      } catch {
        this.clients.delete(client.id);
        client.close("write-error");
      }
    }
  }
}
