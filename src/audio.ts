import { CAMERAS, clamp, type ChannelMetrics } from "./domain.ts";
import { analyzeChannel, initialMetricState, type AudioMetricState } from "./audio-metrics.ts";
import { EXCHANGE_MS, LOOP_MS, exchangeAt } from "./scenario.ts";

const SAMPLE_RATE = 24_000;
const TAU = Math.PI * 2;

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function synthesizeChannels(): Float32Array[] {
  const count = Math.floor((LOOP_MS / 1000) * SAMPLE_RATE);
  const focuses = Array.from({ length: 6 }, (_, index) => exchangeAt(index * EXCHANGE_MS + 10).focus);
  const buffers = CAMERAS.map((_, cameraIndex) => {
    const random = mulberry32(0x51c0de + cameraIndex * 9973);
    const data = new Float32Array(count);
    let low = 0;
    let harmonic = 0;
    for (let n = 0; n < count; n += 1) {
      const seconds = n / SAMPLE_RATE;
      const loopMs = seconds * 1000;
      const exchangeIndex = Math.min(5, Math.floor(loopMs / EXCHANGE_MS));
      const focus = focuses[exchangeIndex]!;
      const local = (loopMs - exchangeIndex * EXCHANGE_MS) / 1000;
      const target = focus === cameraIndex + 1;
      const support = cameraIndex === 0 || cameraIndex === 4 || cameraIndex === 5;
      const base = target ? 0.088 : support ? 0.026 : 0.014;
      const white = random() * 2 - 1;
      low += 0.085 * (white - low);
      const air = white - low;
      const crowd =
        local > 5.1
          ? Math.max(0, 1 - (local - 5.1) / 0.82) * (target ? 0.08 : support ? 0.045 : 0.018)
          : 0;
      harmonic = 0.996 * harmonic + 0.004 * Math.sin(TAU * 96 * seconds + cameraIndex * 0.8);
      data[n] =
        low * base +
        air * base * 0.24 +
        harmonic * (target ? 0.014 : 0.005) +
        (random() * 2 - 1) * crowd;
    }
    return { data, random };
  });

  for (let exchangeIndex = 0; exchangeIndex < 6; exchangeIndex += 1) {
    const exchange = exchangeAt(exchangeIndex * EXCHANGE_MS + 10);
    for (const hit of exchange.hits) {
      const start = Math.floor(hit * SAMPLE_RATE);
      const length = Math.floor(0.16 * SAMPLE_RATE);
      for (let channel = 0; channel < 6; channel += 1) {
        const buffer = buffers[channel]!;
        const focus = exchange.focus === channel + 1;
        const nearNet = channel === 4;
        const amplitude = focus ? 0.34 : nearNet ? 0.08 : 0.035;
        for (let offset = 0; offset < length; offset += 1) {
          const age = offset / SAMPLE_RATE;
          const envelope = Math.exp(-age / 0.028);
          const click = (buffer.random() * 2 - 1) * 0.75;
          const body = Math.sin(TAU * (880 + channel * 37) * age + channel) * 0.34;
          const index = (start + offset) % buffer.data.length;
          buffer.data[index] = (buffer.data[index] ?? 0) + (click + body) * amplitude * envelope;
        }
      }
    }
  }

  let peak = 0;
  for (const { data } of buffers) {
    for (let index = 0; index < data.length; index += 1) {
      const value = Math.abs(data[index] ?? 0);
      if (value > peak) peak = value;
    }
  }
  const scale = peak > 0.86 ? 0.86 / peak : 1;
  const fadeFrames = Math.floor(0.018 * SAMPLE_RATE);
  for (const { data } of buffers) {
    for (let index = 0; index < data.length; index += 1) {
      const fadeIn = Math.min(1, index / fadeFrames);
      const fadeOut = Math.min(1, (data.length - 1 - index) / fadeFrames);
      data[index] = (data[index] ?? 0) * scale * Math.min(fadeIn, fadeOut);
    }
  }
  return buffers.map(({ data }) => data);
}

export class AudioHub {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private analysers: AnalyserNode[] = [];
  private channelData: Float32Array[] | null = null;
  private metricStates: AudioMetricState[] = CAMERAS.map(() => initialMetricState());
  private timeBuffers: Float32Array[] = [];
  private running = false;
  private monitorEnabled = true;
  private generation: Promise<void> | null = null;

  get live(): boolean {
    return this.running && this.context?.state === "running";
  }

