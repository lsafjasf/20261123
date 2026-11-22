// Minimal ambient declarations for WebCodecs surfaces not present in every
// TypeScript DOM lib version. The runtime APIs remain browser-native.

interface VideoEncoderConfig {
  codec: string;
  width?: number;
  height?: number;
  bitrate?: number;
  framerate?: number;
  latencyMode?: "quality" | "realtime";
}

interface AudioEncoderConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate?: number;
}

interface AudioDataInit {
  format: "f32-planar" | "f32" | "s16";
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  data: Uint8Array;
}

declare class AudioData {
  constructor(init: AudioDataInit);
  close(): void;
}

interface EncodedVideoChunk {
  readonly byteLength: number;
  readonly timestamp: number;
  readonly type: "key" | "delta";
  copyTo(destination: Uint8Array): void;
}

interface EncodedAudioChunk {
  readonly byteLength: number;
  readonly timestamp: number;
  readonly type: "key" | "delta";
  copyTo(destination: Uint8Array): void;
}

interface VideoEncoder {
  encodeQueueSize: number;
  configure(config: VideoEncoderConfig): void;
  encode(frame: VideoFrame, options?: { keyFrame?: boolean }): void;
  flush(): Promise<void>;
  close(): void;
}

interface AudioEncoder {
  configure(config: AudioEncoderConfig): void;
  encode(data: AudioData): void;
  flush(): Promise<void>;
  close(): void;
}

declare const VideoEncoder: {
  new (handlers: {
    output: (chunk: EncodedVideoChunk) => void;
    error: (error: Error) => void;
  }): VideoEncoder;
  isConfigSupported(config: VideoEncoderConfig): Promise<{ supported: boolean }>;
};

declare const AudioEncoder: {
  new (handlers: {
    output: (chunk: EncodedAudioChunk) => void;
    error: (error: Error) => void;
  }): AudioEncoder;
};

declare class VideoFrame {
  constructor(source: CanvasImageSource, options: { timestamp: number; duration?: number });
  close(): void;
}

interface OffscreenCanvasRenderingContext2D extends CanvasRenderingContext2D {}

declare class OffscreenAudioContext extends AudioContext {
  constructor(numberOfChannels: number, length: number, sampleRate: number);
}
