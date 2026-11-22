import type { FrameRenderer } from '../media/sync-engine.ts';
import type { LatencyInfo, MonotonicClock } from '../core/types.ts';
import type { MediaFrame } from '../media/media-types.ts';

/** 音频帧载荷：解码后的交错/平面 PCM。 */
export interface PcmPayload {
  readonly channels: Float32Array[];
  readonly sampleRate: number;
}

export interface WebAudioRendererOptions {
  readonly context: AudioContext;
  readonly workletUrl: string;
  readonly clock: MonotonicClock;
  readonly channelCount?: number;
  /** 延迟探测间隔（毫秒），蓝牙切换时据此发现 outputLatency 突变。 */
  readonly latencyPollMs?: number;
}

/**
 * WebAudio 渲染器。
 * 只负责把统一时钟已决策的 PCM 帧送入 AudioWorklet，
 * 调度时机与 PTS 判定全部来自 SyncEngine，自身不维护播放时钟。
 */
export class WebAudioRenderer implements FrameRenderer {
  private node: AudioWorkletNode | null = null;
  private readonly context: AudioContext;
  private readonly workletUrl: string;
  private readonly clock: MonotonicClock;
  private readonly channelCount: number;
  private lastLatencyMs = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WebAudioRendererOptions) {
    this.context = options.context;
    this.workletUrl = options.workletUrl;
    this.clock = options.clock;
    this.channelCount = options.channelCount ?? 2;
    this.lastLatencyMs = (options.context.outputLatency ?? 0) * 1000;
    void this.startLatencyPoll(options.latencyPollMs ?? 500);
  }

  private async startLatencyPoll(intervalMs: number): Promise<void> {
    await this.context.resume();
    this.pollTimer = setInterval(() => {
      this.emitLatencyIfChanged();
    }, intervalMs);
    this.pollTimer.unref?.();
  }

  private latencyListeners = new Set<(info: LatencyInfo) => void>();

  /** 订阅输出延迟变化（蓝牙耳机接入/断开）。 */
  onLatencyChange(fn: (info: LatencyInfo) => void): () => void {
    this.latencyListeners.add(fn);
    return () => this.latencyListeners.delete(fn);
  }

  private emitLatencyIfChanged(): void {
    const outputLatencyMs = (this.context.outputLatency ?? 0) * 1000;
    if (Math.abs(outputLatencyMs - this.lastLatencyMs) < 0.5) {
      return;
    }
    this.lastLatencyMs = outputLatencyMs;
    const info: LatencyInfo = {
      baseLatencyMs: (this.context.baseLatency ?? 0) * 1000,
      outputLatencyMs,
      perfMs: this.clock.now(),
    };
    for (const fn of this.latencyListeners) {
      fn(info);
    }
  }

  async init(): Promise<void> {
    await this.context.resume();
    await this.context.audioWorklet.addModule(this.workletUrl);
    this.node = new AudioWorkletNode(this.context, 'clock-audio-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.channelCount],
      processorOptions: { channelCount: this.channelCount },
    });
    this.node.connect(this.context.destination);
  }

  render(frame: MediaFrame, dueInMs: number): void {
    if (!this.node) {
      throw new Error('WebAudioRenderer.init() must complete before render()');
    }
    const payload = frame.payload as PcmPayload;
    // dueInMs 已在调度器中扣除 outputLatency；这里仅做精度级微延后。
    this.node.port.postMessage(
      { type: 'pcm', ptsMs: frame.ptsMs, sampleRate: payload.sampleRate, channels: payload.channels },
      payload.channels.map((channel) => channel.buffer),
    );
  }

  release(frame: MediaFrame): void {
    // PCM 为普通 Float32Array，无 WebCodecs 句柄需要释放。
    void frame;
  }

  freeze(reason: string): void {
    if (reason === 'paused' || reason === 'buffering' || reason === 'ended') {
      this.node?.port.postMessage({ type: 'suspend' });
    }
  }

  /** 恢复播放时清空残留并解除挂起。 */
  unfreeze(): void {
    this.node?.port.postMessage({ type: 'reset' });
    this.node?.port.postMessage({ type: 'resume' });
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.node?.port.postMessage({ type: 'suspend' });
    this.node?.disconnect();
    this.node = null;
  }
}
