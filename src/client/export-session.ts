import { Recorder } from './encoder.ts';
import type { AudioMixer } from './audio-mixer.ts';

export interface ExportProgress {
  frame: number;
  totalFrames: number;
  queueSize: number;
}

export interface ExportHandles {
  blob: Blob;
  codec: string;
  hasAudio: boolean;
}

/**
 * Drives a real-time export in lock-step with the preview rAF loop. The
 * caller renders every frame through the shared Compositor, then hands the
 * same canvas to captureFrame(); audio is captured concurrently from the
 * WebAudio mix. There is no second renderer, so output pixels match preview.
 */
export class ExportSession {
  private readonly recorder = new Recorder();
  private readonly canvas: HTMLCanvasElement;
  private readonly frameDurationUs: number;
  private audioReader: ReadableStreamDefaultReader<AudioData> | null = null;
  private audioPumpRunning = false;
  private hasAudio = false;

  private constructor(
    canvas: HTMLCanvasElement,
    readonly frameRate: number,
    readonly totalFrames: number,
  ) {
    this.canvas = canvas;
    this.frameDurationUs = 1_000_000 / frameRate;
  }

  static async create(
    canvas: HTMLCanvasElement,
    frameRate: number,
    totalFrames: number,
    mixer: AudioMixer | null,
    audioTap: ReadableStream<AudioData> | null,
  ): Promise<ExportSession> {
    if (!Recorder.isSupported()) {
      throw new Error('WebCodecs is not available in this browser');
    }
    const session = new ExportSession(canvas, frameRate, totalFrames);
    await session.recorder.startVideo({
      width: canvas.width,
      height: canvas.height,
      frameRate,
      bitrate: 6_000_000,
    });
    if (mixer && audioTap) {
      try {
        await session.recorder.startAudio({
          sampleRate: mixer.sampleRate,
          channels: 2,
          bitrate: 128_000,
        });
        session.audioReader = audioTap.getReader();
        session.hasAudio = true;
        session.pumpAudio();
      } catch {
        session.hasAudio = false;
      }
    }
    return session;
  }

  captureFrame(frame: number, keyFrame: boolean): void {
    const timestampUs = Math.round(frame * this.frameDurationUs);
    const videoFrame = new VideoFrame(this.canvas, {
      timestamp: timestampUs,
      duration: this.frameDurationUs,
    });
    this.recorder.encodeVideo(videoFrame, keyFrame);
    videoFrame.close();
  }

  private pumpAudio(): void {
    if (!this.audioReader || this.audioPumpRunning) return;
    this.audioPumpRunning = true;
    (async () => {
      while (this.audioReader) {
        const { value, done } = await this.audioReader.read();
        if (done || !value) break;
        this.recorder.encodeAudio(value);
        value.close();
      }
      this.audioPumpRunning = false;
    })();
  }

  get queueSize(): number {
    return this.recorder.videoQueueSize;
  }

  get audioEnabled(): boolean {
    return this.hasAudio;
  }

  async finalize(): Promise<ExportHandles> {
    if (this.audioReader) {
      await this.audioReader.cancel();
      this.audioReader = null;
    }
    const blob = await this.recorder.finish();
    return { blob, codec: this.recorder.codecLabel, hasAudio: this.hasAudio };
  }
}
