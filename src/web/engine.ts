import { buildDialogueFirstMix, DEFAULT_MIX_OPTIONS, type MixOptions } from '../core/mix.ts';
import type { PcmBuffer, TrackKind } from '../core/types.ts';

/** A decoded track held in memory for instant routing. */
export interface WebTrack {
  fileName: string;
  kind: TrackKind;
  buffer: AudioBuffer;
}

export type ListenMode = 'solo' | 'raw' | 'ducked';

interface Routing {
  source: AudioBufferSourceNode;
  /** Per-track trim gain (fader + mute). */
  trim: GainNode;
  /** Mode gain: active/inactive in the current language/mode. */
  modeGain: GainNode;
  /** Ducking gain driven by the precomputed curve (music bed only). */
  duckGain: GainNode;
}

/**
 * Persistent playback engine. Source nodes are created only on load/seek;
 * switching language or listening mode changes gain automation exclusively,
 * so the <video> element and AudioContext clock never restart.
 */
export class PlaybackEngine {
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  private routes = new Map<string, Routing>();
  private buffers = new Map<string, AudioBuffer>();
  private kinds = new Map<string, TrackKind>();
  private duckCurves = new Map<TrackKind, number[]>();
  private duckWindowSec = DEFAULT_MIX_OPTIONS.windowMs / 1000;
  private mixOptions: MixOptions = { ...DEFAULT_MIX_OPTIONS };
  private language: TrackKind = 'dialogue-zh';
  private mode: ListenMode = 'ducked';
  private soloFile: string | null = null;
  private playing = false;
  /** Media offset (seconds) corresponding to context time zero. */
  private baseOffset = 0;
  private baseContextTime = 0;

  constructor() {
    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.connect(this.context.destination);
  }

  /** Decode inputs, precompute both ducking curves, and build the graph. */
  load(webTracks: WebTrack[]): void {
    this.teardownSources();
    this.buffers.clear();
    this.kinds.clear();
    this.duckCurves.clear();

    const pcmInputs: { kind: TrackKind; pcm: PcmBuffer }[] = webTracks.map((track) => ({
      kind: track.kind,
      pcm: this.bufferToPcm(track.buffer),
    }));
    for (const language of ['dialogue-zh', 'dialogue-en'] as TrackKind[]) {
      const result = buildDialogueFirstMix(pcmInputs, language, this.mixOptions);
      this.duckCurves.set(language, result.duckCurve);
      this.duckWindowSec = result.windowSec;
    }

    for (const track of webTracks) {
      this.buffers.set(track.fileName, track.buffer);
      this.kinds.set(track.fileName, track.kind);
    }
    this.baseOffset = 0;
    this.buildGraph(0);
  }

  private bufferToPcm(buffer: AudioBuffer): PcmBuffer {
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      channels.push(buffer.getChannelData(ch).slice());
    }
    return { sampleRate: buffer.sampleRate, channels };
  }

  /** Create the gain chain and source nodes starting at the given offset. */
  private buildGraph(offsetSec: number): void {
    for (const [fileName, buffer] of this.buffers) {
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      const trim = this.context.createGain();
      const modeGain = this.context.createGain();
      const duckGain = this.context.createGain();
      source.connect(trim);
      trim.connect(modeGain);
      modeGain.connect(duckGain);
      duckGain.connect(this.analyser);
      source.start(0, Math.min(offsetSec, buffer.duration));
      this.routes.set(fileName, { source, trim, modeGain, duckGain });
    }
    this.applyRouting();
  }

  private teardownSources(): void {
    for (const route of this.routes.values()) {
      try {
        route.source.stop();
      } catch {
        /* already stopped */
      }
      route.source.disconnect();
    }
    this.routes.clear();
  }

  private duckAt(sec: number, language: TrackKind): number {
    const curve = this.duckCurves.get(language);
    if (!curve) return 1;
    return curve[Math.min(curve.length - 1, Math.max(0, Math.floor(sec / this.duckWindowSec)))] ?? 1;
  }

  /** Recompute gain nodes for the current mode, language and solo choice. */
  private applyRouting(): void {
    const now = this.context.currentTime;
    const position = this.getCurrentTime();
    for (const [fileName, route] of this.routes) {
      const kind = this.kinds.get(fileName) ?? 'unknown';
      let active: boolean;
      if (this.mode === 'solo') {
        active = fileName === this.soloFile;
      } else {
        active = kind === 'music' || kind === this.language;
      }
      route.modeGain.gain.cancelScheduledValues(now);
      route.modeGain.gain.setTargetAtTime(active ? 1 : 0, now, 0.02);

      route.duckGain.gain.cancelScheduledValues(now);
      if (this.mode === 'ducked' && kind === 'music') {
        const duration = route.source.buffer?.duration ?? 0;
        for (let sec = position; sec < duration; sec += this.duckWindowSec) {
          const when = now + Math.max(0, sec - position);
          route.duckGain.gain.setValueAtTime(this.duckAt(sec, this.language), when);
        }
      } else {
        route.duckGain.gain.setTargetAtTime(1, now, 0.02);
      }
    }
  }

  /** Switch spoken language without touching sources or the video element. */
  setLanguage(language: TrackKind): void {
    if (language === this.language) return;
    this.language = language;
    this.applyRouting();
  }

  setMode(mode: ListenMode): void {
    this.mode = mode;
    this.applyRouting();
  }

  /** Solo a single track for isolated audition, or clear back to the mix. */
  setSolo(fileName: string | null): void {
    this.soloFile = fileName;
    this.mode = fileName ? 'solo' : 'ducked';
    this.applyRouting();
  }

  setTrim(fileName: string, linearGain: number, muted: boolean): void {
    const route = this.routes.get(fileName);
    if (route) route.trim.gain.setTargetAtTime(muted ? 0 : linearGain, this.context.currentTime, 0.01);
  }

  async play(): Promise<void> {
    await this.context.resume();
    this.playing = true;
    this.baseContextTime = this.context.currentTime;
  }

  /** Pause by suspending the clock; sources keep their position automatically. */
  async pause(): Promise<void> {
    this.baseOffset = this.getCurrentTime();
    await this.context.suspend();
    this.playing = false;
  }

  /** Seek all sources to one offset and resync the context clock. */
  seek(offsetSec: number): void {
    this.teardownSources();
    this.baseOffset = offsetSec;
    this.buildGraph(offsetSec);
    this.baseContextTime = this.context.currentTime;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  getCurrentTime(): number {
    if (!this.playing || this.context.state === 'suspended') return this.baseOffset;
    return this.baseOffset + (this.context.currentTime - this.baseContextTime);
  }

  getLanguage(): TrackKind {
    return this.language;
  }

  getMode(): ListenMode {
    return this.mode;
  }

  getTrackNames(): string[] {
    return [...this.buffers.keys()];
  }
}
