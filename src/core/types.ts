import type { Fraction } from "./fraction.ts";

export type PlaybackStatus =
  | "idle"
  | "loading"
  | "paused"
  | "playing"
  | "migrating"
  | "interrupted"
  | "ended";

export type MigrationReason =
  | "device-switch"
  | "sample-rate-change"
  | "channel-layout-change"
  | "device-lost"
  | "recover";

export interface DeviceFormat {
  readonly deviceId: string;
  readonly label: string;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly channelLayout: "mono" | "stereo" | "surround";
}

export interface PcmChunk {
  readonly startFrame: number;
  readonly frameCount: number;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly channels: readonly Float32Array[];
}

export interface SinkSnapshot {
  readonly position: Fraction;
  readonly renderedOutputFrames: number;
  readonly generation: number;
}

export interface PlaybackSnapshot {
  readonly status: PlaybackStatus;
  readonly position: Fraction;
  readonly durationFrames: number;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly device: DeviceFormat | null;
  readonly resumeIntent: boolean;
  readonly recoverable: boolean;
  readonly revision: number;
  readonly lastError: string | null;
}

export interface AudioSink {
  readonly format: DeviceFormat;
  open(position: Fraction, generation: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<SinkSnapshot>;
  seek(position: Fraction, generation: number): Promise<SinkSnapshot>;
  handoff(): Promise<SinkSnapshot>;
  close(): Promise<void>;
}

export interface AudioSinkFactory {
  create(format: DeviceFormat): Promise<AudioSink>;
}

export interface PlaybackControllerOptions {
  readonly durationFrames: number;
  readonly sampleRate: number;
  readonly sinkFactory: AudioSinkFactory;
  readonly initialPosition?: Fraction;
  readonly onChange?: (snapshot: PlaybackSnapshot) => void;
}

export interface PositionUpdate {
  readonly sink: AudioSink;
  readonly snapshot: SinkSnapshot;
}
