// WebCodecs 解码引擎：解封装 -> VideoDecoder/AudioDecoder -> 视频帧回调 + WebAudio 拉流。
// A/V 同步以 AudioContext 时钟为基准；无音频轨时退化为 performance 时钟。

import { demuxWebm, webmCodecString, type DemuxResult, type EncodedPacket, type WebMTrack } from "./ebml.ts";
import { AudioPullSink } from "./audioSink.ts";

export interface EngineCallbacks {
  onVideoFrame: (frame: VideoFrame, timestampMs: number) => void;
  onReady: (info: StreamInfo) => void;
  onEnded: () => void;
  onError: (error: Error) => void;
}

export interface StreamInfo {
  durationMs: number;
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
}

const AUDIO_BUFFER_AHEAD_MS = 250;
const VIDEO_AHEAD_MS = 150;

export class CodecEngine {
  private result: DemuxResult | null = null;
  private videoTrack: WebMTrack | null = null;
  private audioTrack: WebMTrack | null = null;
  private videoDecoder: VideoDecoder | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private audioContext: AudioContext | null = null;
  private audioSink: AudioPullSink | null = null;
  private packetIndex = 0;
  private playing = false;
  private rafHandle = 0;
  private startClockMs = 0;
  private startOffsetMs = 0;
  private streamInfo: StreamInfo | null = null;
  private readonly callbacks: EngineCallbacks;

  constructor(callbacks: EngineCallbacks) {
    this.callbacks = callbacks;
  }

  static isSupported(): boolean {
    return (
      typeof globalThis.VideoDecoder === "function" &&
      typeof globalThis.AudioDecoder === "function" &&
      typeof globalThis.VideoFrame === "function"
    );
  }

  async load(buffer: ArrayBuffer): Promise<StreamInfo> {
    this.result = demuxWebm(buffer);
    this.videoTrack = this.result.tracks.find((track) => track.type === "video") ?? null;
    this.audioTrack = this.result.tracks.find((track) => track.type === "audio") ?? null;
    if (!this.videoTrack) throw new Error("文件中没有视频轨");

    const videoCodec = webmCodecString(this.videoTrack);
    const videoConfig: VideoDecoderConfig = {
      codec: videoCodec,
      codecDescription: this.videoTrack.codecPrivate ?? undefined,
      optimizeForLatency: true
    };
    const videoSupport = await VideoDecoder.isConfigSupported(videoConfig);
    if (!videoSupport.supported) throw new Error(`浏览器不支持视频编码：${videoCodec}`);
    this.videoDecoder = new VideoDecoder({
      output: (frame) => this.callbacks.onVideoFrame(frame, frame.timestamp / 1000),
      error: (error) => this.callbacks.onError(error)
    });
    this.videoDecoder.configure(videoSupport.config ?? videoConfig);

    let audioCodec = "无音频轨";
    if (this.audioTrack) {
      audioCodec = webmCodecString(this.audioTrack);
      const audioConfig: AudioDecoderConfig = {
        codec: audioCodec,
        codecDescription: this.audioTrack.codecPrivate ?? undefined,
        numberOfChannels: 2,
        sampleRate: 48000
      };
      const audioSupport = await AudioDecoder.isConfigSupported(audioConfig);
      if (audioSupport.supported) {
        this.audioContext = new AudioContext();
        this.audioSink = new AudioPullSink(this.audioContext);
        this.audioDecoder = new AudioDecoder({
          output: (data) => this.audioSink?.enqueue(data),
          error: (error) => this.callbacks.onError(error)
        });
        this.audioDecoder.configure(audioSupport.config ?? audioConfig);
      } else {
        this.audioTrack = null;
      }
    }

    const size = await this.probeSize();
    this.streamInfo = {
      durationMs: this.result.durationMs,
      videoCodec,
      audioCodec,
      width: size.width,
      height: size.height
    };
    this.callbacks.onReady(this.streamInfo);
    return this.streamInfo;
  }

  private probeSize(): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      if (!this.result || !this.videoDecoder || !this.videoTrack) {
        reject(new Error("解码器未初始化"));
        return;
      }
      const keyPacket = this.result.packets.find(
        (packet) => packet.track === this.videoTrack?.number && packet.keyframe
      );
      if (!keyPacket) {
        reject(new Error("未找到关键帧"));
        return;
      }
      const decoder = this.videoDecoder;
      const original = decoder.output;
      decoder.output = (frame) => {
        const size = { width: frame.codedWidth, height: frame.codedHeight };
        frame.close();
        decoder.output = original;
        resolve(size);
      };
      this.decodeVideo(keyPacket);
    });
  }

  private decodeVideo(packet: EncodedPacket): void {
    this.videoDecoder?.decode(
      new EncodedVideoChunk({
        type: packet.keyframe ? "key" : "delta",
        timestamp: packet.timestampUs,
        data: packet.data
      })
    );
  }

  private decodeAudio(packet: EncodedPacket): void {
    this.audioDecoder?.decode(
      new EncodedAudioChunk({
        type: packet.keyframe ? "key" : "delta",
        timestamp: packet.timestampUs,
        data: packet.data
      })
    );
  }

  private clockNowMs(): number {
    if (this.audioSink) return this.audioSink.currentTimeMs - this.startClockMs + this.startOffsetMs;
    return performance.now() - this.startClockMs + this.startOffsetMs;
  }

  private pump(): void {
    if (!this.result || !this.playing) return;
    const nowMs = this.clockNowMs();
    const horizonUs = (nowMs + VIDEO_AHEAD_MS) * 1000;
    while (this.packetIndex < this.result.packets.length) {
      const packet = this.result.packets[this.packetIndex];
      if (packet.timestampUs > horizonUs) break;
      if (this.audioTrack && packet.track === this.audioTrack.number) {
        if (this.audioSink && this.audioSink.bufferedMs > AUDIO_BUFFER_AHEAD_MS) break;
        this.decodeAudio(packet);
      } else if (this.videoTrack && packet.track === this.videoTrack.number) {
        this.decodeVideo(packet);
      }
      this.packetIndex += 1;
    }
    if (
      this.packetIndex >= this.result.packets.length &&
      (this.videoDecoder?.decodeQueueSize ?? 0) === 0 &&
      (this.audioDecoder?.decodeQueueSize ?? 0) === 0
    ) {
      this.playing = false;
      this.startOffsetMs = this.streamInfo?.durationMs ?? nowMs;
      this.callbacks.onEnded();
      return;
    }
    this.rafHandle = requestAnimationFrame(() => this.pump());
  }

  async play(): Promise<void> {
    if (this.playing || !this.result) return;
    this.playing = true;
    if (this.audioSink) {
      await this.audioSink.resume();
      this.startClockMs = this.audioSink.currentTimeMs;
    } else {
      this.startClockMs = performance.now();
    }
    this.pump();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.rafHandle);
    this.startOffsetMs = this.clockNowMs();
    void this.audioSink?.suspend();
  }

  get currentTimeMs(): number {
    return this.playing ? this.clockNowMs() : this.startOffsetMs;
  }

  get durationMs(): number {
    return this.streamInfo?.durationMs ?? 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  dispose(): void {
    this.playing = false;
    cancelAnimationFrame(this.rafHandle);
    this.videoDecoder?.close();
    this.audioDecoder?.close();
    this.audioSink?.dispose();
    if (this.audioContext) void this.audioContext.close();
  }
}
