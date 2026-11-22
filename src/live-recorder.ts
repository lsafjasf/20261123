import { KeyframeRingBuffer } from "./ring-buffer.ts";
import type { TrailScene } from "./scene.ts";

export interface RecorderTelemetry {
  running: boolean;
  cameraActive: boolean;
  audioMode: "microphone" | "synthetic" | "unavailable";
  bitrateKbps: number;
  videoFrames: number;
  audioFrames: number;
  skippedVideoFrames: number;
  lastKeyframeUs: number;
  warning: string | null;
}

export interface LiveRecorderOptions {
  canvas: HTMLCanvasElement;
  scene: TrailScene;
  ring: KeyframeRingBuffer;
  onError?: (message: string) => void;
}

const VIDEO_CODEC = "vp8";
const AUDIO_CODEC = "opus";
const FRAME_RATE = 30;
const FRAME_INTERVAL_MS = 1000 / FRAME_RATE;
const FRAME_DURATION_US = Math.round(1_000_000 / FRAME_RATE);
const KEYFRAME_INTERVAL_US = 2_000_000;
const AUDIO_CHUNK_FRAMES = 960;

function concatSamples(left: Float32Array, right: Float32Array): Float32Array {
  const output = new Float32Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

export class LiveRecorder {
  private readonly canvas: HTMLCanvasElement;
  private readonly scene: TrailScene;
  private readonly ring: KeyframeRingBuffer;
  private readonly onError: (message: string) => void;
  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private audioContext: AudioContext | null = null;
  private audioTap: AudioWorkletNode | null = null;
  private audioSources: AudioScheduledSourceNode[] = [];
  private mediaStream: MediaStream | null = null;
  private animationFrame = 0;
  private running = false;
  private cameraActive = false;
  private audioMode: RecorderTelemetry["audioMode"] = "unavailable";
  private warning: string | null = null;
  private startWallMs = 0;
  private lastCaptureWallMs = 0;
  private lastVideoTimestampUs = -1;
  private lastKeyframeUs = -1;
  private forceKeyframe = true;
  private encodedVideoFrames = 0;
  private encodedAudioFrames = 0;
  private skippedVideoFrames = 0;
  private audioPending: [Float32Array, Float32Array] = [new Float32Array(), new Float32Array()];
  private audioTimestampUs = 0;
  private bitrateKbps = 0;
  private bitrateBytes = 0;
  private bitrateWindowStart = 0;

  constructor(options: LiveRecorderOptions) {
    this.canvas = options.canvas;
    this.scene = options.scene;
    this.ring = options.ring;
    this.onError = options.onError ?? (() => undefined);
  }

  async start(stream: MediaStream | null): Promise<void> {
    if (this.running) {
      return;
    }
    this.warning = null;
    this.encodedVideoFrames = 0;
    this.encodedAudioFrames = 0;
    this.skippedVideoFrames = 0;
    this.audioTimestampUs = 0;
    this.lastKeyframeUs = -1;
    this.mediaStream = stream;
    this.cameraActive = await this.scene.attachStream(stream);
    this.bitrateKbps = 0;
    this.bitrateBytes = 0;
    this.bitrateWindowStart = performance.now();

    const videoConfig: VideoEncoderConfig = {
      codec: VIDEO_CODEC,
      width: this.canvas.width,
      height: this.canvas.height,
      bitrate: 2_500_000,
      framerate: FRAME_RATE,
      latencyMode: "realtime",
    };
    const support = await VideoEncoder.isConfigSupported(videoConfig).catch(() => null);
    if (!support?.supported) {
      throw new Error("当前浏览器不支持 VP8 WebCodecs 视频编码");
    }

    this.videoEncoder = new VideoEncoder({
      output: (chunk) => this.handleVideoChunk(chunk),
      error: (error) => this.handleFatal(error),
    });
    this.videoEncoder.configure(videoConfig);
    await this.startAudio(stream);

    this.running = true;
    this.startWallMs = performance.now();
    this.lastCaptureWallMs = this.startWallMs - FRAME_INTERVAL_MS;
    this.lastVideoTimestampUs = -1;
    this.lastKeyframeUs = -1;
    this.forceKeyframe = true;
    this.animationFrame = requestAnimationFrame(this.tick);
  }

  getTelemetry(): RecorderTelemetry {
    return {
      running: this.running,
      cameraActive: this.cameraActive,
      audioMode: this.audioMode,
      bitrateKbps: this.bitrateKbps,
      videoFrames: this.encodedVideoFrames,
      audioFrames: this.encodedAudioFrames,
      skippedVideoFrames: this.skippedVideoFrames,
      lastKeyframeUs: this.lastKeyframeUs,
      warning: this.warning,
    };
  }

  async stop(): Promise<void> {
    if (!this.running && !this.videoEncoder && !this.audioEncoder && !this.audioContext && !this.mediaStream) {
      return;
    }
    this.running = false;
    cancelAnimationFrame(this.animationFrame);
    for (const source of this.audioSources) {
      try {
        source.stop();
      } catch {
      }
    }
    this.audioSources = [];
    this.audioTap?.port.close();
    this.audioTap?.disconnect();
    this.audioTap = null;

    await Promise.allSettled([
      this.videoEncoder?.flush(),
      this.audioEncoder?.flush(),
    ]);
    this.videoEncoder?.close();
    this.audioEncoder?.close();
    this.videoEncoder = null;
    this.audioEncoder = null;
    await this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.scene.detachCamera();
    for (const track of this.mediaStream?.getTracks() ?? []) {
      track.stop();
    }
    this.mediaStream = null;
    this.cameraActive = false;
    this.audioMode = "unavailable";
    this.audioPending = [new Float32Array(), new Float32Array()];
  }

  private tick = (now: number): void => {
    if (!this.running) {
      return;
    }
    this.animationFrame = requestAnimationFrame(this.tick);
    const encoder = this.videoEncoder;
    if (!encoder || now - this.lastCaptureWallMs < FRAME_INTERVAL_MS - 0.5) {
      return;
    }
    if (encoder.encodeQueueSize > 2) {
      this.skippedVideoFrames += 1;
      return;
    }

    const timestampUs = Math.max(this.lastVideoTimestampUs + 1, Math.round((now - this.startWallMs) * 1000));
    const keyFrame = this.forceKeyframe || this.lastKeyframeUs < 0 ||
      timestampUs - this.lastKeyframeUs >= KEYFRAME_INTERVAL_US ||
      this.ring.pressure() >= 0.82;
    const frame = new VideoFrame(this.canvas, {
      timestamp: timestampUs,
      duration: FRAME_DURATION_US,
    });
    try {
      encoder.encode(frame, { keyFrame });
    } catch (error) {
      this.handleFatal(error);
      frame.close();
      return;
    }
    frame.close();
    this.lastCaptureWallMs = now;
    this.lastVideoTimestampUs = timestampUs;
    if (keyFrame) {
      this.lastKeyframeUs = timestampUs;
      this.forceKeyframe = false;
    }
  };

  private async startAudio(stream: MediaStream | null): Promise<void> {
    if (typeof AudioEncoder === "undefined" || typeof AudioContext === "undefined") {
      this.warning = "浏览器不支持 WebCodecs 音频编码，直播将以纯视频继续";
      this.audioMode = "unavailable";
      return;
    }

    try {
      const context = new AudioContext({
        sampleRate: 48_000,
        latencyHint: "interactive",
      });
      this.audioContext = context;
      await context.resume();
      const config: AudioEncoderConfig = {
        codec: AUDIO_CODEC,
        sampleRate: context.sampleRate,
        numberOfChannels: 2,
        bitrate: 96_000,
      };
      const support = await AudioEncoder.isConfigSupported(config).catch(() => null);
      if (!support?.supported) {
        this.warning = "当前浏览器不支持 Opus 音频编码，直播将以纯视频继续";
        this.audioMode = "unavailable";
        await context.close();
        this.audioContext = null;
        return;
      }

      await context.audioWorklet.addModule(new URL("./pcm-worklet.ts", import.meta.url).href);
      const tap = new AudioWorkletNode(context, "pcm-tap", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: "explicit",
      });
      this.audioTap = tap;
      const silent = context.createGain();
      silent.gain.value = 0;
      tap.connect(silent);
      silent.connect(context.destination);

      const audioTracks = stream?.getAudioTracks() ?? [];
      if (audioTracks.length) {
        const microphone = context.createMediaStreamSource(new MediaStream(audioTracks));
        microphone.connect(tap);
        this.audioMode = "microphone";
      } else {
        this.startSyntheticAmbience(context, tap);
        this.audioMode = "synthetic";
      }

      this.audioEncoder = new AudioEncoder({
        output: (chunk) => this.handleAudioChunk(chunk),
        error: (error) => this.handleFatal(error),
      });
      this.audioEncoder.configure(config);
      tap.port.onmessage = (event: MessageEvent<AudioWorkletMessage>) => this.handleAudioPcm(event.data);
    } catch (error) {
      this.warning = `音频链路不可用：${error instanceof Error ? error.message : String(error)}`;
      this.audioMode = "unavailable";
      this.audioTap?.port.close();
      this.audioTap?.disconnect();
      this.audioTap = null;
      await this.audioContext?.close().catch(() => undefined);
      this.audioContext = null;
    }
  }

  private startSyntheticAmbience(context: AudioContext, destination: AudioNode): void {
    const first = context.createOscillator();
    const second = context.createOscillator();
    const gain = context.createGain();
    first.type = "sine";
    first.frequency.value = 196;
    second.type = "triangle";
    second.frequency.value = 293.7;
    gain.gain.value = 0.035;
    first.connect(gain);
    second.connect(gain);
    gain.connect(destination);
    first.start();
    second.start();
    this.audioSources.push(first, second);
  }

  private handleAudioPcm(message: AudioWorkletMessage): void {
    if (!this.running && this.videoEncoder) {
      return;
    }
    const firstChannel = message.channels[0];
    if (!firstChannel) {
      return;
    }
    const secondChannel = message.channels[1] ?? firstChannel;
    this.audioPending[0] = concatSamples(this.audioPending[0], firstChannel);
    this.audioPending[1] = concatSamples(this.audioPending[1], secondChannel);
    const encoder = this.audioEncoder;
    if (!encoder) {
      return;
    }

    while (this.audioPending[0].length >= AUDIO_CHUNK_FRAMES) {
      const planar = new Float32Array(AUDIO_CHUNK_FRAMES * 2);
      planar.set(this.audioPending[0].subarray(0, AUDIO_CHUNK_FRAMES), 0);
      planar.set(this.audioPending[1].subarray(0, AUDIO_CHUNK_FRAMES), AUDIO_CHUNK_FRAMES);
      this.audioPending[0] = this.audioPending[0].slice(AUDIO_CHUNK_FRAMES);
      this.audioPending[1] = this.audioPending[1].slice(AUDIO_CHUNK_FRAMES);
      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate: this.audioContext?.sampleRate ?? 48_000,
        numberOfFrames: AUDIO_CHUNK_FRAMES,
        numberOfChannels: 2,
        timestamp: this.audioTimestampUs,
        data: planar,
      });
      this.audioTimestampUs += Math.round((AUDIO_CHUNK_FRAMES / audioData.sampleRate) * 1_000_000);
      encoder.encode(audioData);
      audioData.close();
    }
  }

  private handleVideoChunk(chunk: EncodedVideoChunk): void {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const accepted = this.ring.appendVideo({
      type: chunk.type,
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration,
      data,
    });
    if (!accepted) {
      return;
    }
    this.encodedVideoFrames += 1;
    this.addBitrateBytes(data.byteLength);
    if (chunk.type === "key") {
      this.lastKeyframeUs = chunk.timestamp;
    }
  }

  private handleAudioChunk(chunk: EncodedAudioChunk): void {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const accepted = this.ring.appendAudio({
      type: chunk.type,
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration,
      data,
    });
    if (!accepted) {
      return;
    }
    this.encodedAudioFrames += 1;
    this.addBitrateBytes(data.byteLength);
  }

  private addBitrateBytes(byteLength: number): void {
    this.bitrateBytes += byteLength;
    const now = performance.now();
    const elapsed = now - this.bitrateWindowStart;
    if (elapsed >= 1_000) {
      this.bitrateKbps = Math.round((this.bitrateBytes * 8) / elapsed);
      this.bitrateBytes = 0;
      this.bitrateWindowStart = now;
    }
  }

  private handleFatal(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.warning = `编码器停止：${message}`;
    this.onError(this.warning);
    if (this.running) {
      void this.stop().catch(() => undefined);
    }
  }
}

interface AudioWorkletMessage {
  sampleRate: number;
  frames: number;
  channels: Float32Array[];
}
