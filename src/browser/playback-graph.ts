import { ANALYSIS_BANDS, type DeviceModel } from '../shared/devices.ts';
import type { AudioBufferData, StemGain, StemId } from '../shared/types.ts';
import { mulberry32 } from '../shared/dsp-math.ts';

const STEM_IDS: StemId[] = ['dialogue', 'music', 'effects'];

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

// Builds the real-time WebAudio approximation of one device model. The offline
// analysis remains the source of truth for numbers; this graph only previews
// the same approximate colouration and limiting behaviour for listening.
export class DevicePlayback {
  private readonly context: AudioContext;
  private readonly device: DeviceModel;
  private readonly stemBus: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly master: GainNode;
  private readonly noiseGain: GainNode;
  private noiseSource: AudioBufferSourceNode;
  private sources: ActiveSource[] = [];
  private startTime = 0;
  private offset = 0;
  private noiseRunning = false;
  private baseNoiseGain: number;

  constructor(context: AudioContext, device: DeviceModel) {
    this.context = context;
    this.device = device;
    this.stemBus = context.createGain();
    this.master = context.createGain();
    this.noiseGain = context.createGain();
    this.limiter = context.createDynamicsCompressor();
    // Aggressive knee above the modelled ceiling acts as a limiter proxy.
    this.limiter.threshold.value = device.ceilingDb;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;

    let tail: AudioNode = this.stemBus;
    const highPass = context.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = Math.min(device.highPassHz, context.sampleRate * 0.45);
    highPass.Q.value = 0.707;
    tail.connect(highPass);
    tail = highPass;

    for (const band of ANALYSIS_BANDS) {
      const gainDb = device.bandResponseDb[band.index];
      if (Math.abs(gainDb) < 0.5) continue;
      const peaking = context.createBiquadFilter();
      peaking.type = 'peaking';
      peaking.frequency.value = Math.min(band.centerHz, context.sampleRate * 0.45);
      peaking.Q.value = 1.1;
      peaking.gain.value = gainDb;
      tail.connect(peaking);
      tail = peaking;
    }

    const lowPass = context.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = Math.min(device.lowPassHz, context.sampleRate * 0.45);
    lowPass.Q.value = 0.707;
    tail.connect(lowPass);
    lowPass.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(context.destination);

    this.noiseSource = this.createNoiseSource();
    const averageFloor =
      device.noiseFloorDb.reduce((sum, value) => sum + value, 0) /
      device.noiseFloorDb.length;
    this.baseNoiseGain = Math.pow(10, averageFloor / 20);
    this.noiseGain.gain.value = this.baseNoiseGain;
    this.noiseSource.connect(this.noiseGain);
    this.noiseGain.connect(this.master);
  }

  private buildNoiseBuffer(): AudioBuffer {
    const seconds = 2;
    const buffer = this.context.createBuffer(
      1,
      this.context.sampleRate * seconds,
      this.context.sampleRate,
    );
    const data = buffer.getChannelData(0);
    const random = mulberry32(0x1234abcd);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = (random() * 2 - 1) * 0.6;
    }
    return buffer;
  }

  private createNoiseSource(): AudioBufferSourceNode {
    const source = this.context.createBufferSource();
    source.buffer = this.buildNoiseBuffer();
    source.loop = true;
    source.connect(this.noiseGain);
    return source;
  }

  private toAudioBuffer(stem: AudioBufferData): AudioBuffer {
    const buffer = this.context.createBuffer(
      stem.channels.length,
      stem.channels[0].length,
      stem.sampleRate,
    );
    for (let channel = 0; channel < stem.channels.length; channel += 1) {
      buffer.copyToChannel(stem.channels[channel], channel);
    }
    return buffer;
  }

  setStemGains(gains: StemGain): void {
    for (const active of this.sources) {
      const id = (active.source as AudioBufferSourceNode & { stemId?: StemId }).stemId;
      if (id) active.gain.gain.value = Math.pow(10, gains[id] / 20);
    }
  }

  setNoiseEnabled(enabled: boolean): void {
    this.noiseGain.gain.setTargetAtTime(
      enabled ? this.baseNoiseGain : 0,
      this.context.currentTime,
      0.05,
    );
  }

  async start(
    stems: Partial<Record<StemId, AudioBufferData>>,
    gains: StemGain,
    offsetSec = 0,
  ): Promise<void> {
    await this.context.resume();
    this.stopSources();
    for (const id of STEM_IDS) {
      const stem = stems[id];
      if (!stem) continue;
      const source = this.context.createBufferSource();
      source.buffer = this.toAudioBuffer(stem);
      (source as AudioBufferSourceNode & { stemId?: StemId }).stemId = id;
      const gain = this.context.createGain();
      gain.gain.value = Math.pow(10, gains[id] / 20);
      source.connect(gain);
      gain.connect(this.stemBus);
      source.start(0, offsetSec);
      this.sources.push({ source, gain });
    }
    this.noiseSource = this.createNoiseSource();
    this.noiseSource.start();
    this.noiseRunning = true;
    this.startTime = this.context.currentTime;
    this.offset = offsetSec;
  }

  get currentTime(): number {
    if (this.sources.length === 0) return this.offset;
    return this.offset + (this.context.currentTime - this.startTime);
  }

  private stopSources(): void {
    for (const { source } of this.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped; ignore.
      }
      source.disconnect();
    }
    this.sources = [];
    if (this.noiseRunning) {
      try {
        this.noiseSource.stop();
      } catch {
        // Already stopped.
      }
      this.noiseRunning = false;
    }
  }

  dispose(): void {
    this.stopSources();
    this.stemBus.disconnect();
    this.limiter.disconnect();
    this.master.disconnect();
    this.noiseGain.disconnect();
  }
}
