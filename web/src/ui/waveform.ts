import type { SegmentState } from "../core/types.ts";

export interface WaveSegmentView {
  id: string;
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
  originalDuration: number;
  targetMs: number;
  state: SegmentState;
  kind: string;
}

export interface WaveProject {
  peaks: PeakData;
  duration: number;
  segments: WaveSegmentView[];
  playhead: number;
  selectedId: string | null;
  muted: boolean[];
  view: "edited" | "source";
}

export interface WaveformCallbacks {
  onSeek: (seconds: number) => void;
  onSelect: (id: string | null) => void;
  onViewChange: (start: number, duration: number) => void;
  onZoomAt: (seconds: number, factor: number) => void;
}

export class PeakData {
  private readonly minimums: Float32Array[];
  private readonly maximums: Float32Array[];
  private readonly bucketSize: number;
  readonly sampleRate: number;
  readonly duration: number;

  constructor(channels: Float32Array[], sampleRate: number) {
    const length = channels.length > 0 ? channels[0].length : 0;
    let bucketSize = 8;
    while (Math.ceil(length / bucketSize) > 400000) bucketSize *= 2;
    this.bucketSize = bucketSize;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    const bucketCount = Math.max(1, Math.ceil(length / bucketSize));
    this.minimums = [];
    this.maximums = [];

    for (const channel of channels) {
      const minimum = new Float32Array(bucketCount);
      const maximum = new Float32Array(bucketCount);
      for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        const start = bucket * bucketSize;
        const end = Math.min(start + bucketSize, channel.length);
        let low = 0;
        let high = 0;
        for (let index = start; index < end; index += 1) {
          const sample = channel[index];
          if (sample < low) low = sample;
          if (sample > high) high = sample;
        }
        minimum[bucket] = low;
        maximum[bucket] = high;
      }
      this.minimums.push(minimum);
      this.maximums.push(maximum);
    }
  }

  peaksFor(
    channelIndex: number,
    startTime: number,
    endTime: number,
    columns: number,
  ): { minimum: Float32Array; maximum: Float32Array } {
    const minimum = new Float32Array(columns);
    const maximum = new Float32Array(columns);
    const channel = Math.min(channelIndex, this.maximums.length - 1);
    if (channel < 0) return { minimum, maximum };
    const startSample = Math.max(0, startTime * this.sampleRate);
    const endSample = Math.min(this.duration * this.sampleRate, endTime * this.sampleRate);
    const span = Math.max(1, endSample - startSample);
    const minimums = this.minimums[channel];
    const maximums = this.maximums[channel];

    for (let column = 0; column < columns; column += 1) {
      const sampleStart = Math.floor(startSample + (column / columns) * span);
      const sampleEnd = Math.ceil(startSample + ((column + 1) / columns) * span);
      const bucketStart = Math.max(0, Math.floor(sampleStart / this.bucketSize));
      const bucketEnd = Math.min(minimums.length, Math.max(bucketStart + 1, Math.ceil(sampleEnd / this.bucketSize)));
      let low = 0;
      let high = 0;
      for (let bucket = bucketStart; bucket < bucketEnd; bucket += 1) {
        if (minimums[bucket] < low) low = minimums[bucket];
        if (maximums[bucket] > high) high = maximums[bucket];
      }
      minimum[column] = low;
      maximum[column] = high;
    }
    return { minimum, maximum };
  }
}

