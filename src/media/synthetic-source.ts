import type { MediaFrame, MediaTransport, MediaChunk } from './media-types.ts';
import type { MonotonicClock } from '../core/types.ts';

export interface SyntheticSourceOptions {
  readonly clock: MonotonicClock;
  /** 视频帧间隔（毫秒），30fps 约 33.3。 */
  readonly videoFrameMs?: number;
  /** 音频块时长（毫秒）。 */
  readonly audioBlockMs?: number;
  readonly sampleRate?: number;
  readonly channels?: number;
  /** 模拟网络抖动：每帧额外延迟（毫秒）。 */
  readonly jitterMs?: number;
}

/**
 * 离线合成数据源：确定性生成正弦波 PCM 与带 PTS 的视频帧描述，
 * 不访问任何网络或外部服务。MediaTransport 接口与真实 MSE 路径一致，
 * 因此浏览器演示与 Node 端到端测试可以共用同一套管线代码。
 */
export class SyntheticSource implements MediaTransport {
  private readonly videoFrameMs: number;
  private readonly audioBlockMs: number;
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly jitterMs: number;
  private readonly clock: MonotonicClock;
  private nextVideoPts = 0;
  private nextAudioPts = 0;
  private edgeMs = 0;
  private seq = 0;

  constructor(options: SyntheticSourceOptions) {
    this.clock = options.clock;
    this.videoFrameMs = options.videoFrameMs ?? 1000 / 30;
    this.audioBlockMs = options.audioBlockMs ?? 20;
    this.sampleRate = options.sampleRate ?? 48_000;
    this.channels = options.channels ?? 2;
    this.jitterMs = options.jitterMs ?? 0;
  }

  /** 生成截至当前（含模拟抖动）可用的全部帧。 */
  pull(): MediaFrame[] {
    const horizon = Math.max(0, this.clock.now() - this.jitterMs);
    const frames: MediaFrame[] = [];

    while (this.nextVideoPts <= horizon) {
      this.seq += 1;
      frames.push({
        kind: 'video',
        ptsMs: this.nextVideoPts,
        durationMs: this.videoFrameMs,
        payload: { synthetic: true, ptsMs: this.nextVideoPts },
        sourceSeq: this.seq,
      });
      this.nextVideoPts += this.videoFrameMs;
    }

    while (this.nextAudioPts <= horizon) {
      this.seq += 1;
      const frameLength = Math.round((this.audioBlockMs / 1000) * this.sampleRate);
      const channels: Float32Array[] = [];
      for (let channel = 0; channel < this.channels; channel += 1) {
        channels.push(this.sineWave(frameLength, this.nextAudioPts, channel));
      }
      frames.push({
        kind: 'audio',
        ptsMs: this.nextAudioPts,
        durationMs: this.audioBlockMs,
        payload: { channels, sampleRate: this.sampleRate },
        sourceSeq: this.seq,
      });
      this.nextAudioPts += this.audioBlockMs;
    }

    this.edgeMs = Math.max(this.edgeMs, horizon);
    return frames;
  }

  private sineWave(length: number, ptsMs: number, channel: number): Float32Array {
    const samples = new Float32Array(length);
    const frequency = 440 + channel * 110;
    const startSample = Math.round((ptsMs / 1000) * this.sampleRate);
    for (let i = 0; i < length; i += 1) {
      samples[i] = 0.12 * Math.sin((2 * Math.PI * frequency * (startSample + i)) / this.sampleRate);
    }
    return samples;
  }

  nextChunk(): MediaChunk | null {
    return null;
  }

  liveEdgeMs(): number {
    return this.edgeMs;
  }

  /** 测试辅助：直接设置直播边缘。 */
  setLiveEdge(ms: number): void {
    this.edgeMs = ms;
  }
}
