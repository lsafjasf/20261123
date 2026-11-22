/**
 * Canvas 可视化：只消费离线渲染产生的 BlockMetrics（确定性数据），
 * 绘制波形包络、总线峰值与三级保护增益。播放头位置由外部时钟驱动，
 * 不参与音频渲染，因此不影响可复现性。
 */

import type { BlockMetrics } from '../core/mixer.ts';
import { SAMPLE_RATE, BLOCK_SAMPLES } from '../core/types.ts';

export interface VisualizerColors {
  sfx: string;
  dialogue: string;
  danger: string;
  gain: string;
  waveform: string;
  grid: string;
}

const DEFAULT_COLORS: VisualizerColors = {
  sfx: '#7aa2f7',
  dialogue: '#9ece6a',
  danger: '#f7768e',
  gain: '#e0af68',
  waveform: '#c0caf5',
  grid: '#2a2e44',
};

export class MixVisualizer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly colors: VisualizerColors;

  private readonly canvas: HTMLCanvasElement;
  private readonly metrics: BlockMetrics[];

  constructor(
    canvas: HTMLCanvasElement,
    metrics: BlockMetrics[],
    colors: Partial<VisualizerColors> = {},
  ) {
    this.canvas = canvas;
    this.metrics = metrics;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 上下文不可用');
    this.ctx = ctx;
    this.colors = { ...DEFAULT_COLORS, ...colors };
  }

  get duration(): number {
    const last = this.metrics[this.metrics.length - 1];
    return last ? last.time + BLOCK_SAMPLES / SAMPLE_RATE : 0;
  }

  draw(playheadSeconds: number): void {
    const { width, height } = this.canvas;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);
    this.drawGrid(width, height);
    this.drawPeaks(height * 0.62, width, height);
    this.drawGainCurves(height * 0.62, height * 0.38, width, height);
    this.drawPlayhead(playheadSeconds, width, height);
    this.drawLegend(width, height);
  }

  private drawGrid(width: number, height: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 1;
    const step = width / 12;
    for (let i = 1; i < 12; i++) {
      const x = Math.round(step * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  private drawPeaks(top: number, width: number, _height: number): void {
    const ctx = this.ctx;
    const rows: Array<[keyof BlockMetrics, string]> = [
      ['sfxPeak', this.colors.sfx],
      ['dialoguePeak', this.colors.dialogue],
      ['dangerPeak', this.colors.danger],
    ];
    rows.forEach(([key, color], row) => {
      const base = (top / rows.length) * (row + 1) - 4;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      this.metrics.forEach((m, i) => {
        const x = (i / Math.max(1, this.metrics.length - 1)) * width;
        const value = m[key] as number;
        const y = base - Math.min(1, value) * (top / rows.length - 8);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }

  private drawGainCurves(
    top: number,
    panelHeight: number,
    width: number,
    _height: number,
  ): void {
    const ctx = this.ctx;
    const curves: Array<[keyof BlockMetrics, string]> = [
      ['sidechainGain', this.colors.sfx],
      ['overloadGain', this.colors.gain],
      ['limiterGain', this.colors.danger],
    ];
    curves.forEach(([key, color]) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      this.metrics.forEach((m, i) => {
        const x = (i / Math.max(1, this.metrics.length - 1)) * width;
        const value = m[key] as number;
        const y = top + (1 - value) * (panelHeight - 18);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }

  private drawPlayhead(seconds: number, width: number, height: number): void {
    const x = (seconds / Math.max(1e-6, this.duration)) * width;
    const ctx = this.ctx;
    ctx.strokeStyle = this.colors.waveform;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawLegend(width: number, height: number): void {
    const ctx = this.ctx;
    ctx.font = '11px monospace';
    const labels: Array<[string, string]> = [
      ['sfx', this.colors.sfx],
      ['dialogue', this.colors.dialogue],
      ['danger', this.colors.danger],
      ['sidechain/overload/limiter', this.colors.gain],
    ];
    let x = 8;
    labels.forEach(([text, color]) => {
      ctx.fillStyle = color;
      ctx.fillText(text, x, height - 6);
      x += ctx.measureText(text).width + 16;
    });
    ctx.fillStyle = this.colors.waveform;
    ctx.fillText(`blocks=${this.metrics.length}`, width - 90, height - 6);
  }
}