  get enabled(): boolean {
    return this.monitorEnabled;
  }

  async start(offsetMs: number): Promise<boolean> {
    if (this.running) {
      await this.context?.resume();
      return this.live;
    }
    try {
      if (!this.context) {
        try {
          this.context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
        } catch {
          this.context = new AudioContext({ latencyHint: "interactive" });
        }
        this.master = this.context.createGain();
        this.master.gain.value = this.monitorEnabled ? 0.22 : 0;
        this.master.connect(this.context.destination);
      }
      await this.context.resume();
      if (!this.generation) {
        this.generation = Promise.resolve().then(() => {
          this.channelData = synthesizeChannels();
        });
      }
      await this.generation;
      if (!this.context || !this.master || !this.channelData) return false;

      const bufferLength = this.channelData[0]?.length ?? 0;
      const offset = ((offsetMs % LOOP_MS) + LOOP_MS) % LOOP_MS;
      for (let index = 0; index < 6; index += 1) {
        const data = this.channelData[index]!;
        const buffer = this.context.createBuffer(1, bufferLength, SAMPLE_RATE);
        buffer.copyToChannel(data, 0);
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.12;
        source.connect(analyser);
        analyser.connect(this.master);
        source.start(this.context.currentTime + 0.06, (offset / 1000) % (LOOP_MS / 1000));
        this.sources.push(source);
        this.analysers.push(analyser);
        this.timeBuffers.push(new Float32Array(analyser.fftSize));
        this.metricStates[index] = initialMetricState();
      }
      this.running = true;
      return true;
    } catch (error) {
      console.warn("Audio could not start; using offline acoustic model.", error);
      return false;
    }
  }

  read(): ChannelMetrics[] | null {
    if (!this.live) return null;
    return this.analysers.map((analyser, index) => {
      const data = this.timeBuffers[index]!;
      analyser.getFloatTimeDomainData(data);
      return analyzeChannel(data, CAMERAS[index]!.id, this.metricStates[index]!);
    });
  }

  setMonitor(enabled: boolean): void {
    this.monitorEnabled = enabled;
    if (!this.master || !this.context) return;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(enabled ? 0.22 : 0, now, 0.04);
  }

  async playEvidence(startMs: number, durationMs: number, onEnded?: () => void): Promise<boolean> {
    if (!this.context) {
      const started = await this.start(startMs);
      if (!started) return false;
    }
    if (!this.context || !this.channelData) return false;
    await this.context.resume();
    const duration = clamp(durationMs, 500, 12_000);
    const frames = Math.floor((duration / 1000) * SAMPLE_RATE);
    const buffer = this.context.createBuffer(2, frames, SAMPLE_RATE);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const pans = [-0.86, -0.18, -0.62, 0.62, 0.18, 0.86];
    const startFrame = Math.floor((((startMs % LOOP_MS) + LOOP_MS) % LOOP_MS) / 1000 * SAMPLE_RATE);
    const fadeFrames = Math.floor(0.04 * SAMPLE_RATE);
    for (let frame = 0; frame < frames; frame += 1) {
      const fade = Math.min(1, frame / fadeFrames, (frames - 1 - frame) / fadeFrames);
      for (let channel = 0; channel < 6; channel += 1) {
        const energy = this.channelData[channel]![(startFrame + frame) % this.channelData[channel]!.length] ?? 0;
        const pan = pans[channel] ?? 0;
        const leftGain = Math.sqrt((1 - pan) / 2);
        const rightGain = Math.sqrt((1 + pan) / 2);
        left[frame] = (left[frame] ?? 0) + energy * leftGain * fade;
        right[frame] = (right[frame] ?? 0) + energy * rightGain * fade;
      }
    }
    let peak = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      peak = Math.max(peak, Math.abs(left[frame] ?? 0), Math.abs(right[frame] ?? 0));
    }
    const normalize = peak > 0.82 ? 0.82 / peak : 1;
    for (let frame = 0; frame < frames; frame += 1) {
      left[frame] = (left[frame] ?? 0) * normalize;
      right[frame] = (right[frame] ?? 0) * normalize;
    }
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    gain.gain.value = 0.9;
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(this.context.destination);
    source.onended = () => {
      gain.disconnect();
      source.disconnect();
      onEnded?.();
    };
    source.start();
    return true;
  }

  close(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.sources = [];
    this.analysers = [];
    this.running = false;
    void this.context?.close();
    this.context = null;
  }
}
