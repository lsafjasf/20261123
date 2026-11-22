// Comp timeline: waveform of the stitched result, segments colored by source
// take, provenance labels (S·T), cut markers, playhead. Click to audition.

import { state } from "./state.ts";
import { takeColor } from "./gridview.ts";

const H = 170;
const LABEL_H = 22;

export interface CompHandlers {
  onSeek: (sec: number) => void;
}

export class CompView {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private handlers: CompHandlers;
  private playhead = -1;

  constructor(canvas: HTMLCanvasElement, handlers: CompHandlers) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d")!;
    this.handlers = handlers;
    canvas.addEventListener("click", (e) => {
      if (!state.plan) return;
      const r = canvas.getBoundingClientRect();
      const sec = ((e.clientX - r.left) / r.width) * state.plan.duration;
      this.handlers.onSeek(Math.max(0, Math.min(state.plan.duration, sec)));
    });
  }

  setPlayhead(sec: number): void {
    this.playhead = sec;
    this.render();
  }

  render(): void {
    const parentW = this.canvas.parentElement?.clientWidth ?? 900;
    const w = Math.max(600, parentW - 2);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = H * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${H}px`;
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, H);
    g.font = "11px monospace";

    if (!state.plan || !state.compPcm) {
      g.fillStyle = "#8a94a3";
      g.fillText("完成分析后自动生成拼接预览。每段颜色对应来源 take。", 12, 24);
      return;
    }
    const plan = state.plan;
    const pcm = state.compPcm;
    const pxPerSec = w / plan.duration;
    const waveTop = LABEL_H;
    const waveH = H - LABEL_H - 16;
    const mid = waveTop + waveH / 2;

    // Segment background bands + provenance labels.
    for (const seg of plan.segments) {
      const x0 = seg.dstStart * pxPerSec;
      const x1 = seg.dstEnd * pxPerSec;
      g.fillStyle = takeColor(seg.take, 0.14);
      g.fillRect(x0, waveTop, Math.max(1, x1 - x0), waveH);
      g.fillStyle = takeColor(seg.take);
      const label = `S${seg.sentence + 1}·T${seg.take + 1}${seg.clamped ? "✂" : ""}`;
      if (x1 - x0 > 34) g.fillText(label, x0 + 3, 14);
      // Cut marker.
      g.strokeStyle = takeColor(seg.take, 0.8);
      g.beginPath();
      g.moveTo(x0 + 0.5, waveTop);
      g.lineTo(x0 + 0.5, waveTop + waveH);
      g.stroke();
    }

    // Waveform.
    g.strokeStyle = "#d7dde6";
    g.beginPath();
    const n = pcm.length;
    for (let px = 0; px < w; px++) {
      const a = Math.floor((px / w) * n);
      const b = Math.max(a + 1, Math.floor(((px + 1) / w) * n));
      let peak = 0;
      for (let k = a; k < b && k < n; k++) peak = Math.max(peak, Math.abs(pcm[k]));
      const hh = Math.max(0.5, peak * waveH * 0.48);
      g.moveTo(px + 0.5, mid - hh);
      g.lineTo(px + 0.5, mid + hh);
    }
    g.stroke();

    // Time ruler.
    g.fillStyle = "#8a94a3";
    const step = plan.duration > 40 ? 10 : plan.duration > 15 ? 5 : 2;
    for (let t = 0; t <= plan.duration; t += step) {
      const x = t * pxPerSec;
      g.fillText(`${t}s`, x + 2, H - 4);
    }

    // Playhead.
    if (this.playhead >= 0) {
      const x = this.playhead * pxPerSec;
      g.strokeStyle = "#4da3ff";
      g.beginPath();
      g.moveTo(x + 0.5, waveTop);
      g.lineTo(x + 0.5, waveTop + waveH);
      g.stroke();
    }
  }
}
