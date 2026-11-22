// 剪辑方案预览：WebCodecs 解码 -> Canvas 渲染，WebAudio 作主时钟保证音画同步。
import { sampleData, type Movie, type Track } from "../core/mp4/demux.ts";
import type { CutPlan } from "../core/edit/plan.ts";

interface QueuedFrame {
  outT: number; // 输出时间轴（秒）
  dur: number;
  frame: VideoFrame;
}

export class PlanPlayer {
  private ctx = new AudioContext();
  private canvas: HTMLCanvasElement;
  private g2d: CanvasRenderingContext2D;
  private movie: Movie;
  private vt: Track;
  private at: Track | null;
  private plan: CutPlan | null = null;
  private segOutBase: number[] = []; // 每段在输出时间轴的起点
  private videoDec: VideoDecoder | null = null;
  private audioDec: AudioDecoder | null = null;
  private queue: QueuedFrame[] = [];
  private gen = 0; // 代际计数：seek/pause 作废旧管线
  private playing = false;
  private startCtx = 0; // 管线启动时的 ctx 时间
  private startOutT = 0; // 管线启动时的输出时间
  private raf = 0;
  onTime: (t: number, duration: number) => void = () => {};
  onEnded: () => void = () => {};

  constructor(movie: Movie, canvas: HTMLCanvasElement) {
    this.movie = movie;
    this.canvas = canvas;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("canvas 2d 不可用");
    this.g2d = g;
    const vt = movie.tracks.find((t) => t.kind === "video");
    if (!vt) throw new Error("无视频轨");
    this.vt = vt;
    this.at = movie.tracks.find((t) => t.kind === "audio") ?? null;
    canvas.width = vt.width || 960;
    canvas.height = vt.height || 540;
  }

  get duration(): number {
    return this.plan ? this.plan.finalDuration : 0;
  }

  setPlan(plan: CutPlan): void {
    this.plan = plan;
    this.segOutBase = [];
    let acc = 0;
    for (const seg of plan.segments) {
      this.segOutBase.push(acc);
      if (!seg.dropped && seg.mode !== "pending") acc += seg.videoDurSec;
    }
  }

  playhead(): number {
    if (!this.playing) return this.startOutT;
    return Math.min(this.startOutT + (this.ctx.currentTime - this.startCtx), this.duration);
  }

  async play(): Promise<void> {
    if (!this.plan) return;
    if (this.playing) return;
    if (this.playhead() >= this.duration - 1e-3) this.startOutT = 0;
    this.playing = true;
    await this.ctx.resume();
    this.startPipeline(this.startOutT);
  }

  async pause(): Promise<void> {
    this.startOutT = this.playhead();
    this.playing = false;
    this.gen++;
    await this.ctx.suspend();
  }

  seek(t: number): void {
    const wasPlaying = this.playing;
    this.gen++;
    this.startOutT = Math.max(0, Math.min(t, this.duration));
    this.clearQueue();
    if (wasPlaying) this.startPipeline(this.startOutT);
    else this.startPipeline(this.startOutT, true);
  }

  dispose(): void {
    this.gen++;
    cancelAnimationFrame(this.raf);
    this.clearQueue();
    try { this.videoDec?.close(); } catch { /* ignore */ }
    try { this.audioDec?.close(); } catch { /* ignore */ }
    void this.ctx.close();
  }

  private clearQueue(): void {
    for (const q of this.queue) q.frame.close();
    this.queue = [];
  }

  private ensureDecoders(): void {
    if (!this.videoDec || this.videoDec.state === "closed") {
      this.videoDec = new VideoDecoder({
        output: (f) => this.onFrame(f),
        error: (e) => console.error("video decoder", e),
      });
    }
    this.videoDec.configure({ codec: this.vt.codec, description: this.vt.description ?? undefined });
    if (this.at) {
      if (!this.audioDec || this.audioDec.state === "closed") {
        this.audioDec = new AudioDecoder({
          output: (d) => this.onAudio(d),
          error: (e) => console.error("audio decoder", e),
        });
      }
      this.audioDec.configure({
        codec: this.at.codec,
        description: this.at.description ?? undefined,
        sampleRate: this.at.sampleRate || undefined,
        numberOfChannels: this.at.channelCount || undefined,
      });
    }
  }

  // ---- 解码管线 ----
  private curSegStart = 0;
  private curOutBase = 0;
  private audioSeg: { sampleRate: number; channels: Float32Array[][] } | null = null;
  private feedDone = false;

  private onFrame(f: VideoFrame): void {
    const ctsSec = f.timestamp / 1e6;
    if (ctsSec < this.curSegStart - 1e-4) {
      f.close(); // 段首关键帧之前的解码前置帧，不展示
      return;
    }
    const outT = this.curOutBase + (ctsSec - this.curSegStart);
    this.queue.push({ outT, dur: (f.duration ?? 33333) / 1e6, frame: f });
  }

