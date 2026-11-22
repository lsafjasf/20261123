import type { AudioTrack, ByteRangeReader } from "./mp4.ts";
import { readSampleData } from "./mp4.ts";
import type { FrameTimeline } from "./timeline.ts";

export type AudioState = "off" | "ready" | "playing" | "unsupported" | "error";

export class AudioEngine {
  private readonly source: ByteRangeReader;
  private readonly tracks: AudioTrack[];
  private readonly timeline: FrameTimeline;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private track: AudioTrack | null;
  private generation = 0;
  private playing = false;
  private anchorTimeline = 0;
  private anchorContext = 0;
  private nextWindowStart = 0;
  private pumpTimer = 0;
  private pumping = false;
  private nodes = new Set<AudioBufferSourceNode>();
  private volume = 0.8;
  private muted = false;
  private stateValue: AudioState = "off";
  private lastError = "";

  constructor(source: ByteRangeReader, tracks: AudioTrack[], timeline: FrameTimeline) {
    this.source = source;
    this.tracks = tracks;
    this.timeline = timeline;
    this.track = tracks[0] ?? null;
    if (typeof AudioDecoder === "undefined") this.stateValue = "unsupported";
  }

  get state(): AudioState {
    return this.stateValue;
  }

  get error(): string {
    return this.lastError;
  }

  get currentTrack(): AudioTrack | null {
    return this.track;
  }

  get trackList(): AudioTrack[] {
    return this.tracks;
  }

  async selectTrack(trackId: number, timelineSeconds: number): Promise<void> {
    const next = this.tracks.find((candidate) => candidate.trackId === trackId) ?? this.tracks[0] ?? null;
    if (!next || next === this.track) {
      if (next && this.playing) await this.play(timelineSeconds);
      return;
    }
    const wasPlaying = this.playing;
    this.stopSources();
    this.track = next;
    this.stateValue = this.track ? "ready" : "off";
    if (wasPlaying) await this.play(timelineSeconds);
  }

  async play(timelineSeconds: number): Promise<void> {
    if (!this.track) {
      this.stateValue = "off";
      return;
    }
    if (typeof AudioDecoder === "undefined") {
      this.stateValue = "unsupported";
      return;
    }
    const context = this.ensureContext();
    await context.resume();
    const generation = ++this.generation;
    this.stopSources();
    this.playing = true;
    this.anchorTimeline = Math.max(0, timelineSeconds);
    this.anchorContext = context.currentTime + 0.06;
    this.nextWindowStart = this.anchorTimeline;
    this.stateValue = "playing";
    this.lastError = "";
    this.pumpTimer = window.setInterval(() => this.pump(generation), 180);
    void this.pump(generation);
  }

  pause(): void {
    this.playing = false;
    this.generation += 1;
    window.clearInterval(this.pumpTimer);
    this.pumpTimer = 0;
    this.stopSources();
    if (this.track && typeof AudioDecoder !== "undefined") this.stateValue = "ready";
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    this.applyGain();
  }

  setMuted(value: boolean): void {
    this.muted = value;
    this.applyGain();
  }

  dispose(): void {
    this.pause();
    this.generation += 1;
    void this.context?.close();
    this.context = null;
    this.gain = null;
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.applyGain();
    }
    return this.context;
  }

  private applyGain(): void {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  private async pump(generation: number): Promise<void> {
    if (!this.playing || generation !== this.generation || this.pumping || !this.track) return;
    const context = this.context;
    if (!context) return;
    const playback = this.anchorTimeline + (context.currentTime - this.anchorContext);
    if (this.nextWindowStart > playback + 2.4) return;
    if (this.nextWindowStart >= this.timeline.durationSeconds) return;
    this.pumping = true;
    try {
      const end = await this.decodeWindow(this.nextWindowStart, generation);
      if (generation === this.generation && end !== null) {
        this.nextWindowStart = Math.max(this.nextWindowStart + 0.5, end);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async decodeWindow(startSeconds: number, generation: number): Promise<number | null> {
    const track = this.track;
    if (!track) return null;
    const samples = track.samples;
    const times = samples.map((sample) => sample.ctsTicks / track.timescale - this.timeline.originSeconds);
    let low = 0;
    let high = times.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (times[middle] <= startSeconds) low = middle + 1;
      else high = middle - 1;
    }
    const first = Math.max(0, high);
    const windowEnd = startSeconds + 1.8;
    let last = first;
    while (last + 1 < samples.length && times[last + 1] < windowEnd) last += 1;
    const support = await AudioDecoder.isConfigSupported({
      codec: track.codec,
      sampleRate: track.sampleRate,
      numberOfChannels: track.channels,
      description: track.description
    });
    if (!support.supported) {
      this.stateValue = "unsupported";
      this.lastError = `WebAudio 不支持 ${track.codec}`;
      return null;
    }

    const chunks: EncodedAudioChunk[] = [];
    for (let index = first; index <= last; index += 1) {
      const sample = samples[index];
      const bytes = await readSampleData(this.source, track, sample);
      if (generation !== this.generation || !this.playing) return null;
      chunks.push(new EncodedAudioChunk({
        type: "key",
        timestamp: Math.max(0, Math.round(times[index] * 1_000_000)),
        duration: Math.round((sample.durationTicks / track.timescale) * 1_000_000),
        data: bytes
      }));
    }
    if (chunks.length === 0) return windowEnd;

    const decoded: AudioData[] = [];
    let decoderError: Error | null = null;
    const decoder = new AudioDecoder({
      output: (data) => {
        decoded.push(data);
      },
      error: (error) => {
        decoderError = new Error(error.message);
      }
    });
    try {
      decoder.configure(support.config ?? {
        codec: track.codec,
        sampleRate: track.sampleRate,
        numberOfChannels: track.channels,
        description: track.description
      });
      for (const chunk of chunks) decoder.decode(chunk);
      await decoder.flush();
    } finally {
      if (decoder.state !== "closed") decoder.close();
    }
    if (decoderError) throw decoderError;
    if (generation !== this.generation || !this.playing) {
      for (const data of decoded) data.close();
      return null;
    }
    for (const data of decoded) {
      this.scheduleAudioData(data);
      data.close();
    }
    return times[last] + samples[last].durationTicks / track.timescale;
  }

  private scheduleAudioData(data: AudioData): void {
    const context = this.context;
    const gain = this.gain;
    if (!context || !gain) return;
    const frames = data.numberOfFrames;
    const sampleRate = data.sampleRate;
    if (frames <= 0 || sampleRate <= 0) return;
    const audioStart = data.timestamp / 1_000_000;
    const duration = frames / sampleRate;
    const desired = this.anchorContext + (audioStart - this.anchorTimeline);
    const now = context.currentTime;
    const skipped = Math.max(0, now - desired);
    if (skipped >= duration) return;
    const buffer = context.createBuffer(data.numberOfChannels, frames, sampleRate);
    for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
      const plane = new Float32Array(frames);
      data.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
      buffer.copyToChannel(plane, channel);
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.onended = () => {
      this.nodes.delete(source);
      source.disconnect();
    };
    this.nodes.add(source);
    source.start(Math.max(now, desired), skipped);
  }

  private stopSources(): void {
    for (const source of this.nodes) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Source may already have ended.
      }
      source.disconnect();
    }
    this.nodes.clear();
  }
}
