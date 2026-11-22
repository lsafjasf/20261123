import { LayoutEngine } from '/shared/layout.ts';
import type { PanelId, PanelRects, Rect } from '/shared/types.ts';

type DragMode = 'move' | 'resize';

interface DragState {
  panel: PanelId;
  mode: DragMode;
  startPointer: { x: number; y: number };
  startRect: Rect;
}

const HANDLE_SIZE = 18;

/**
 * Pointer-driven panel editing. All math is converted into normalized canvas
 * space before touching the layout, so edits are resolution independent.
 * A manual edit upserts a keyframe at the current frame; it never resets the
 * timeline and never changes which source is bound to the panel.
 */
export class InteractionController {
  private readonly canvas: HTMLCanvasElement;
  private readonly engine: LayoutEngine;
  private readonly getFrame: () => number;
  private readonly onEdit: () => void;
  private drag: DragState | null = null;
  private currentRects: PanelRects | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    engine: LayoutEngine,
    getFrame: () => number,
    onEdit: () => void,
  ) {
    this.canvas = canvas;
    this.engine = engine;
    this.getFrame = getFrame;
    this.onEdit = onEdit;
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
  }

  setRects(rects: PanelRects): void {
    this.currentRects = rects;
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
  }

  private toNormalized(event: PointerEvent): { x: number; y: number } {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    };
  }

  private hitHandle(rect: Rect, point: { x: number; y: number }): boolean {
    const hx = rect.x + rect.w;
    const hy = rect.y + rect.h;
    const threshold = HANDLE_SIZE / this.canvas.getBoundingClientRect().width;
    return (
      point.x >= hx - threshold &&
      point.x <= hx + threshold &&
      point.y >= hy - threshold &&
      point.y <= hy + threshold
    );
  }

  private hitPanel(point: { x: number; y: number }): PanelId | null {
    if (!this.currentRects) return null;
    const order: PanelId[] = ['cams', 'map', 'main'];
    for (const panel of order) {
      const rect = this.currentRects[panel];
      if (
        point.x >= rect.x &&
        point.x <= rect.x + rect.w &&
        point.y >= rect.y &&
        point.y <= rect.y + rect.h
      ) {
        return panel;
      }
    }
    return null;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    const point = this.toNormalized(event);
    const panel = this.hitPanel(point);
    if (!panel || !this.currentRects) return;
    const mode: DragMode = this.hitHandle(this.currentRects[panel], point)
      ? 'resize'
      : 'move';
    this.canvas.setPointerCapture(event.pointerId);
    this.drag = {
      panel,
      mode,
      startPointer: point,
      startRect: { ...this.currentRects[panel] },
    };
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.drag || !this.currentRects) return;
    const point = this.toNormalized(event);
    const dx = point.x - this.drag.startPointer.x;
    const dy = point.y - this.drag.startPointer.y;
    const base = this.drag.startRect;
    const next: Rect =
      this.drag.mode === 'resize'
        ? { ...base, w: base.w + dx, h: base.h + dy }
        : { ...base, x: base.x + dx, y: base.y + dy };
    this.currentRects[this.drag.panel] = LayoutEngine.clampRect(next);
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.drag || !this.currentRects) return;
    const frame = Math.round(this.getFrame());
    this.engine.upsertKeyframe({
      frame,
      rects: this.cloneRects(this.currentRects),
      label: `manual edit @${frame}`,
    });
    this.drag = null;
    this.canvas.releasePointerCapture(event.pointerId);
    this.onEdit();
  };

  private cloneRects(rects: PanelRects): PanelRects {
    return {
      main: { ...rects.main },
      cams: { ...rects.cams },
      map: { ...rects.map },
    };
  }
}
