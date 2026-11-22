/**
 * 时间线视图：在一块 Canvas 上画三条共用同一时间坐标的轨道——
 * 1) 画面片段 + 切点手柄；2) 节拍/重拍；3) 音频波形 + 说话区间。
 * 交互只通过命中测试移动被抓住的那一条切点，其余切点数据不动。
 */

import type { Beat, Clip, CutPoint, SpeechSpan } from "../core/types.ts";
import { timeToX, xToTime } from "../core/timeline.ts";

export const TRACK_HEIGHTS = { clips: 84, beats: 56, audio: 72 };
export const TIMELINE_HEIGHT =
  TRACK_HEIGHTS.clips + TRACK_HEIGHTS.beats + TRACK_HEIGHTS.audio + 24;

const WEIGHT_COLORS: Record<Clip["weight"], string> = {
  strong: "#e76f51",
  normal: "#4c93d6",
  weak: "#8a8f98",
};

export interface TimelineState {
  clips: Clip[];
  beats: Beat[];
  cuts: CutPoint[];
  speech: SpeechSpan[];
  waveform: Float32Array;
  duration: number;
  pxPerSec: number;
  playhead: number;
  selectedCutId: string | null;
}

export class TimelineView {
  private dragging: { cutId: string } | null = null;
  private readonly canvas: HTMLCanvasElement;
  private state: TimelineState;
  private readonly onDrag: (cutId: string, time: number) => void;
  private readonly onDragEnd: () => void;
  private readonly onSelect: (cutId: string | null) => void;

  constructor(
    canvas: HTMLCanvasElement,
    state: TimelineState,
    callbacks: {
      onDrag: (cutId: string, time: number) => void;
      onDragEnd: () => void;
      onSelect: (cutId: string | null) => void;
    },
  ) {
    this.canvas = canvas;
    this.state = state;
    this.onDrag = callbacks.onDrag;
    this.onDragEnd = callbacks.onDragEnd;
    this.onSelect = callbacks.onSelect;
    this.bindPointer();
  }

  update(state: TimelineState): void {
    this.state = state;
    this.draw();
  }

  get pxPerSec(): number {
    return this.state.pxPerSec;
  }

