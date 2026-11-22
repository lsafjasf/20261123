// Detail view for the selected sentence: overlaid rhythm envelopes of all
// takes (normalized length) + per-take noise floor and emotion bars.

import { envelope } from "../shared/dsp.ts";
import { state } from "./state.ts";
import { takeColor } from "./gridview.ts";

const ENV_N = 96;
const H = 190;

export class DetailView {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d")!;
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

    const s = state.selectedSentence;
    const nTakes = state.takeNames.length;
    if (nTakes === 0 || state.metrics.length === 0) {
      g.fillStyle = "#8a94a3";
      g.fillText("加载 takes 后，这里显示选中句子的逐 take 对比。", 12, 24);
      return;
    }

    // Left: overlaid envelopes (rhythm shape, length-normalized).
    const envW = Math.floor(w * 0.55);
    const envH = 120;
    const envY = 26;
    g.fillStyle = "#8a94a3";
    g.fillText(`S${s + 1} 节奏包络重叠（已归一化长度/幅度）`, 12, 16);
    g.strokeStyle = "#2c333f";
    g.strokeRect(12.5, envY + 0.5, envW, envH);
    for (let t = 0; t < nTakes; t++) {
      const m = state.metrics[t][s];
      if (!m || m.srcSentence < 0) continue;
      const sent = state.segs[t].sentences[m.srcSentence];
      const env = envelope(state.pcm[t], state.sampleRate, sent.start, sent.end, ENV_N);
      let peak = 0;
      for (const v of env) peak = Math.max(peak, v);
      if (peak < 1e-9) continue;
      g.strokeStyle = takeColor(t, state.choices[s] === t ? 1 : 0.45);
      g.lineWidth = state.choices[s] === t ? 2 : 1;
      g.beginPath();
      for (let i = 0; i < ENV_N; i++) {
        const x = 12.5 + (i / (ENV_N - 1)) * envW;
        const y = envY + envH - (env[i] / peak) * (envH - 6) - 3;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
    g.lineWidth = 1;

    // Right: per-take noise floor + emotion distance bars.
    const barX = 12.5 + envW + 30;
    const barW = w - barX - 60;
    g.fillStyle = "#8a94a3";
    g.fillText("噪声底(dB) / 情绪差", barX, 16);
    const rowH = Math.min(13, (H - 34) / Math.max(1, nTakes));
    let noiseMin = Infinity;
    let noiseMax = -Infinity;
    let emoMax = 0.001;
    for (let t = 0; t < nTakes; t++) {
      const m = state.metrics[t][s];
      if (!m || m.srcSentence < 0) continue;
      noiseMin = Math.min(noiseMin, m.noiseDb);
      noiseMax = Math.max(noiseMax, m.noiseDb);
      emoMax = Math.max(emoMax, m.emotionDist);
    }
    const span = Math.max(6, noiseMax - noiseMin);
    for (let t = 0; t < nTakes; t++) {
      const m = state.metrics[t][s];
      if (!m || m.srcSentence < 0) continue;
      const y = 24 + t * rowH;
      const noiseFrac = (m.noiseDb - noiseMin) / span;
      g.fillStyle = takeColor(t, 0.85);
      g.fillRect(barX, y, Math.max(2, noiseFrac * barW * 0.6), rowH - 4);
      g.fillStyle = "#ff8a5c";
      g.fillRect(barX + barW * 0.65, y, (m.emotionDist / emoMax) * barW * 0.35, rowH - 4);
      g.fillStyle = state.choices[s] === t ? "#fff" : "#8a94a3";
      g.fillText(`${t + 1}`, barX - 14, y + rowH - 5);
      g.fillStyle = "#8a94a3";
      g.fillText(`${m.noiseDb.toFixed(0)}`, barX + Math.max(2, noiseFrac * barW * 0.6) + 4, y + rowH - 5);
    }
  }
}
