// WebAudio 拉流扬声器：把 WebCodecs AudioDecoder 产出的 AudioData 无缝排队播放。
// 不使用 AudioWorklet（避免额外模块加载），仅用标准 AudioBufferSourceNode 调度。

export class AudioPullSink {
  private readonly context: AudioContext;
  private readonly queue: AudioData[] = [];
  private nextStartTime = 0;
  private started = false;
  private totalQueuedDurationMs = 0;
  private readonly sourceNodes = new Set<AudioBufferSourceNode>();

  constructor(context: AudioContext) {
    this.context = context;
  }

  enqueue(data: AudioData): void {
    this.queue.push(data);
    this.totalQueuedDurationMs += (data.duration / data.sampleRate) * 1000;
    this.drain();
  }

  private drain(): void {
    while (this.queue.length) {
      const data = this.queue.shift()!;
      const channels = data.numberOfChannels;
      const frames = data.numberOfFrames;
      const buffer = this.context.createBuffer(channels, frames, data.sampleRate);
      const planar = new Float32Array(channels * frames);
      data.copyTo(planar, { planeIndex: 0, format: "f32-planar" });
      for (let channel = 0; channel < channels; channel += 1) {
        buffer.copyToChannel(planar.subarray(channel * frames, (channel + 1) * frames), channel);
      }
      data.close();

      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      const when = this.started ? Math.max(this.nextStartTime, this.context.currentTime) : this.context.currentTime;
      source.start(when);
      this.nextStartTime = when + buffer.duration;
      this.started = true;
      this.sourceNodes.add(source);
      source.onended = () => {
        this.sourceNodes.delete(source);
        source.disconnect();
      };
    }
  }

  /** 已入队但尚未播放的音频时长（毫秒），用于决定何时继续喂音频包。 */
  get bufferedMs(): number {
    if (!this.started) return this.totalQueuedDurationMs;
    const remaining = (this.nextStartTime - this.context.currentTime) * 1000;
    return Math.max(0, remaining);
  }

  get currentTimeMs(): number {
    return this.context.currentTime * 1000;
  }

  async resume(): Promise<void> {
    await this.context.resume();
  }

  suspend(): Promise<void> {
    return this.context.suspend();
  }

  get running(): boolean {
    return this.context.state === "running";
  }

  dispose(): void {
    for (const source of this.sourceNodes) {
      try {
        source.stop();
      } catch {
        // 已停止的节点再次 stop 会抛错，忽略。
      }
      source.disconnect();
    }
    this.sourceNodes.clear();
    for (const data of this.queue) data.close();
    this.queue.length = 0;
  }
}