const RULER_HEIGHT = 31;
const LANE_HEIGHT = 109;
const OVERVIEW_HEIGHT = 47;
const COLORS = {
  background: "#10130e",
  lane: "#121610",
  laneAlt: "#11140f",
  grid: "rgba(255,255,255,0.045)",
  gridStrong: "rgba(255,255,255,0.08)",
  text: "#788172",
  textStrong: "#b7beb0",
  waveA: "#cdea6d",
  waveB: "#9fcaf2",
  orange: "#ffad6b",
  blue: "#9fcaf2",
  lime: "#d9ff66",
  selected: "rgba(217,255,102,0.22)",
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function formatRuler(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(1).padStart(4, "0")}`;
}

function chooseGridStep(span: number): number {
  const target = span / 5;
  const steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((step) => step >= target) || 600;
}

export class TimelineCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly callbacks: WaveformCallbacks;
  private project: WaveProject | null = null;
  private viewStart = 0;
  private viewDuration = 1;
  private hoverId: string | null = null;
  private hoverX = 0;
  private hoverY = 0;
  private drag:
    | { pointerId: number; startX: number; startView: number; moved: boolean; duration: number }
    | null = null;
  private frame = 0;

  constructor(canvas: HTMLCanvasElement, callbacks: WaveformCallbacks) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D 不可用。");
    this.canvas = canvas;
    this.context = context;
    this.callbacks = callbacks;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    const observer = new ResizeObserver(() => this.draw());
    observer.observe(canvas);
  }

  setProject(project: WaveProject, viewStart: number, viewDuration: number): void {
    this.project = project;
    this.viewStart = viewStart;
    this.viewDuration = viewDuration;
    this.draw();
  }

  setView(start: number, duration: number): void {
    this.viewStart = start;
    this.viewDuration = duration;
    this.draw();
  }

  getView(): { start: number; duration: number } {
    return { start: this.viewStart, duration: this.viewDuration };
  }

  private timeAt(clientX: number): number {
    const bounds = this.canvas.getBoundingClientRect();
    const ratio = clamp((clientX - bounds.left) / bounds.width, 0, 1);
    return this.viewStart + ratio * this.viewDuration;
  }

  private xAt(seconds: number): number {
    const width = this.canvas.getBoundingClientRect().width;
    return ((seconds - this.viewStart) / this.viewDuration) * width;
  }

  private yAt(clientY: number): number {
    const bounds = this.canvas.getBoundingClientRect();
    return clientY - bounds.top;
  }

  private segmentAt(seconds: number, y: number): WaveSegmentView | null {
    if (!this.project || y < RULER_HEIGHT || y > RULER_HEIGHT + LANE_HEIGHT * 2) return null;
    return (
      this.project.segments.find(
        (segment) => seconds >= segment.start && seconds <= segment.end,
      ) || null
    );
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.project || event.button !== 0) return;
    const y = this.yAt(event.clientY);
    if (y < RULER_HEIGHT) {
      this.callbacks.onSeek(this.timeAt(event.clientX));
      return;
    }
    if (y >= RULER_HEIGHT + LANE_HEIGHT * 2) {
      const bounds = this.canvas.getBoundingClientRect();
      const ratio = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
      this.callbacks.onSeek(ratio * this.project.duration);
      return;
    }
    const segment = this.segmentAt(this.timeAt(event.clientX), y);
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startView: this.viewStart,
      moved: false,
      duration: this.viewDuration,
    };
    this.canvas.setPointerCapture(event.pointerId);
    if (segment) {
      this.callbacks.onSelect(segment.id);
    } else if (y >= RULER_HEIGHT) {
      this.callbacks.onSeek(this.timeAt(event.clientX));
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.project) return;
    this.hoverX = event.clientX - this.canvas.getBoundingClientRect().left;
    this.hoverY = this.yAt(event.clientY);
    const hovered = this.segmentAt(this.timeAt(event.clientX), this.hoverY);
    const nextHover = hovered?.id || null;
    if (nextHover !== this.hoverId) {
      this.hoverId = nextHover;
      this.canvas.style.cursor = nextHover ? "pointer" : this.drag ? "grabbing" : "crosshair";
      this.draw();
    }
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const delta = event.clientX - this.drag.startX;
    if (Math.abs(delta) > 4) this.drag.moved = true;
    if (!this.drag.moved) return;
    const width = this.canvas.getBoundingClientRect().width;
    const shift = -(delta / width) * this.drag.duration;
    const maxStart = Math.max(0, this.project.duration - this.drag.duration);
    const start = clamp(this.drag.startView + shift, 0, maxStart);
    this.viewStart = start;
    this.canvas.style.cursor = "grabbing";
    this.callbacks.onViewChange(start, this.drag.duration);
    this.draw();
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.drag) return;
    if (this.drag.pointerId === event.pointerId && !this.drag.moved) {
      const y = this.yAt(event.clientY);
      if (y >= RULER_HEIGHT && y <= RULER_HEIGHT + LANE_HEIGHT * 2) {
        const segment = this.segmentAt(this.timeAt(event.clientX), y);
        if (!segment) this.callbacks.onSelect(null);
      }
    }
    this.drag = null;
    this.canvas.style.cursor = this.hoverId ? "pointer" : "crosshair";
  };

  private onPointerLeave = (): void => {
    if (this.drag) return;
    this.hoverId = null;
    this.draw();
  };

  private onWheel = (event: WheelEvent): void => {
    if (!this.project) return;
    event.preventDefault();
    if (event.shiftKey) {
      const width = this.canvas.getBoundingClientRect().width;
      const shift = (event.deltaY / width) * this.viewDuration;
      const maxStart = Math.max(0, this.project.duration - this.viewDuration);
      this.callbacks.onViewChange(clamp(this.viewStart + shift, 0, maxStart), this.viewDuration);
      return;
    }
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.callbacks.onZoomAt(this.timeAt(event.clientX), factor);
  };

  draw(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private paint(): void {
    if (!this.project) return;
    const bounds = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }
    const context = this.context;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = COLORS.background;
    context.fillRect(0, 0, width, height);

    this.drawGrid(context, width);
    this.drawLane(context, 0, RULER_HEIGHT, width, COLORS.waveA);
    this.drawLane(context, 1, RULER_HEIGHT + LANE_HEIGHT, width, COLORS.waveB);
    this.drawPlayhead(context, RULER_HEIGHT, LANE_HEIGHT * 2);
    this.drawOverview(context, width, height);
    this.drawHoverCard(context, width);
  }

  private drawGrid(context: CanvasRenderingContext2D, width: number): void {
    if (!this.project) return;
    const end = this.viewStart + this.viewDuration;
    const step = chooseGridStep(this.viewDuration);
    const first = Math.ceil(this.viewStart / step) * step;
    context.font = '8px "SFMono-Regular", Menlo, monospace';
    context.textAlign = "left";
    context.textBaseline = "middle";
    for (let time = first; time <= end + 0.001; time += step) {
      const x = Math.round(this.xAt(time)) + 0.5;
      context.strokeStyle = COLORS.grid;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, RULER_HEIGHT - 5);
      context.lineTo(x, RULER_HEIGHT + LANE_HEIGHT * 2);
      context.stroke();
      context.fillStyle = COLORS.text;
      context.fillText(formatRuler(time), x + 4, 13);
    }
    context.strokeStyle = COLORS.grid;
    context.beginPath();
    context.moveTo(0, RULER_HEIGHT - 0.5);
    context.lineTo(width, RULER_HEIGHT - 0.5);
    context.stroke();
  }

  private drawLane(
    context: CanvasRenderingContext2D,
    channel: number,
    top: number,
    width: number,
    color: string,
  ): void {
    if (!this.project) return;
    context.fillStyle = channel === 0 ? COLORS.lane : COLORS.laneAlt;
    context.fillRect(0, top, width, LANE_HEIGHT);
    const center = top + LANE_HEIGHT / 2;
    context.strokeStyle = COLORS.grid;
    context.beginPath();
    context.moveTo(0, Math.round(center) + 0.5);
    context.lineTo(width, Math.round(center) + 0.5);
    context.stroke();

    const peaks = this.project.peaks.peaksFor(
      channel,
      this.viewStart,
      this.viewStart + this.viewDuration,
      Math.max(1, Math.floor(width)),
    );
    const muted = this.project.muted[channel] || false;
    const gradient = context.createLinearGradient(0, top, 0, top + LANE_HEIGHT);
    gradient.addColorStop(0.05, muted ? "rgba(150,160,143,0.13)" : `${color}55`);
    gradient.addColorStop(0.5, muted ? "rgba(150,160,143,0.2)" : `${color}aa`);
    gradient.addColorStop(0.95, muted ? "rgba(150,160,143,0.13)" : `${color}55`);
    context.fillStyle = gradient;
    context.beginPath();
    const amplitude = LANE_HEIGHT * 0.4;
    for (let x = 0; x < peaks.maximum.length; x += 1) {
      const value = Math.pow(Math.abs(peaks.maximum[x]), 0.78) * amplitude;
      if (x === 0) context.moveTo(x, center - value);
      else context.lineTo(x, center - value);
    }
    for (let x = peaks.minimum.length - 1; x >= 0; x -= 1) {
      const value = Math.pow(Math.abs(peaks.minimum[x]), 0.78) * amplitude;
      context.lineTo(x, center + value);
    }
    context.closePath();
    context.fill();

    this.drawSegments(context, channel, top, width);
    context.strokeStyle = "rgba(255,255,255,0.04)";
    context.beginPath();
    context.moveTo(0, top + LANE_HEIGHT - 0.5);
    context.lineTo(width, top + LANE_HEIGHT - 0.5);
    context.stroke();
  }

  private drawSegments(
    context: CanvasRenderingContext2D,
    channel: number,
    top: number,
    width: number,
  ): void {
    if (!this.project) return;
    for (const segment of this.project.segments) {
      if (segment.end < this.viewStart || segment.start > this.viewStart + this.viewDuration) continue;
      const left = this.xAt(segment.start);
      const right = this.xAt(segment.end);
      const x = clamp(left, -1, width + 1);
      const segmentWidth = Math.max(2, Math.min(width + 1, right) - x);
      const selected = segment.id === this.project.selectedId;
      const hovered = segment.id === this.hoverId;
      const active = segment.state === "active";
      const fill = active
        ? selected || hovered
          ? "rgba(255,173,107,0.24)"
          : "rgba(255,173,107,0.14)"
        : selected || hovered
          ? "rgba(159,202,242,0.13)"
          : "rgba(159,202,242,0.07)";
      context.fillStyle = fill;
      context.fillRect(x, top + 1, segmentWidth, LANE_HEIGHT - 2);
      context.strokeStyle = selected
        ? accentFor(segment.state)
        : active
          ? "rgba(255,173,107,0.43)"
          : "rgba(159,202,242,0.28)";
      context.lineWidth = selected ? 1.4 : 0.8;
      if (segment.state === "bypassed" || segment.state === "undone") {
        context.setLineDash([3, 3]);
      }
      context.strokeRect(x + 0.5, top + 1.5, Math.max(1, segmentWidth - 1), LANE_HEIGHT - 3);
      context.setLineDash([]);

      if (channel === 0 && (selected || hovered || segmentWidth > 38)) {
        const label = active
          ? `−${Math.max(0, segment.originalDuration - segment.targetMs / 1000).toFixed(2)}s`
          : "保留";
        context.font = '8px "SFMono-Regular", Menlo, monospace';
        const labelWidth = context.measureText(label).width + 10;
        if (segmentWidth > labelWidth + 3) {
          context.fillStyle = active ? "rgba(58,35,19,0.94)" : "rgba(27,40,50,0.94)";
          context.fillRect(x + 3, top + 5, labelWidth, 15);
          context.fillStyle = active ? COLORS.orange : COLORS.blue;
          context.fillText(label, x + 7, top + 12);
        }
      }
    }
  }

  private drawPlayhead(context: CanvasRenderingContext2D, top: number, height: number): void {
    if (!this.project) return;
    const x = this.xAt(this.project.playhead);
    if (x < -7 || x > this.canvas.getBoundingClientRect().width + 7) return;
    context.strokeStyle = COLORS.lime;
    context.lineWidth = 1.2;
    context.beginPath();
    context.moveTo(Math.round(x) + 0.5, top);
    context.lineTo(Math.round(x) + 0.5, top + height);
    context.stroke();
    context.fillStyle = COLORS.lime;
    context.beginPath();
    context.moveTo(x - 4, top);
    context.lineTo(x + 4, top);
    context.lineTo(x, top + 5);
    context.closePath();
    context.fill();
  }

  private drawOverview(context: CanvasRenderingContext2D, width: number, height: number): void {
    if (!this.project) return;
    const top = height - OVERVIEW_HEIGHT;
    context.fillStyle = "#0d100c";
    context.fillRect(0, top, width, OVERVIEW_HEIGHT);
    context.strokeStyle = "rgba(255,255,255,0.07)";
    context.beginPath();
    context.moveTo(0, top + 0.5);
    context.lineTo(width, top + 0.5);
    context.stroke();
    const peaks = this.project.peaks.peaksFor(
      0,
      0,
      this.project.duration,
      Math.max(1, Math.floor(width)),
    );
    const center = top + OVERVIEW_HEIGHT / 2 + 1;
    context.fillStyle = "rgba(155,173,135,0.34)";
    context.beginPath();
    for (let x = 0; x < peaks.maximum.length; x += 1) {
      const value = Math.pow(Math.abs(peaks.maximum[x]), 0.7) * 15;
      if (x === 0) context.moveTo(x, center - value);
      else context.lineTo(x, center - value);
    }
    for (let x = peaks.minimum.length - 1; x >= 0; x -= 1) {
      const value = Math.pow(Math.abs(peaks.minimum[x]), 0.7) * 15;
      context.lineTo(x, center + value);
    }
    context.closePath();
    context.fill();

    for (const segment of this.project.segments) {
      const x = (segment.start / this.project.duration) * width;
      const segmentWidth = Math.max(1, ((segment.end - segment.start) / this.project.duration) * width);
      context.fillStyle =
        segment.state === "active" ? "rgba(255,173,107,0.28)" : "rgba(159,202,242,0.16)";
      context.fillRect(x, top + 8, segmentWidth, OVERVIEW_HEIGHT - 16);
    }

    const windowX = (this.viewStart / this.project.duration) * width;
    const windowWidth = (this.viewDuration / this.project.duration) * width;
    context.fillStyle = "rgba(217,255,102,0.035)";
    context.fillRect(windowX, top + 3, windowWidth, OVERVIEW_HEIGHT - 6);
    context.strokeStyle = "rgba(217,255,102,0.4)";
    context.lineWidth = 1;
    context.strokeRect(windowX + 0.5, top + 3.5, Math.max(2, windowWidth - 1), OVERVIEW_HEIGHT - 7);
  }

  private drawHoverCard(context: CanvasRenderingContext2D, width: number): void {
    if (!this.hoverId || !this.project || this.drag?.moved) return;
    const segment = this.project.segments.find((item) => item.id === this.hoverId);
    if (!segment) return;
    const stateLabel =
      segment.state === "active" ? "已压缩" : segment.state === "bypassed" ? "已旁路" : "已撤销";
    const lineA = `${stateLabel} · ${Math.round(segment.originalDuration * 1000)} ms → ${
      segment.state === "active" ? segment.targetMs : Math.round(segment.originalDuration * 1000)
    } ms`;
    const lineB = "点击检查 · 右侧可试听";
    context.font = '10px "SFMono-Regular", Menlo, monospace';
    const cardWidth = Math.max(context.measureText(lineA).width, context.measureText(lineB).width) + 22;
    const x = clamp(this.hoverX + 12, 6, width - cardWidth - 6);
    const y = clamp(this.hoverY + 15, RULER_HEIGHT + 4, RULER_HEIGHT + LANE_HEIGHT * 2 - 48);
    context.fillStyle = "rgba(20,25,18,0.96)";
    context.strokeStyle = "#3a4434";
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(x, y, cardWidth, 40, 6);
    context.fill();
    context.stroke();
    context.fillStyle = COLORS.textStrong;
    context.fillText(lineA, x + 10, y + 15);
    context.fillStyle = COLORS.text;
    context.font = '8px "SFMono-Regular", Menlo, monospace';
    context.fillText(lineB, x + 10, y + 30);
  }
}

function accentFor(state: SegmentState): string {
  if (state === "active") return COLORS.orange;
  if (state === "bypassed") return COLORS.blue;
  return "#788172";
}
