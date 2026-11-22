// Alignment matrix on canvas: rows = sentences, columns = takes.
// Each cell shows the sentence waveform + rhythm / noise / emotion badges.

import { state } from "./state.ts";

const LABEL_W = 96;
const COL_W = 128;
const HEADER_H = 30;
const ROW_H = 72;
const PAD = 6;

export function takeColor(t: number, alpha = 1): string {
  const hue = (t * 137.508) % 360;
  return `hsla(${hue}, 65%, 58%, ${alpha})`;
}

export interface GridHandlers {
  onSelect: (sentence: number, take: number) => void;
  onHover: (msg: string) => void;
}

export class GridView {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private handlers: GridHandlers;

  constructor(canvas: HTMLCanvasElement, handlers: GridHandlers) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d")!;
    this.handlers = handlers;
    canvas.addEventListener("click", (e) => this.handleClick(e));
    canvas.addEventListener("mousemove", (e) => this.handleHover(e));
  }

  private cellAt(ev: MouseEvent): { s: number; t: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    if (x < LABEL_W || y < HEADER_H) return null;
    const t = Math.floor((x - LABEL_W) / COL_W);
    const s = Math.floor((y - HEADER_H) / ROW_H);
    if (t < 0 || t >= state.takeNames.length) return null;
    const nSent = state.segs[state.refTake]?.sentences.length ?? 0;
    if (s < 0 || s >= nSent) return null;
    return { s, t };
  }

  private handleClick(ev: MouseEvent): void {
    const cell = this.cellAt(ev);
    if (cell) this.handlers.onSelect(cell.s, cell.t);
  }

  private handleHover(ev: MouseEvent): void {
    const cell = this.cellAt(ev);
    if (!cell || state.metrics.length === 0) return;
    const m = state.metrics[cell.t][cell.s];
    if (!m || m.srcSentence < 0) {
      this.handlers.onHover(`S${cell.s + 1} · ${state.takeNames[cell.t]} · 缺失`);
      return;
    }
    this.handlers.onHover(
      `S${cell.s + 1} · ${state.takeNames[cell.t]} · ${m.duration.toFixed(2)}s ` +
        `节奏相似 ${(m.rhythm * 100).toFixed(0)}% 时差 ${(m.timingDev * 100).toFixed(0)}% ` +
        `噪声 ${m.noiseDb.toFixed(0)}dB 情绪差 ${m.emotionDist.toFixed(2)}`,
    );
  }

  render(): void {
    const nTakes = state.takeNames.length;
    const nSent = state.segs[state.refTake]?.sentences.length ?? 0;
    const w = LABEL_W + nTakes * COL_W;
    const h = HEADER_H + nSent * ROW_H;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = "11px monospace";

    // Header row: take names.
    for (let t = 0; t < nTakes; t++) {
      const x = LABEL_W + t * COL_W;
      g.fillStyle = takeColor(t);
      g.fillRect(x + 1, 1, COL_W - 2, 3);
      g.fillStyle = t === state.refTake ? "#ffd166" : "#d7dde6";
      const label = t === state.refTake ? `${state.takeNames[t]} ◆REF` : state.takeNames[t];
      g.fillText(label, x + PAD, 18, COL_W - 2 * PAD);
    }

    for (let s = 0; s < nSent; s++) {
      const y = HEADER_H + s * ROW_H;
      // Row label: sentence index + reference time range.
      const rs = state.segs[state.refTake].sentences[s];
      g.fillStyle = "#8a94a3";
      g.fillText(`S${s + 1}`, 8, y + 22);
      g.fillText(`${rs.start.toFixed(1)}–${rs.end.toFixed(1)}s`, 8, y + 38);
      if (s === state.selectedSentence) {
        g.fillStyle = "rgba(77,163,255,0.07)";
        g.fillRect(0, y, w, ROW_H);
      }
      for (let t = 0; t < nTakes; t++) {
        this.drawCell(s, t, LABEL_W + t * COL_W, y);
      }
    }

    // Grid lines.
    g.strokeStyle = "#2c333f";
    g.beginPath();
    for (let s = 0; s <= nSent; s++) {
      g.moveTo(0, HEADER_H + s * ROW_H + 0.5);
      g.lineTo(w, HEADER_H + s * ROW_H + 0.5);
    }
    for (let t = 0; t <= nTakes; t++) {
      g.moveTo(LABEL_W + t * COL_W + 0.5, 0);
      g.lineTo(LABEL_W + t * COL_W + 0.5, h);
    }
    g.stroke();
  }

  private drawCell(s: number, t: number, x: number, y: number): void {
    const g = this.g;
    const m = state.metrics[t]?.[s];
    const selected = state.choices[s] === t;
    if (selected) {
      g.fillStyle = takeColor(t, 0.16);
      g.fillRect(x + 1, y + 1, COL_W - 2, ROW_H - 2);
    }
    if (!m || m.srcSentence < 0) {
      g.fillStyle = "#4a5260";
      g.fillText("缺失", x + PAD, y + ROW_H / 2);
      return;
    }
    // Mini waveform of the sentence.
    const sent = state.segs[t].sentences[m.srcSentence];
    const pcm = state.pcm[t];
    const sr = state.sampleRate;
    const from = Math.floor(sent.start * sr);
    const to = Math.ceil(sent.end * sr);
    const waveW = COL_W - 2 * PAD;
    const waveH = 26;
    const waveY = y + 8;
    g.strokeStyle = takeColor(t, selected ? 1 : 0.75);
    g.beginPath();
    for (let px = 0; px < waveW; px++) {
      const a = from + Math.floor((px / waveW) * (to - from));
      const b = from + Math.floor(((px + 1) / waveW) * (to - from));
      let peak = 0;
      for (let k = a; k < b && k < to; k++) peak = Math.max(peak, Math.abs(pcm[k]));
      const hh = Math.max(0.5, peak * waveH);
      g.moveTo(x + PAD + px + 0.5, waveY + waveH / 2 - hh / 2);
      g.lineTo(x + PAD + px + 0.5, waveY + waveH / 2 + hh / 2);
    }
    g.stroke();

    // Badges: duration/timing, rhythm, noise, emotion.
    const ty = y + waveH + 20;
    g.fillStyle = "#d7dde6";
    g.fillText(`${m.duration.toFixed(2)}s`, x + PAD, ty);
    g.fillStyle = Math.abs(m.timingDev) > 0.12 ? "#ff8a5c" : "#7fc97f";
    g.fillText(`${m.timingDev >= 0 ? "+" : ""}${(m.timingDev * 100).toFixed(0)}%`, x + PAD + 46, ty);
    g.fillStyle = m.rhythm > 0.7 ? "#7fc97f" : m.rhythm > 0.4 ? "#ffd166" : "#ff8a5c";
    g.fillText(`♪${(m.rhythm * 100).toFixed(0)}`, x + PAD + 84, ty);
    const ty2 = ty + 13;
    g.fillStyle = m.noiseDb > -45 ? "#ff8a5c" : m.noiseDb > -55 ? "#ffd166" : "#7fc97f";
    g.fillText(`噪${m.noiseDb.toFixed(0)}`, x + PAD, ty2);
    g.fillStyle = m.emotionDist > 0.5 ? "#ff8a5c" : m.emotionDist > 0.25 ? "#ffd166" : "#7fc97f";
    g.fillText(`情${m.emotionDist.toFixed(2)}`, x + PAD + 46, ty2);

    if (selected) {
      g.strokeStyle = takeColor(t);
      g.lineWidth = 2;
      g.strokeRect(x + 1.5, y + 1.5, COL_W - 3, ROW_H - 3);
      g.lineWidth = 1;
    }
  }
}
