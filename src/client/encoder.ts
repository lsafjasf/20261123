import { WebMMuxer } from './webm-muxer.ts';

export interface VideoEncodeConfig {
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
}

export interface AudioEncodeConfig {
  sampleRate: number;
  channels: number;
  bitrate: number;
}

/**
 * Wraps WebCodecs encoders and the in-memory WebM muxer. Codec selection is
 * probed at runtime so the app degrades gracefully across browser builds.
 */
export class Recorder {
  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private readonly muxer = new WebMMuxer();
  private failure: Error | null = null;
  private videoCodec = '';
  private videoTrackNumber = 0;
  private audioTrackNumber = 0;
  private videoDescription: BufferSource | undefined;

  static isSupported(): boolean {
    return (
      typeof globalThis.VideoEncoder !== 'undefined' &&
      typeof globalThis.VideoFrame !== 'undefined'
    );
  }

  async startVideo(config: VideoEncodeConfig): Promise<string> {
    const candidates = [
      { codec: 'vp09.00.10.08', muxerId: 'V_VP9' },
      { codec: 'vp8', muxerId: 'V_VP8' },
    ];
    let selected: (typeof candidates)[number] | null = null;
    for (const candidate of candidates) {
      const support = await VideoEncoder.isConfigSupported({
        codec: candidate.codec,
        width: config.width,
        height: config.height,
        bitrate: config.bitrate,
        framerate: config.frameRate,
      });
      if (support.supported) {
        selected = candidate;
        break;
      }
    }
    if (!selected) throw new Error('no supported WebCodecs video codec');
    this.videoCodec = selected.codec;
    this.videoTrackNumber = 1;
    this.muxer.addTrack({
      number: this.videoTrackNumber,
      codecId: selected.muxerId,
      width: config.width,
      height: config.height,
    });

    this.videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig?.description) {
          this.videoDescription = meta.decoderConfig.description;
        }
        this.muxer.addVideoChunk(this.videoTrackNumber, chunk, this.videoDescription);
      },
      error: (err) => this.fail(err),
    });
    this.videoEncoder.configure({
      codec: selected.codec,
      width: config.width,
      height: config.height,
      bitrate: config.bitrate,
      framerate: config.frameRate,
      latencyMode: 'realtime',
    });
    return selected.codec;
  }

  async startAudio(config: AudioEncodeConfig): Promise<string> {
    if (typeof globalThis.AudioEncoder === 'undefined') {
      throw new Error('AudioEncoder unavailable');
    }
    const support = await AudioEncoder.isConfigSupported({
      codec: 'opus',
      sampleRate: config.sampleRate,
      numberOfChannels: config.channels,
      bitrate: config.bitrate,
    });
    if (!support.supported) throw new Error('Opus encoder not supported');
    this.audioTrackNumber = 2;
    this.muxer.addTrack({
      number: this.audioTrackNumber,
      codecId: 'A_OPUS',
      sampleRate: config.sampleRate,
      channels: config.channels,
    });
    this.audioEncoder = new AudioEncoder({
      output: (chunk) => {
        this.muxer.addAudioChunk(this.audioTrackNumber, chunk);
      },
      error: (err) => this.fail(err),
    });
    this.audioEncoder.configure({
      codec: 'opus',
      sampleRate: config.sampleRate,
      numberOfChannels: config.channels,
      bitrate: config.bitrate,
    });
    return 'opus';
  }

  encodeVideo(frame: VideoFrame, keyFrame: boolean): void {
    this.ensureHealthy();
    if (!this.videoEncoder) throw new Error('video encoder not started');
    this.videoEncoder.encode(frame, { keyFrame });
  }

  encodeAudio(data: AudioData): void {
    this.ensureHealthy();
    if (!this.audioEncoder) throw new Error('audio encoder not started');
    this.audioEncoder.encode(data);
  }

  get videoQueueSize(): number {
    return this.videoEncoder?.encodeQueueSize ?? 0;
  }

  async finish(): Promise<Blob> {
    this.ensureHealthy();
    if (this.videoEncoder) {
      await this.videoEncoder.flush();
      this.videoEncoder.close();
      this.videoEncoder = null;
    }
    if (this.audioEncoder) {
      await this.audioEncoder.flush();
      this.audioEncoder.close();
      this.audioEncoder = null;
    }
    return this.muxer.finalize();
  }

  get codecLabel(): string {
    return this.videoCodec;
  }

  private fail(err: Error): void {
    if (!this.failure) this.failure = err;
  }

  private ensureHealthy(): void {
    if (this.failure) throw this.failure;
  }
}
