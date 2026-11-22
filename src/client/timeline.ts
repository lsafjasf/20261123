// Timeline ruler: frame ticks, scene-event ticks, cue markers, playhead,
// and in/out range selection by dragging.

import type { Cue } from '../shared/cuelist.ts';
import { sceneEvents, eventFrame, SCENE_DURATION } from '../shared/scene.ts';

const KIND_COLORS: Record<string, string> = {
  'footstep-l': '#e8b64c',
  'footstep-r': '#d9a53a',
  impact: '#5ac8fa',
  'door-latch': '#b48ef2',
  'door-creak': '#9a6ef0',
  'door-thud': '#7d4fe0',
};

export class Timeline {
  onSeek: ((frame: number) => void) | null = null;
  onRange: ((from: number, to: number) => void) | null = null;

  private canvas: HTMLCanvasElement;
  private dragStart: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('pointerdown', (e) => {
      this.dragStart = this.frameAt(e);
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.dragStart === null) return;
      const f = this.frameAt(e);
      this.onRange?.(Math.min(this.dragStart, f), Math.max(this.dragStart, f));
    });
    canvas.addEventListener('pointerup', (e) => {
      if (this.dragStart === null) return;
      const f = this.frameAt(e);
      if (f === this.dragStart) this.onSeek?.(f);
      else this.onRange?.(Math.min(this.dragStart, f), Math.max(this.dragStart, f));
      this.dragStart = null;
    });
  }

  private frameAt(e: PointerEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    const total = this.totalFrames();
    const x = (e.clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(total, Math.round(x * total)));
  }

  private totalFrames(): number {
    return Math.ceil(SCENE_DURATION * this.fps);
  }

  private fps = 24;

  render(currentFrame: number, cues: Cue[], fps: number, rangeIn: number, rangeOut: number): void {
    this.fps = fps;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const total = this.totalFrames();
    const xOf = (f: number) => (f / total) * w;

    ctx.fillStyle = '#0f141b';
    ctx.fillRect(0, 0, w, h);

    // selected range
    ctx.fillStyle = 'rgba(90, 200, 250, 0.12)';
    ctx.fillRect(xOf(rangeIn), 0, xOf(rangeOut) - xOf(rangeIn), h);

    // frame ticks: adapt step to keep ticks readable
    const tickSteps = [1, 2, 5, 10, 12, 24, 25, 30, 50, 60, 120];
    const step = tickSteps.find((s) => xOf(s) > 9) ?? 240;
    ctx.strokeStyle = '#2a3138';
    ctx.fillStyle = '#8b96a3';
    ctx.font = '9px monospace';
    ctx.beginPath();
    for (let f = 0; f <= total; f += step) {
      const x = xOf(f);
      ctx.moveTo(x, h - 10);
      ctx.lineTo(x, h);
      if (xOf(step) > 34 || f % (step * 2) === 0) ctx.fillText(String(f), x + 2, h - 12);
    }
    ctx.stroke();

    // scene events (where the picture asks for sound)
    for (const ev of sceneEvents()) {
      const x = xOf(eventFrame(ev, fps));
      ctx.strokeStyle = KIND_COLORS[ev.kind] ?? '#666';
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.moveTo(x, 14);
      ctx.lineTo(x, h - 12);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // cue markers
    for (const cue of cues) {
      const x = xOf(cue.frame);
      ctx.fillStyle = KIND_COLORS[cue.sound] ?? '#ccc';
      ctx.beginPath();
      ctx.moveTo(x, 2);
      ctx.lineTo(x - 4, 12);
      ctx.lineTo(x + 4, 12);
      ctx.closePath();
      ctx.fill();
    }

    // playhead
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xOf(currentFrame), 0);
    ctx.lineTo(xOf(currentFrame), h);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}
