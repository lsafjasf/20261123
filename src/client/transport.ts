// Frame-accurate transport. While playing, the AudioContext clock is the
// single master clock; the current frame is always derived from it via
// exact integer math, so picture and scheduled audio cannot drift apart.

import { frameToSample, sampleToFrame, type FrameRate } from '../shared/timebase.ts';

export class Transport {
  rate: FrameRate;
  readonly sampleRate: number;
  playing = false;
  loopEndFrame: number | null = null;
  onchange: (() => void) | null = null;

  private ctx: AudioContext;
  private pausedFrame = 0;
  private anchorCtxTime = 0; // ctx.currentTime at anchor
  private anchorSample = 0; // project sample index at anchor

  constructor(ctx: AudioContext, rate: FrameRate) {
    this.ctx = ctx;
    this.rate = rate;
    this.sampleRate = ctx.sampleRate;
  }

  private emit(): void {
    this.onchange?.();
  }

  /** Current position as an exact project sample index. */
  currentSample(): number {
    if (!this.playing) return frameToSample(this.pausedFrame, this.rate, this.sampleRate);
    return this.anchorSample + Math.round((this.ctx.currentTime - this.anchorCtxTime) * this.sampleRate);
  }

  currentFrame(): number {
    return sampleToFrame(this.currentSample(), this.rate, this.sampleRate);
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.anchorSample = frameToSample(this.pausedFrame, this.rate, this.sampleRate);
    this.anchorCtxTime = this.ctx.currentTime;
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedFrame = this.currentFrame();
    this.playing = false;
    this.emit();
  }

  stop(): void {
    this.playing = false;
    this.pausedFrame = 0;
    this.emit();
  }

  seek(frame: number): void {
    const f = Math.max(0, Math.round(frame));
    if (this.playing) {
      this.anchorSample = frameToSample(f, this.rate, this.sampleRate);
      this.anchorCtxTime = this.ctx.currentTime;
    }
    this.pausedFrame = f;
    this.emit();
  }

  step(deltaFrames: number): void {
    this.seek(this.currentFrame() + deltaFrames);
  }

  /** Switch frame rate; the timeline is re-anchored so playback continues smoothly. */
  setRate(rate: FrameRate): void {
    const wasPlaying = this.playing;
    const frame = this.currentFrame();
    this.playing = false;
    this.rate = rate;
    this.pausedFrame = frame;
    if (wasPlaying) this.play();
    this.emit();
  }

  /** Seconds from now until a project sample is reached (for scheduling). */
  secondsUntilSample(sample: number): number {
    if (!this.playing) return Infinity;
    return (sample - this.anchorSample) / this.sampleRate - (this.ctx.currentTime - this.anchorCtxTime);
  }

  /** AudioContext time at which a project sample plays. */
  contextTimeForSample(sample: number): number {
    return this.anchorCtxTime + (sample - this.anchorSample) / this.sampleRate;
  }
}
