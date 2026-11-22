import type { PanelId } from '/shared/types.ts';

export interface DrawableSource {
  readonly id: string;
  readonly label: string;
  draw(ctx: CanvasRenderingContext2D, rect: DOMRect, timeSec: number): void;
  /** Grayscale thumbnail used by the cut detector. */
  thumbnail(ctx: CanvasRenderingContext2D, size: number, timeSec: number): Uint8ClampedArray;
}

const PALETTE: Record<PanelId, { bg: string; fg: string; accent: string }> = {
  main: { bg: '#10243d', fg: '#9fd0ff', accent: '#39a0ff' },
  cams: { bg: '#2a1638', fg: '#e3b8ff', accent: '#b05cff' },
  map: { bg: '#103026', fg: '#a9f0cf', accent: '#35d98c' },
};

/**
 * Deterministic canvas-generated feed. Lets the whole pipeline run without
 * external files or network assets. A hard color flip every 4 seconds on the
 * cams panel simulates a camera cut so cut detection can be demonstrated.
 */
export class SyntheticFeed implements DrawableSource {
  readonly id: string;
  readonly label: string;
  private readonly panel: PanelId;

  constructor(panel: PanelId, index: number) {
    this.panel = panel;
    this.id = `synthetic-${panel}`;
    this.label = `Synthetic ${panel} #${index + 1}`;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    rect: DOMRect,
    timeSec: number,
  ): void {
    const colors = PALETTE[this.panel];
    const cutPhase = this.panel === 'cams' ? Math.floor(timeSec / 4) % 2 : 0;
    ctx.save();
    ctx.fillStyle = cutPhase ? '#3a1020' : colors.bg;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2);

    if (this.panel === 'map') this.drawMap(ctx, rect, timeSec);
    else this.drawMotion(ctx, rect, timeSec, colors);

    ctx.fillStyle = colors.fg;
    ctx.font = `${Math.max(12, rect.height * 0.08)}px monospace`;
    ctx.fillText(
      `${this.panel.toUpperCase()}  t=${timeSec.toFixed(2)}s`,
      rect.x + 10,
      rect.y + 24,
    );
    ctx.restore();
  }

  private drawMotion(
    ctx: CanvasRenderingContext2D,
    rect: DOMRect,
    timeSec: number,
    colors: { fg: string; accent: string },
  ): void {
    const cx = rect.x + rect.width * (0.5 + 0.35 * Math.sin(timeSec * 1.4));
    const cy = rect.y + rect.height * (0.5 + 0.3 * Math.cos(timeSec * 1.1));
    ctx.fillStyle = colors.accent;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(rect.width, rect.height) * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colors.fg;
    for (let i = 0; i < 4; i += 1) {
      const y = rect.y + rect.height * (0.3 + i * 0.12);
      ctx.fillRect(rect.x + 12, y, rect.width * 0.22, 4);
    }
  }

  private drawMap(
    ctx: CanvasRenderingContext2D,
    rect: DOMRect,
    timeSec: number,
  ): void {
    ctx.strokeStyle = 'rgba(169,240,207,0.35)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i += 1) {
      const x = rect.x + (rect.width * i) / 5;
      ctx.beginPath();
      ctx.moveTo(x, rect.y);
      ctx.lineTo(x, rect.y + rect.height);
      ctx.stroke();
      const y = rect.y + (rect.height * i) / 5;
      ctx.beginPath();
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.width, y);
      ctx.stroke();
    }
    for (let i = 0; i < 6; i += 1) {
      const angle = timeSec + i;
      const x = rect.x + rect.width * (0.5 + 0.35 * Math.cos(angle));
      const y = rect.y + rect.height * (0.5 + 0.35 * Math.sin(angle * 1.3));
      ctx.fillStyle = i % 2 ? '#35d98c' : '#ffd166';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  thumbnail(
    ctx: CanvasRenderingContext2D,
    size: number,
    timeSec: number,
  ): Uint8ClampedArray {
    const image = ctx.getImageData(0, 0, size, size).data;
    const gray = new Uint8ClampedArray(size * size);
    for (let i = 0, j = 0; i < image.length; i += 4, j += 1) {
      gray[j] = Math.round(
        image[i] * 0.299 + image[i + 1] * 0.587 + image[i + 2] * 0.114,
      );
    }
    return gray;
  }
}
