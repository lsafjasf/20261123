import { LayoutEngine } from '/shared/layout.ts';
import type {
  HudZone,
  OcclusionResult,
  PanelId,
  PanelRects,
} from '/shared/types.ts';
import type { DrawableSource } from './synthetic-source.ts';

const PANEL_ORDER: PanelId[] = ['map', 'cams', 'main'];

/**
 * Single rendering path shared by the live preview and the exported video.
 * Export and preview therefore cannot drift: both call renderFrame() with the
 * same LayoutEngine sample. HUD overlays are drawn in the main panel's local
 * space and move with the panel.
 */
export class Compositor {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sources = new Map<PanelId, DrawableSource>();
  private readonly hudZones: HudZone[];

  constructor(
    canvas: HTMLCanvasElement,
    hudZones: HudZone[],
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.hudZones = hudZones;
  }

  bindSource(panel: PanelId, source: DrawableSource): void {
    this.sources.set(panel, source);
  }

  sourceFor(panel: PanelId): DrawableSource | undefined {
    return this.sources.get(panel);
  }

  pixelRect(rects: PanelRects, panel: PanelId): DOMRect {
    const rect = rects[panel];
    return new DOMRect(
      Math.round(rect.x * this.canvas.width),
      Math.round(rect.y * this.canvas.height),
      Math.round(rect.w * this.canvas.width),
      Math.round(rect.h * this.canvas.height),
    );
  }

  renderFrame(
    sample: ReturnType<LayoutEngine['sample']>,
    timeSec: number,
    occlusion: OcclusionResult[],
  ): void {
    const { ctx } = this;
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    for (const panel of PANEL_ORDER) {
      const source = this.sources.get(panel);
      const rect = this.pixelRect(sample.rects, panel);
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      if (source) source.draw(ctx, rect, timeSec);
      else this.drawPlaceholder(rect, panel);
      ctx.restore();
      this.drawBorder(panel, rect, sample.transitioning);
    }

    this.drawHud(sample.rects, occlusion);
  }

  private drawPlaceholder(rect: DOMRect, panel: PanelId): void {
    this.ctx.fillStyle = '#11151c';
    this.ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    this.ctx.fillStyle = '#5c6675';
    this.ctx.font = '14px monospace';
    this.ctx.fillText(`no source: ${panel}`, rect.x + 10, rect.y + 24);
  }

  private drawBorder(
    panel: PanelId,
    rect: DOMRect,
    transitioning: boolean,
  ): void {
    this.ctx.strokeStyle = transitioning ? '#ffd166' : '#2b3547';
    this.ctx.lineWidth = transitioning ? 3 : 1;
    this.ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    const grip = 8;
    this.ctx.fillStyle = transitioning ? '#ffd166' : '#5b6b84';
    this.ctx.beginPath();
    this.ctx.moveTo(rect.x + rect.width, rect.y + rect.height - grip);
    this.ctx.lineTo(rect.x + rect.width, rect.y + rect.height);
    this.ctx.lineTo(rect.x + rect.width - grip, rect.y + rect.height);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.fillStyle = '#8fa3c0';
    this.ctx.font = '12px monospace';
    this.ctx.fillText(panel, rect.x + 6, rect.y + 14);
  }

  private drawHud(
    rects: PanelRects,
    occlusion: OcclusionResult[],
  ): void {
    const main = this.pixelRect(rects, 'main');
    const byZone = new Map(occlusion.map((r) => [r.zoneId, r]));
    for (const zone of this.hudZones) {
      const x = main.x + zone.rect.x * main.width;
      const y = main.y + zone.rect.y * main.height;
      const w = zone.rect.w * main.width;
      const h = zone.rect.h * main.height;
      const result = byZone.get(zone.id);
      const color =
        result?.level === 'blocked'
          ? '#ff4d4d'
          : result?.level === 'partial'
            ? '#ffd166'
            : '#35d98c';
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([6, 4]);
      this.ctx.strokeRect(x, y, w, h);
      this.ctx.setLineDash([]);
      this.ctx.fillStyle = color;
      this.ctx.font = '11px monospace';
      this.ctx.fillText(zone.label, x + 2, y > 14 ? y - 3 : y + h + 12);
    }
  }

  snapshot(): Uint8ClampedArray {
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
      .data;
  }

  snapshotAtWidth(width: number): Uint8ClampedArray {
    const scale = width / this.canvas.width;
    const height = Math.round(this.canvas.height * scale);
    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    const ctx = offscreen.getContext('2d', { alpha: false });
    if (!ctx) return this.snapshot();
    ctx.drawImage(this.canvas, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
  }
}
