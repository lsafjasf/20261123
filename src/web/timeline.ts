import type { AdSegment, AnalysisResult } from '../shared/types.ts';
import { formatTime } from '../shared/types.ts';

interface TimelineOptions {
  onSeek(time: number): void;
  onAdSelection(start: number, end: number): void;
}

export class TimelineRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly options: TimelineOptions;
  private result: AnalysisResult | null = null;
  private ads: AdSegment[] = [];
  private currentTime = 0;
  private mode: 'seek' | 'ad' = 'seek';
  private selection: { start: number; end: number } | null = null;
  private dragStart: number | null = null;
  private hoverTime: number | null = null;
  private width = 0;
  private height = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, options: TimelineOptions) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D 不可用');
    this.context = context;
    this.options = options;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (event) => this.pointerDown(event));
    canvas.addEventListener('pointermove', (event) => this.pointerMove(event));
    canvas.addEventListener('pointerup', (event) => this.pointerUp(event));
    canvas.addEventListener('pointercancel', () => this.pointerUp(null));
    canvas.addEventListener('pointerleave', () => {
      this.hoverTime = null;
      this.draw();
    });
  }

  setMode(mode: 'seek' | 'ad'): void {
    this.mode = mode;
    this.canvas.classList.toggle('is-selecting', mode === 'ad');
  }

  setSelection(start: number | null, end: number | null): void {
    this.selection = start !== null && end !== null && end > start ? { start, end } : null;
    this.draw();
  }

  setData(result: AnalysisResult | null, ads: AdSegment[], currentTime: number): void {
    this.result = result;
    this.ads = ads;
    this.currentTime = currentTime;
    this.resize();
  }

  setCurrentTime(time: number): void {
    this.currentTime = time;
    this.draw();
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.draw();
  }

  private plot(): { left: number; right: number; top: number; waveBottom: number; loudTop: number; bottom: number } {
    const left = 54;
    const right = this.width - 18;
    const top = 18;
    const bottom = this.height - 28;
    const split = top + Math.max(62, (bottom - top) * 0.48);
    return { left, right, top, waveBottom: split, loudTop: split + 16, bottom };
  }

  private timeAtX(x: number): number {
    const plot = this.plot();
    const duration = this.result?.metadata.duration || 0;
    if (duration <= 0) return 0;
    return Math.max(0, Math.min(duration, (x - plot.left) / (plot.right - plot.left) * duration));
  }

  private xAtTime(time: number): number {
    const plot = this.plot();
    const duration = this.result?.metadata.duration || 1;
    return plot.left + Math.max(0, Math.min(1, time / duration)) * (plot.right - plot.left);
  }

  private eventX(event: PointerEvent): number {
    return event.clientX - this.canvas.getBoundingClientRect().left;
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.result) return;
    this.canvas.setPointerCapture(event.pointerId);
    const time = this.timeAtX(this.eventX(event));
    if (this.mode === 'ad') {
      this.dragStart = time;
      this.selection = { start: time, end: time };
    } else {
      this.options.onSeek(time);
    }
    this.draw();
  }

  private pointerMove(event: PointerEvent): void {
    if (!this.result) return;
    const x = this.eventX(event);
    this.hoverTime = this.timeAtX(x);
    if (this.dragStart !== null) {
      const time = this.hoverTime;
      this.selection = {
        start: Math.min(this.dragStart, time),
        end: Math.max(this.dragStart, time)
      };
    } else if (event.buttons === 1 && this.mode === 'seek') {
      this.options.onSeek(this.hoverTime);
    }
    this.draw();
  }

  private pointerUp(event: PointerEvent | null): void {
    if (event && this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (this.dragStart === null) return;
    const selection = this.selection;
    this.dragStart = null;
    if (this.mode === 'ad' && selection && selection.end - selection.start >= 0.2) {
      this.options.onAdSelection(selection.start, selection.end);
    } else if (this.mode === 'ad') {
      this.selection = null;
    }
    this.draw();
  }

  private draw(): void {
    const ctx = this.context;
    const plot = this.plot();
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#10161d';
    ctx.fillRect(0, 0, this.width, this.height);
    if (!this.result) {
      ctx.fillStyle = '#637386';
      ctx.font = '13px ui-sans-serif, system-ui';
      ctx.fillText('载入音频后显示波形、响度曲线与广告/问题区间', plot.left, plot.top + 38);
      return;
    }

    this.drawAds(plot);
    this.drawGrid(plot);
    this.drawWaveform(plot);
    this.drawLoudness(plot);
    this.drawProblems(plot);
    this.drawSelectionAndPlayhead(plot);
  }

  private drawAds(plot: ReturnType<TimelineRenderer['plot']>): void {
    const ctx = this.context;
    for (const ad of this.ads) {
      const x1 = this.xAtTime(ad.start);
      const x2 = this.xAtTime(ad.end);
      ctx.fillStyle = 'rgba(244, 168, 77, 0.11)';
      ctx.fillRect(x1, plot.top, x2 - x1, plot.bottom - plot.top);
      ctx.fillStyle = 'rgba(244, 168, 77, 0.8)';
      ctx.fillRect(x1, plot.top, 1, plot.bottom - plot.top);
      ctx.fillRect(x2 - 1, plot.top, 1, plot.bottom - plot.top);
      if (x2 - x1 > 34) {
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillStyle = '#f4a84d';
        ctx.fillText('AD', x1 + 5, plot.top + 11);
      }
    }
  }

  private drawGrid(plot: ReturnType<TimelineRenderer['plot']>): void {
    const ctx = this.context;
    const duration = this.result?.metadata.duration || 1;
    const target = this.result?.settings.target || -14;
    const plotWidth = plot.right - plot.left;
    const maxTicks = Math.max(2, Math.floor(plotWidth / 62));
    const rawTick = duration / maxTicks;
    const tickChoices = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const tick = tickChoices.find((candidate) => candidate >= rawTick) || tickChoices[tickChoices.length - 1];
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (let time = 0; time <= duration + 0.001; time += tick) {
      const x = this.xAtTime(time);
      ctx.strokeStyle = '#1a242e';
      ctx.beginPath();
      ctx.moveTo(x, plot.top);
      ctx.lineTo(x, plot.bottom);
      ctx.stroke();
      ctx.fillStyle = '#66778a';
      ctx.fillText(formatTime(time), x, this.height - 8);
    }
    ctx.textAlign = 'right';
    for (const [db, label] of [[target, `${Math.round(target)}`], [target - 12, `${Math.round(target - 12)}`]] as const) {
      const y = this.loudnessY(db, plot);
      ctx.strokeStyle = db === target ? 'rgba(88, 214, 176, 0.42)' : '#1a242e';
      ctx.setLineDash(db === target ? [5, 5] : []);
      ctx.beginPath();
      ctx.moveTo(plot.left, y);
      ctx.lineTo(plot.right, y);
      ctx.stroke();
      ctx.fillStyle = db === target ? '#58d6b0' : '#66778a';
      ctx.fillText(label, plot.left - 8, y + 3);
    }
    ctx.setLineDash([]);
    ctx.fillStyle = '#66778a';
    ctx.textAlign = 'left';
    ctx.fillText('波形', 10, plot.top + 10);
    ctx.fillText('LUFS', 10, plot.loudTop + 12);
  }

  private loudnessY(value: number, plot: ReturnType<TimelineRenderer['plot']>): number {
    const target = this.result?.settings.target || -14;
    const top = target + 12;
    const bottom = target - 18;
    const clamped = Math.max(bottom, Math.min(top, value));
    return plot.loudTop + (top - clamped) / (top - bottom) * (plot.bottom - plot.loudTop - 4);
  }

  private drawWaveform(plot: ReturnType<TimelineRenderer['plot']>): void {
    if (!this.result) return;
    const ctx = this.context;
    const envelope = this.result.waveform;
    const centerY = (plot.top + plot.waveBottom) / 2;
    const amplitude = (plot.waveBottom - plot.top) * 0.43;
    const pixels = Math.max(1, Math.floor(plot.right - plot.left));
    ctx.strokeStyle = '#5b93c9';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      const startBucket = Math.floor(pixel / pixels * envelope.min.length);
      const endBucket = Math.max(startBucket + 1, Math.floor((pixel + 1) / pixels * envelope.min.length));
      let minimum = 0;
      let maximum = 0;
      for (let bucket = startBucket; bucket < Math.min(endBucket, envelope.min.length); bucket += 1) {
        if (envelope.min[bucket] < minimum) minimum = envelope.min[bucket];
        if (envelope.max[bucket] > maximum) maximum = envelope.max[bucket];
      }
      const x = plot.left + pixel;
      ctx.moveTo(x + 0.5, centerY - Math.max(-1, minimum) * amplitude);
      ctx.lineTo(x + 0.5, centerY - Math.min(1, maximum) * amplitude);
    }
    ctx.stroke();
  }

  private drawLoudness(plot: ReturnType<TimelineRenderer['plot']>): void {
    if (!this.result) return;
    const ctx = this.context;
    const blocks = this.result.blocks;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(122, 166, 255, 0.75)';
    ctx.beginPath();
    let started = false;
    for (const block of blocks) {
      if (!Number.isFinite(block.shortTerm)) continue;
      const x = this.xAtTime(block.end);
      const y = this.loudnessY(block.shortTerm, plot);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(255, 176, 87, 0.9)';
    ctx.beginPath();
    started = false;
    for (const block of blocks) {
      if (!Number.isFinite(block.momentary)) continue;
      const x = this.xAtTime(block.end);
      const y = this.loudnessY(block.momentary, plot);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  private drawProblems(plot: ReturnType<TimelineRenderer['plot']>): void {
    if (!this.result) return;
    const ctx = this.context;
    for (const problem of this.result.intervals) {
      if (problem.kind === 'program-offset') continue;
      const x1 = this.xAtTime(problem.start);
      const x2 = this.xAtTime(problem.end);
      ctx.fillStyle = problem.severity === 'critical' ? '#ff625f' : '#f4a84d';
      ctx.fillRect(x1, plot.bottom + 5, Math.max(2, x2 - x1), 3);
    }
  }

  private drawSelectionAndPlayhead(plot: ReturnType<TimelineRenderer['plot']>): void {
    const ctx = this.context;
    if (this.selection) {
      const x1 = this.xAtTime(this.selection.start);
      const x2 = this.xAtTime(this.selection.end);
      ctx.fillStyle = 'rgba(244, 168, 77, 0.18)';
      ctx.fillRect(x1, plot.top, x2 - x1, plot.bottom - plot.top);
      ctx.strokeStyle = '#f4a84d';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x1 + 0.5, plot.top + 0.5, x2 - x1 - 1, plot.bottom - plot.top - 1);
      ctx.setLineDash([]);
    }
    const x = this.xAtTime(this.currentTime);
    ctx.strokeStyle = '#f5f8fb';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, plot.top);
    ctx.lineTo(x + 0.5, plot.bottom);
    ctx.stroke();
    ctx.fillStyle = '#f5f8fb';
    ctx.beginPath();
    ctx.arc(x, plot.top, 3, 0, Math.PI * 2);
    ctx.fill();
    if (this.hoverTime !== null) {
      const text = formatTime(this.hoverTime, true);
      ctx.font = '10px ui-monospace, monospace';
      const width = ctx.measureText(text).width + 12;
      const hoverX = Math.min(plot.right - width, Math.max(plot.left, this.xAtTime(this.hoverTime) - width / 2));
      ctx.fillStyle = 'rgba(8, 12, 17, 0.9)';
      ctx.fillRect(hoverX, plot.top - 15, width, 16);
      ctx.fillStyle = '#c8d4e0';
      ctx.textAlign = 'center';
      ctx.fillText(text, hoverX + width / 2, plot.top - 4);
      ctx.textAlign = 'left';
    }
  }
}