  private onAudio(d: AudioData): void {
    if (!this.audioSeg) {
      d.close();
      return;
    }
    const n = d.numberOfFrames;
    const chs: Float32Array[] = [];
    for (let c = 0; c < d.numberOfChannels; c++) {
      const plane = new Float32Array(n);
      d.copyTo(plane, { planeIndex: c, format: "f32-planar" });
      chs.push(plane);
    }
    this.audioSeg.channels.push(chs);
    this.audioSeg.sampleRate = d.sampleRate;
    d.close();
  }

  private finishAudioSegment(outBase: number, myGen: number): void {
    const seg = this.audioSeg;
    this.audioSeg = null;
    if (!seg || seg.channels.length === 0 || myGen !== this.gen) return;
    const total = seg.channels.reduce((a, c) => a + (c[0]?.length ?? 0), 0);
    if (total === 0) return;
    const nCh = seg.channels[0].length;
    const buf = new AudioBuffer({ numberOfChannels: nCh, length: total, sampleRate: seg.sampleRate });
    for (let c = 0; c < nCh; c++) {
      const dst = buf.getChannelData(c);
      let off = 0;
      for (const chunk of seg.channels) {
        dst.set(chunk[c], off);
        off += chunk[c].length;
      }
    }
    if (!this.playing) return; // 暂停中不排程
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const at = this.startCtx + (outBase - this.startOutT);
    src.start(Math.max(at, this.ctx.currentTime));
  }

  private async startPipeline(fromT: number, pausedShot = false): Promise<void> {
    if (!this.plan) return;
    const myGen = ++this.gen;
    this.ensureDecoders();
    this.feedDone = false;
    this.startCtx = this.ctx.currentTime + 0.05;
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const vDec = this.videoDec!;
    const aDec = this.audioDec;
    try {
      for (let i = 0; i < this.plan.segments.length; i++) {
        const seg = this.plan.segments[i];
        if (seg.dropped || seg.mode === "pending") continue;
        const base = this.segOutBase[i];
        if (base + seg.videoDurSec <= fromT + 1e-6) continue;
        this.curSegStart = seg.start;
        this.curOutBase = base;
        // 视频：从段首关键帧（或更早的最近关键帧）开始送
        let from = seg.videoFrom;
        while (from > 0 && !this.vt.samples[from].keyframe) from--;
        for (let k = from; k < seg.videoTo; k++) {
          if (myGen !== this.gen) return;
          while (this.queue.length > 12) {
            await sleep(30);
            if (myGen !== this.gen) return;
          }
          const s = this.vt.samples[k];
          vDec.decode(
            new EncodedVideoChunk({
              type: s.keyframe ? "key" : "delta",
              timestamp: Math.round((s.cts / this.vt.timescale) * 1e6),
              duration: Math.round((s.duration / this.vt.timescale) * 1e6),
              data: sampleData(this.movie, s) as BufferSource,
            }),
          );
        }
        await vDec.flush();
        // 音频：整段解码后一次性排程
        if (aDec && this.at && seg.audioTo > seg.audioFrom) {
          this.audioSeg = { sampleRate: this.at.sampleRate || 48000, channels: [] };
          for (let k = seg.audioFrom; k < seg.audioTo; k++) {
            if (myGen !== this.gen) return;
            const s = this.at.samples[k];
            aDec.decode(
              new EncodedAudioChunk({
                type: "key",
                timestamp: Math.round((s.cts / this.at.timescale) * 1e6),
                duration: Math.round((s.duration / this.at.timescale) * 1e6),
                data: sampleData(this.movie, s) as BufferSource,
              }),
            );
          }
          await aDec.flush();
          this.finishAudioSegment(base, myGen);
        }
        if (pausedShot) break; // 暂停态 seek：只解一段供静帧
      }
    } catch (e) {
      if (myGen === this.gen) console.error(e);
      return;
    }
    if (myGen === this.gen) this.feedDone = true;
  }

  startRenderLoop(): void {
    const tick = (): void => {
      const t = this.playhead();
      while (this.queue.length >= 2 && this.queue[1].outT <= t) {
        this.queue[0].frame.close();
        this.queue.shift();
      }
      const top = this.queue[0];
      if (top && top.outT <= t + 1e-6) {
        this.g2d.drawImage(top.frame, 0, 0, this.canvas.width, this.canvas.height);
      }
      this.onTime(t, this.duration);
      if (this.playing && this.feedDone && t >= this.duration - 1e-3) {
        this.playing = false;
        this.startOutT = this.duration;
        void this.ctx.suspend();
        this.onEnded();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
