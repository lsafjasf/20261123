export class PreviewClock {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private audio: HTMLAudioElement;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private startedAt = 0;
  private startPosition = 0;
  private playing = false;
  private rate = 1;
  private volume = 0.8;

  constructor(audio: HTMLAudioElement) {
    this.audio = audio;
  }

  get running(): boolean {
    return this.playing;
  }

  get audioContext(): AudioContext | null {
    return this.context;
  }

  async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
      this.sourceNode = this.context.createMediaElementSource(this.audio);
      this.sourceNode.connect(this.gain);
    }
    if (this.context.state === "suspended") await this.context.resume();
  }

  setMedia(url: string | null): void {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (url) {
      this.audio.src = url;
      this.audio.load();
    }
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.gain && this.context) {
      this.gain.gain.setTargetAtTime(
        this.volume,
        this.context.currentTime,
        0.015
      );
    }
  }

  async play(positionSec: number, rate = 1): Promise<void> {
    await this.unlock();
    this.rate = rate;
    this.startPosition = positionSec;
    this.startedAt = this.context?.currentTime ?? performance.now() / 1000;
    this.playing = true;
    if (this.audio.src) {
      this.audio.currentTime = Math.max(0, positionSec);
      this.audio.playbackRate = rate;
      await this.audio.play().catch(() => undefined);
    }
  }

  pause(positionSec: number): void {
    this.startPosition = positionSec;
    this.playing = false;
    this.audio.pause();
  }

  seek(positionSec: number): void {
    this.startPosition = positionSec;
    this.startedAt = this.context?.currentTime ?? performance.now() / 1000;
    if (this.playing && this.audio.src) {
      this.audio.currentTime = Math.max(0, positionSec);
    }
  }

  position(): number {
    if (!this.playing) return this.startPosition;
    const now = this.context?.currentTime ?? performance.now() / 1000;
    return this.startPosition + (now - this.startedAt) * this.rate;
  }

  setRate(rate: number): void {
    const current = this.position();
    this.rate = rate;
    this.startPosition = current;
    this.startedAt = this.context?.currentTime ?? performance.now() / 1000;
    this.audio.playbackRate = rate;
  }
}