  private bindPointer(): void {
    this.canvas.addEventListener("pointerdown", (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const hit = this.hitTestCut(x, y);
      if (hit) {
        this.dragging = { cutId: hit.id };
        this.canvas.setPointerCapture(event.pointerId);
        this.onSelect(hit.id);
      } else {
        this.onSelect(null);
      }
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.dragging) {
        this.canvas.style.cursor = this.hitTestCut(
          event.clientX - this.canvas.getBoundingClientRect().left,
          event.clientY - this.canvas.getBoundingClientRect().top,
        )
          ? "ew-resize"
          : "default";
        return;
      }
      const rect = this.canvas.getBoundingClientRect();
      const time = xToTime(event.clientX - rect.left, this.state.pxPerSec);
      this.onDrag(this.dragging.cutId, time);
    });
    const end = (event: PointerEvent): void => {
      if (!this.dragging) return;
      this.dragging = null;
      this.canvas.releasePointerCapture(event.pointerId);
      this.onDragEnd();
    };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
  }

  /** 切点手柄在片段轨顶部的 14px 热区内，左右各 7px 容差。 */
  hitTestCut(x: number, y: number): CutPoint | null {
    if (y < 0 || y > TRACK_HEIGHTS.clips) return null;
    let best: CutPoint | null = null;
    let bestDist = 8;
    for (const cut of this.state.cuts) {
      const cx = timeToX(cut.time, this.state.pxPerSec);
      const distance = Math.abs(cx - x);
      if (distance <= bestDist) {
        bestDist = distance;
        best = cut;
      }
    }
    return best;
  }

  draw(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const width = this.canvas.width;
    ctx.clearRect(0, 0, width, TIMELINE_HEIGHT);
    ctx.fillStyle = "#15171c";
    ctx.fillRect(0, 0, width, TIMELINE_HEIGHT);

    this.drawClips(ctx);
    this.drawBeats(ctx, TRACK_HEIGHTS.clips);
    this.drawAudio(ctx, TRACK_HEIGHTS.clips + TRACK_HEIGHTS.beats);
    this.drawPlayhead(ctx);
  }

  private drawClips(ctx: CanvasRenderingContext2D): void {
    const { clips, cuts, pxPerSec } = this.state;
    for (const clip of clips) {
      const x = timeToX(clip.start, pxPerSec);
      const w = Math.max(2, clip.duration * pxPerSec - 2);
      ctx.fillStyle = WEIGHT_COLORS[clip.weight];
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x + 1, 8, w, TRACK_HEIGHTS.clips - 20);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#ffffff";
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.textBaseline = "top";
      ctx.fillText(clip.name, x + 8, 14);
      ctx.font = "11px ui-monospace, monospace";
      ctx.fillText(`${clip.duration.toFixed(1)}s · 入点${clip.source.inPoint.toFixed(1)}s`, x + 8, 34);
    }
    for (const cut of cuts) {
      const x = timeToX(cut.time, pxPerSec);
      const selected = cut.id === this.state.selectedCutId;
      ctx.fillStyle = cut.manual ? "#ffd166" : selected ? "#7ee0c8" : "#f4f6fa";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 7, 10);
      ctx.lineTo(x - 7, 10);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.stroke();
    }
    ctx.fillStyle = "#9aa1ab";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText("画面 / 切点", 8, TRACK_HEIGHTS.clips - 10);
  }

  private drawBeats(ctx: CanvasRenderingContext2D, top: number): void {
    const { beats, pxPerSec } = this.state;
    ctx.fillStyle = "#1d2026";
    ctx.fillRect(0, top, this.canvas.width, TRACK_HEIGHTS.beats);
    for (const beat of beats) {
      const x = timeToX(beat.time, pxPerSec);
      const height = 12 + beat.strength * 22;
      ctx.fillStyle = beat.downbeat ? "#ffd166" : "rgba(126,224,200,0.75)";
      ctx.fillRect(x - (beat.downbeat ? 2 : 1), top + TRACK_HEIGHTS.beats - height - 6, beat.downbeat ? 4 : 2, height);
    }
    ctx.fillStyle = "#9aa1ab";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText("节拍（金色=重拍）", 8, top + 4);
  }

  private drawAudio(ctx: CanvasRenderingContext2D, top: number): void {
    const { waveform, speech, pxPerSec, duration } = this.state;
    ctx.fillStyle = "#101216";
    ctx.fillRect(0, top, this.canvas.width, TRACK_HEIGHTS.audio);
    const mid = top + TRACK_HEIGHTS.audio / 2;
    const samplesPerPx = Math.max(1, Math.floor(waveform.length / this.canvas.width));
    ctx.strokeStyle = "rgba(120,170,255,0.8)";
    ctx.beginPath();
    for (let x = 0; x < this.canvas.width; x++) {
      let peak = 0;
      const start = x * samplesPerPx;
      for (let i = start; i < start + samplesPerPx; i++) peak = Math.max(peak, Math.abs(waveform[i] ?? 0));
      ctx.moveTo(x, mid - peak * 26);
      ctx.lineTo(x, mid + peak * 26);
    }
    ctx.stroke();

    for (const span of speech) {
      const x = timeToX(span.start, pxPerSec);
      const w = (span.end - span.start) * pxPerSec;
      ctx.fillStyle = "rgba(231,111,81,0.28)";
      ctx.fillRect(x, top, w, TRACK_HEIGHTS.audio);
      ctx.strokeStyle = "rgba(231,111,81,0.9)";
      ctx.strokeRect(x + 0.5, top + 0.5, w, TRACK_HEIGHTS.audio - 1);
    }
    ctx.fillStyle = "#9aa1ab";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(`音轨 / 说话区间（时长 ${duration.toFixed(1)}s）`, 8, top + 4);
  }

  private drawPlayhead(ctx: CanvasRenderingContext2D): void {
    const x = timeToX(this.state.playhead, this.state.pxPerSec);
    ctx.strokeStyle = "#ff5d73";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, TIMELINE_HEIGHT);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}
