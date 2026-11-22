export type TrackKind = "video" | "audio";
export type FrameKind = "key" | "delta";

export interface FrameInput {
  type: FrameKind;
  timestampUs: number;
  durationUs?: number | null;
  data: Uint8Array;
}

export interface StoredFrame {
  track: TrackKind;
  type: FrameKind;
  timestampUs: number;
  durationUs: number;
  data: Uint8Array;
}

export interface ReplayFrame {
  track: TrackKind;
  type: FrameKind;
  timestampUs: number;
  durationUs: number;
  data: Uint8Array;
}

export interface ReplaySnapshot {
  revision: number;
  capturedAt: number;
  anchorKeyframeUs: number;
  sourceStartUs: number;
  sourceEndUs: number;
  durationUs: number;
  durationMs: number;
  bytes: number;
  videoFrames: ReplayFrame[];
  audioFrames: ReplayFrame[];
  keyframeOrdinal: number;
}

export interface BufferStats {
  revision: number;
  durationUs: number;
  durationMs: number;
  oldestUs: number;
  latestUs: number;
  totalBytes: number;
  videoBytes: number;
  audioBytes: number;
  gopCount: number;
  keyframeOrdinal: number;
  videoFrameCount: number;
  audioFrameCount: number;
  budgetBytes: number;
  overBudget: boolean;
  droppedGops: number;
  discardedFrames: number;
}

export interface RingBufferOptions {
  maxDurationUs?: number;
  maxBytes?: number;
  defaultVideoFrameUs?: number;
  defaultAudioFrameUs?: number;
}

interface Gop {
  startUs: number;
  endUs: number;
  bytes: number;
  keyframeOrdinal: number;
  frames: StoredFrame[];
}

const VIDEO_DEFAULT_US = 33_333;
const AUDIO_DEFAULT_US = 20_000;

function assertTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite, non-negative number (received ${String(value)})`);
  }
}

function normalizeBytes(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export class KeyframeRingBuffer {
  readonly maxDurationUs: number;
  readonly maxBytes: number;
  readonly defaultVideoFrameUs: number;
  readonly defaultAudioFrameUs: number;

  private gops: Gop[] = [];
  private audio: StoredFrame[] = [];
  private revision = 0;
  private totalBytes = 0;
  private videoBytes = 0;
  private audioBytes = 0;
  private droppedGops = 0;
  private discardedFrames = 0;
  private keyframeOrdinal = 0;
  private lastVideoUs = -1;
  private lastAudioUs = -1;

  constructor(options: RingBufferOptions = {}) {
    this.maxDurationUs = normalizeBytes(options.maxDurationUs ?? 90_000_000, 90_000_000);
    this.maxBytes = normalizeBytes(options.maxBytes ?? 256 * 1024 * 1024, 256 * 1024 * 1024);
    this.defaultVideoFrameUs = normalizeBytes(options.defaultVideoFrameUs ?? VIDEO_DEFAULT_US, VIDEO_DEFAULT_US);
    this.defaultAudioFrameUs = normalizeBytes(options.defaultAudioFrameUs ?? AUDIO_DEFAULT_US, AUDIO_DEFAULT_US);
  }

  appendVideo(input: FrameInput): boolean {
    assertTimestamp(input.timestampUs, "video.timestampUs");
    const durationUs = normalizeBytes(input.durationUs ?? this.defaultVideoFrameUs, this.defaultVideoFrameUs);
    if (input.timestampUs <= this.lastVideoUs) {
      this.discardedFrames += 1;
      return false;
    }

    const frame: StoredFrame = {
      track: "video",
      type: input.type,
      timestampUs: input.timestampUs,
      durationUs,
      data: input.data,
    };

    if (input.type === "key") {
      this.keyframeOrdinal += 1;
      const gop: Gop = {
        startUs: input.timestampUs,
        endUs: input.timestampUs + durationUs,
        bytes: input.data.byteLength,
        keyframeOrdinal: this.keyframeOrdinal,
        frames: [frame],
      };
      this.gops.push(gop);
      this.videoBytes += input.data.byteLength;
      this.totalBytes += input.data.byteLength;
    } else {
      const active = this.gops.at(-1);
      if (!active) {
        this.discardedFrames += 1;
        return false;
      }
      active.frames.push(frame);
      active.endUs = input.timestampUs + durationUs;
      active.bytes += input.data.byteLength;
      this.videoBytes += input.data.byteLength;
      this.totalBytes += input.data.byteLength;
    }

    this.lastVideoUs = input.timestampUs;
    this.trimDuration();
    this.trimBytes();
    this.trimAudio();
    this.revision += 1;
    return true;
  }

  appendAudio(input: FrameInput): boolean {
    assertTimestamp(input.timestampUs, "audio.timestampUs");
    if (!this.gops.length || input.timestampUs <= this.lastAudioUs) {
      this.discardedFrames += 1;
      return false;
    }
    const durationUs = normalizeBytes(input.durationUs ?? this.defaultAudioFrameUs, this.defaultAudioFrameUs);
    const frame: StoredFrame = {
      track: "audio",
      type: input.type,
      timestampUs: input.timestampUs,
      durationUs,
      data: input.data,
    };
    this.audio.push(frame);
    this.audioBytes += input.data.byteLength;
    this.totalBytes += input.data.byteLength;
    this.lastAudioUs = input.timestampUs;
    this.trimAudio();
    this.revision += 1;
    return true;
  }

  snapshot(targetDurationUs = this.maxDurationUs): ReplaySnapshot | null {
    if (!this.gops.length) {
      return null;
    }
    const target = normalizeBytes(targetDurationUs, this.maxDurationUs);
    const latestEndUs = this.gops.at(-1)!.endUs;
    const cutoffUs = Math.max(0, latestEndUs - target);
    let anchorIndex = 0;

    for (let index = 0; index < this.gops.length; index += 1) {
      if (this.gops[index].startUs <= cutoffUs) {
        anchorIndex = index;
      } else {
        break;
      }
    }

    const anchor = this.gops[anchorIndex];
    const anchorUs = anchor.startUs;
    const videoFrames: ReplayFrame[] = [];
    let bytes = 0;

    for (const gop of this.gops.slice(anchorIndex)) {
      for (const frame of gop.frames) {
        const data = frame.data.slice();
        bytes += data.byteLength;
        videoFrames.push({
          track: "video",
          type: frame.type,
          timestampUs: frame.timestampUs - anchorUs,
          durationUs: frame.durationUs,
          data,
        });
      }
    }

    if (videoFrames[0]?.type !== "key") {
      throw new Error("Replay invariant failed: snapshot does not begin on a keyframe");
    }

    const audioFrames: ReplayFrame[] = [];
    const endUs = this.gops.at(-1)!.endUs;
    for (const frame of this.audio) {
      if (frame.timestampUs < anchorUs || frame.timestampUs > endUs) {
        continue;
      }
      const data = frame.data.slice();
      bytes += data.byteLength;
      audioFrames.push({
        track: "audio",
        type: frame.type,
        timestampUs: Math.max(0, frame.timestampUs - anchorUs),
        durationUs: frame.durationUs,
        data,
      });
    }

    return {
      revision: this.revision,
      capturedAt: Date.now(),
      anchorKeyframeUs: anchorUs,
      sourceStartUs: anchorUs,
      sourceEndUs: endUs,
      durationUs: endUs - anchorUs,
      durationMs: Math.max(0, Math.round((endUs - anchorUs) / 1000)),
      bytes,
      videoFrames,
      audioFrames,
      keyframeOrdinal: anchor.keyframeOrdinal,
    };
  }

  stats(): BufferStats {
    const oldestUs = this.gops[0]?.startUs ?? 0;
    const latestUs = this.gops.at(-1)?.endUs ?? 0;
    const durationUs = this.gops.length ? latestUs - oldestUs : 0;
    return {
      revision: this.revision,
      durationUs,
      durationMs: Math.round(durationUs / 1000),
      oldestUs,
      latestUs,
      totalBytes: this.totalBytes,
      videoBytes: this.videoBytes,
      audioBytes: this.audioBytes,
      gopCount: this.gops.length,
      keyframeOrdinal: this.gops[0]?.keyframeOrdinal ?? 0,
      videoFrameCount: this.gops.reduce((count, gop) => count + gop.frames.length, 0),
      audioFrameCount: this.audio.length,
      budgetBytes: this.maxBytes,
      overBudget: this.totalBytes > this.maxBytes,
      droppedGops: this.droppedGops,
      discardedFrames: this.discardedFrames,
    };
  }

  pressure(): number {
    return Math.min(1, this.totalBytes / this.maxBytes);
  }

  clear(): void {
    this.gops = [];
    this.audio = [];
    this.totalBytes = 0;
    this.videoBytes = 0;
    this.audioBytes = 0;
    this.lastVideoUs = -1;
    this.lastAudioUs = -1;
    this.droppedGops = 0;
    this.discardedFrames = 0;
    this.keyframeOrdinal = 0;
    this.revision += 1;
  }

  private trimDuration(): void {
    while (this.gops.length > 1) {
      const next = this.gops[1];
      if (next.startUs > this.lastVideoUs - this.maxDurationUs) {
        break;
      }
      this.dropOldestGop();
    }
  }

  private trimBytes(): void {
    while (this.totalBytes > this.maxBytes && this.gops.length > 1) {
      this.dropOldestGop();
    }
  }

  private trimAudio(): void {
    if (!this.gops.length) {
      return;
    }
    const oldestUs = this.gops[0].startUs;
    let removeCount = 0;
    while (removeCount < this.audio.length && this.audio[removeCount].timestampUs < oldestUs) {
      removeCount += 1;
    }
    if (!removeCount) {
      return;
    }
    for (const frame of this.audio.slice(0, removeCount)) {
      this.audioBytes -= frame.data.byteLength;
      this.totalBytes -= frame.data.byteLength;
    }
    this.audio = this.audio.slice(removeCount);
  }

  private dropOldestGop(): void {
    const removed = this.gops.shift();
    if (!removed) {
      return;
    }
    this.videoBytes -= removed.bytes;
    this.totalBytes -= removed.bytes;
    this.droppedGops += 1;
  }
}
