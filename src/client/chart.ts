// Minimal canvas line-chart with a playback cursor. No dependencies.

export interface Series {
  label: string;
  color: string;
  values: number[];
  dashed?: boolean;
}

export class Chart {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private series: Series[] = [];
  private cursor = -1;
  private title: string;

  constructor(canvas: HTMLCanvasElement, title: string) {
    this.canvas = canvas;
    this.title = title;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    this.ctx = ctx;
  }

  setSeries(series: Series[]): void {
    this.series = series;
    this.draw();
  }

  setCursor(index: number): void {
    this.cursor = index;
    this.draw();
  }

  draw(): void {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#14181f';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#9aa4b2';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(this.title, 8, 14);

    const all = this.series.flatMap((s) => s.values);
    if (!all.length) return;
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (hi - lo < 1e-6) { hi += 0.5; lo -= 0.5; }
    const pad = (hi - lo) * 0.1;
    lo -= pad; hi += pad;

    const n = Math.max(...this.series.map((s) => s.values.length));
    const left = 8, right = w - 8, top = 20, bottom = h - 8;
    const xOf = (i: number): number => left + (i / Math.max(1, n - 1)) * (right - left);
    const yOf = (v: number): number => bottom - ((v - lo) / (hi - lo)) * (bottom - top);

    ctx.strokeStyle = '#2a3140';
    ctx.beginPath();
    ctx.moveTo(left, yOf(0));
    ctx.lineTo(right, yOf(0));
    ctx.stroke();

    for (const s of this.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(s.dashed ? [4, 3] : []);
      ctx.beginPath();
      s.values.forEach((v, i) => (i ? ctx.lineTo(xOf(i), yOf(v)) : ctx.moveTo(xOf(i), yOf(v))));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = s.color;
      ctx.fillText(s.label, right - 8 - ctx.measureText(s.label).width, top + 12 + this.series.indexOf(s) * 12);
    }

    if (this.cursor >= 0 && this.cursor < n) {
      ctx.strokeStyle = '#e8c547';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xOf(this.cursor), top);
      ctx.lineTo(xOf(this.cursor), bottom);
      ctx.stroke();
    }
  }
}
