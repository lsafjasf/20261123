import type { AudioTrack } from "../shared/types.ts";

export type PlayMode = "reference" | "recorded" | "aligned" | "overlay";

export class Player {
  private context: AudioContext;
  private buffers = new Map<string, AudioBuffer>();
  private active: AudioBufferSourceNode[] = [];
  private loop = false;
  private loopStart = 0;
  private loopEnd = 0;
  private startedAt = 0;
  private startOffset = 0;
  private mode: PlayMode = "reference";
  private timer: number | null = null;
  readonly onTime: (seconds: number) => void;

  constructor(onTime: (seconds: number) => void) {
    this.context = new AudioContext();
    this.onTime = onTime;
  }

  async addTrack(key: string, track: AudioTrack): Promise<void> {
    const buffer = this.context.createBuffer(track.channels.length, track.channels[0]!.length, track.sampleRate);
    for (let ch = 0; ch < track.channels.length; ch++) buffer.copyToChannel(track.channels[ch]!, ch);
    this.buffers.set(key, buffer);
  }

  setMode(mode: PlayMode): void {
    this.mode = mode;
    if (this.isPlaying()) {
      const position = this.position();
      this.stopSources();
      this.start(position);
    }
  }

  setLoopRange(start: number, end: number): void {
    this.loop = true;
    this.loopStart = start;
    this.loopEnd = end;
  }

  clearLoop(): void {
    this.loop = false;
  }

  async resume(): Promise<void> {
    await this.context.resume();
  }

  play(offset = 0): void {
    this.stopSources();
    this.start(offset);
  }

  private start(offset: number): void {
    const playOffset = this.loop ? Math.min(Math.max(offset, this.loopStart), this.loopEnd - 0.05) : offset;
    this.startOffset = playOffset;
    this.startedAt = this.context.currentTime;
    if (this.mode === "overlay") {
      this.startSource("reference", playOffset, 0.5);
      this.startSource("aligned", playOffset, 0.5);
    } else {
      this.startSource(this.mode, playOffset, 1);
    }
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), 50);
  }

  private startSource(key: string, offset: number, gainValue: number): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    gain.gain.value = gainValue;
    source.buffer = buffer;
    source.connect(gain).connect(this.context.destination);
    source.start(0, offset);
    source.onended = () => {
      this.active = this.active.filter((item) => item !== source);
      if (this.loop && this.active.length === 0 && this.position() >= this.loopEnd - 0.02) {
        this.play(this.loopStart);
      } else if (!this.loop && this.active.length === 0 && this.timer !== null) {
        window.clearInterval(this.timer);
        this.timer = null;
        this.startOffset = 0;
        this.onTime(0);
      }
    };
    this.active.push(source);
  }

  private tick(): void {
    const position = this.position();
    if (this.loop && position >= this.loopEnd) {
      this.play(this.loopStart);
      return;
    }
    this.onTime(position);
  }

  position(): number {
    if (!this.active.length) return this.startOffset;
    return this.startOffset + (this.context.currentTime - this.startedAt);
  }

  isPlaying(): boolean {
    return this.active.length > 0;
  }

  stop(): void {
    this.stopSources();
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private stopSources(): void {
    for (const source of this.active) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.active = [];
  }
}
