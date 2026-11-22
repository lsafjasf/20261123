import type { FrameKind, MediaFrame } from '../media/media-types.ts';

/** 解码器输出回调，接到 SyncEngine.enqueue。 */
export type DecodedFrameHandler = (frame: MediaFrame) => void;

export interface DecoderConfig {
  readonly kind: FrameKind;
  readonly codec: string;
  readonly sampleRate?: number;
  readonly numberOfChannels?: number;
  readonly codedWidth?: number;
  readonly codedHeight?: number;
  readonly description?: BufferSource;
}

/**
 * WebCodecs 解码封装。
 * PTS 统一换算为毫秒媒体时间，输出帧直接进入由 MediaClock 驱动的抖动缓冲，
 * 解码器自身不决定呈现时机。
 */
export class WebCodecsDecoder {
  private videoDecoder: VideoDecoder | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private sourceSeq = 0;
  private readonly onFrame: DecodedFrameHandler;

  constructor(onFrame: DecodedFrameHandler) {
    this.onFrame = onFrame;
  }

  configure(config: DecoderConfig): void {
    if (config.kind === 'video') {
      this.videoDecoder = new VideoDecoder({
        output: (frame) => this.handleVideo(frame),
        error: (error) => this.handleError('video', error),
      });
      this.videoDecoder.configure({
        codec: config.codec,
        codedWidth: config.codedWidth,
        codedHeight: config.codedHeight,
        description: config.description,
      });
      return;
    }
    this.audioDecoder = new AudioDecoder({
      output: (frame) => this.handleAudio(frame),
      error: (error) => this.handleError('audio', error),
    });
    this.audioDecoder.configure({
      codec: config.codec,
      sampleRate: config.sampleRate ?? 48_000,
      numberOfChannels: config.numberOfChannels ?? 2,
      description: config.description,
    });
  }

  private handleVideo(frame: VideoFrame): void {
    this.sourceSeq += 1;
    const durationMs = (frame.duration ?? 0) / 1000;
    this.onFrame({
      kind: 'video',
      ptsMs: frame.timestamp / 1000,
      durationMs,
      payload: frame,
      sourceSeq: this.sourceSeq,
    });
  }

  private handleAudio(frame: AudioData): void {
    this.sourceSeq += 1;
    const channelCount = frame.numberOfChannels;
    const length = frame.numberOfFrames;
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < channelCount; channel += 1) {
      const buffer = new Float32Array(length);
      frame.copyTo(buffer, { planeIndex: channel, format: 'f32-planar' });
      channels.push(buffer);
    }
    const mediaFrame: MediaFrame = {
      kind: 'audio',
      ptsMs: frame.timestamp / 1000,
      durationMs: (frame.duration ?? 0) / 1000,
      payload: { channels, sampleRate: frame.sampleRate },
      sourceSeq: this.sourceSeq,
    };
    frame.close();
    this.onFrame(mediaFrame);
  }

  /** 投递压缩帧（时间戳单位微秒，WebCodecs 约定）。 */
  decode(chunk: EncodedAudioChunk | EncodedVideoChunk): void {
    if (chunk instanceof EncodedVideoChunk) {
      this.videoDecoder?.decode(chunk);
    } else {
      this.audioDecoder?.decode(chunk);
    }
  }

  /** seek 后刷新解码器，丢弃与旧位置相关的延迟帧。 */
  flush(): Promise<void> {
    return Promise.all([
      this.videoDecoder?.flush() ?? Promise.resolve(),
      this.audioDecoder?.flush() ?? Promise.resolve(),
    ]).then(() => undefined);
  }

  private handleError(kind: FrameKind, error: DOMException): void {
    console.error(`[webcodecs:${kind}] decoder error`, error);
  }

  dispose(): void {
    this.videoDecoder?.close();
    this.audioDecoder?.close();
    this.videoDecoder = null;
    this.audioDecoder = null;
  }
}
