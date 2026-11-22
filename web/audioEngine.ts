// WebAudio 引擎：把合成/解码后的采样送入图，经过增益与分析节点播放，
// 并提供离线渲染统计（RMS/峰值）。无第三方包、无网络。

export interface AudioStats {
  rms: number;
  peak: number;
  sampleCount: number;
  durationSec: number;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;

  ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.gain.connect(this.analyser);
      this.analyser.connect(this.context.destination);
    }
    return this.context;
  }

  /** 播放一段单/多声道采样。 */
  async play(samples: Float32Array, sampleRate: number, channels: number, volume = 0.8): Promise<void> {
    const ctx = this.ensureContext();
    await ctx.resume();
    const frames = Math.floor(samples.length / channels);
    const buffer = ctx.createBuffer(channels, frames, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) data[i] = samples[i * channels + ch];
    }
    this.gain!.gain.value = volume;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain!);
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
  }

  /** 离线分析：不发声，计算整段 RMS/峰值，供导出报告展示。 */
  async analyze(samples: Float32Array, sampleRate: number, channels: number): Promise<AudioStats> {
    const frames = Math.floor(samples.length / channels);
    const offline = new OfflineAudioContext(channels, frames, sampleRate);
    const buffer = offline.createBuffer(channels, frames, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) data[i] = samples[i * channels + ch];
    }
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    let sumSq = 0;
    let peak = 0;
    let count = 0;
    for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
      const data = rendered.getChannelData(ch);
      for (const value of data) {
        sumSq += value * value;
        peak = Math.max(peak, Math.abs(value));
        count++;
      }
    }
    return {
      rms: Math.sqrt(sumSq / Math.max(1, count)),
      peak,
      sampleCount: count,
      durationSec: frames / sampleRate,
    };
  }

  /** 当前实时频域数据（可视化用）。 */
  frequencyData(): Uint8Array {
    if (!this.analyser) return new Uint8Array(0);
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return data;
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.analyser = null;
      this.gain = null;
    }
  }
}
