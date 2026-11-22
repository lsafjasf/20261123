// Reverse playback engine. Audio (reversed PCM) is the master clock via
// AudioContext.currentTime; video frames are drawn on a Canvas in reversed
// order on the same timeline. The playhead persists across pause/resume so
// already-played material is never repeated.
import { frameIndexAt, type ReversePlan } from "../shared/timeline.ts";

export interface PlayerCallbacks {
  onTick?: (position: number, total: number) => void;
  onEnded?: () => void;
}

export class ReversePlayer {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private raf = 0;
  private startCtxTime = 0;   // ctx.currentTime when current run started
  private startPosition = 0;  // output-timeline position at run start
  private position = 0;       // persisted playhead, seconds
  private playing = false;
  private lastFrameIdx = -1;
  private measuredErrMs: number[] = [];
  private canvasCtx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private plan: ReversePlan;
  private outputFrames: VideoFrame[];
  private sampleRate: number;
  private cb: PlayerCallbacks;
  private pcmReversed: Float32Array[];

  constructor(
    canvas: HTMLCanvasElement,
    plan: ReversePlan,
    outputFrames: VideoFrame[], // output order
    pcmReversed: Float32Array[],
    sampleRate: number,
    cb: PlayerCallbacks = {},
  ) {
    this.canvas = canvas;
    this.plan = plan;
    this.outputFrames = outputFrames;
    this.sampleRate = sampleRate;
    this.cb = cb;
    this.canvasCtx = canvas.getContext("2d")!;
    this.pcmReversed = pcmReversed;
    this.drawFrame(0);
  }

  private ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate });
      this.buffer = this.ctx.createBuffer(
        Math.max(1, this.pcmReversed.length),
        this.pcmReversed[0]?.length ?? 1,
        this.sampleRate,
      );
      this.pcmReversed.forEach((ch, i) => this.buffer!.copyToChannel(ch, i));
    }
  }

  get total(): number { return this.plan.totalDuration; }
  get isPlaying(): boolean { return this.playing; }
  get ended(): boolean { return !this.playing && this.position >= this.total - 1e-3; }

  currentPosition(): number {
    if (!this.playing || !this.ctx) return this.position;
    return Math.min(this.total, this.startPosition + (this.ctx.currentTime - this.startCtxTime));
  }

  play() {
    if (this.playing || this.ended) return;
    this.ensureContext();
    const ctx = this.ctx!;
    if (ctx.state === "suspended") void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(ctx.destination);
    this.startPosition = this.position; // resume from playhead, never restart
    this.startCtxTime = ctx.currentTime + 0.05;
    src.start(this.startCtxTime, this.startPosition);
    src.onended = () => {
      if (!this.playing) return; // manual pause already handled
      this.playing = false;
      this.position = this.total;
      cancelAnimationFrame(this.raf);
      this.cb.onTick?.(this.position, this.total);
      this.cb.onEnded?.();
    };
    this.source = src;
    this.playing = true;
    this.lastFrameIdx = -1;
    this.loop();
  }

  pause() {
    if (!this.playing) return;
    this.position = this.currentPosition(); // freeze playhead
    this.playing = false;
    try { this.source?.stop(); } catch { /* already stopped */ }
    this.source = null;
    cancelAnimationFrame(this.raf);
    this.cb.onTick?.(this.position, this.total);
  }

  restart() {
    this.pause();
    this.position = 0;
    this.measuredErrMs = [];
    this.lastFrameIdx = -1;
    this.play();
  }

  private loop = () => {
    if (!this.playing) return;
    const pos = this.currentPosition();
    const idx = frameIndexAt(this.plan, pos);
    if (idx < this.outputFrames.length && idx !== this.lastFrameIdx) {
      this.drawFrame(idx);
      // measured A/V skew: how far the audio clock had advanced past this
      // frame's scheduled output time when it hit the screen
      const err = (pos - this.plan.frames[idx].outputTime) * 1000;
      this.measuredErrMs.push(err);
      this.lastFrameIdx = idx;
    }
    this.cb.onTick?.(pos, this.total);
    this.raf = requestAnimationFrame(this.loop);
  };

  private drawFrame(idx: number) {
    const f = this.outputFrames[idx];
    if (!f) return;
    this.canvasCtx.drawImage(f, 0, 0, this.canvas.width, this.canvas.height);
  }

  measuredAvError() {
    const a = this.measuredErrMs;
    if (!a.length) return { count: 0, maxAbsMs: 0, meanAbsMs: 0 };
    const abs = a.map(Math.abs);
    return {
      count: a.length,
      maxAbsMs: Math.max(...abs),
      meanAbsMs: abs.reduce((x, y) => x + y, 0) / abs.length,
    };
  }

  dispose() {
    this.pause();
    for (const f of this.outputFrames) f.close();
    void this.ctx?.close();
  }
}
