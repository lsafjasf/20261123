import {
  clamp,
  lerpRect,
  rectsEqual,
  smoothstep,
} from './geometry.ts';
import type {
  LayoutKeyframe,
  ManifestEvent,
  PanelId,
  PanelRects,
  Rect,
} from './types.ts';

export const PANEL_IDS: readonly PanelId[] = ['main', 'cams', 'map'] as const;

export interface LayoutSegment {
  index: number;
  startFrame: number;
  endFrame: number;
  label: string;
}

export interface LayoutSample {
  frame: number;
  rects: PanelRects;
  /** True while rects are animating between two keyframes. */
  transitioning: boolean;
  segmentIndex: number;
}

/**
 * Drives the three-panel layout from a keyframe timeline.
 *
 * The engine stores no identity of the media sources: swapping a file or
 * switching cameras only replaces the source bound to a panel, so the layout
 * timeline and the current frame position survive every cut ("切镜不重置").
 */
export class LayoutEngine {
  readonly frameRate: number;
  private keyframes: LayoutKeyframe[];
  private lastEmittedSegment = -1;

  constructor(frameRate: number, keyframes: LayoutKeyframe[]) {
    if (!Number.isFinite(frameRate) || frameRate <= 0) {
      throw new Error(`invalid frameRate: ${frameRate}`);
    }
    this.frameRate = frameRate;
    this.keyframes = [...keyframes].sort((a, b) => a.frame - b.frame);
    if (this.keyframes.length === 0) {
      throw new Error('LayoutEngine requires at least one keyframe');
    }
  }

  get durationFrames(): number {
    const last = this.keyframes[this.keyframes.length - 1];
    return last ? last.frame : 0;
  }

  get segments(): LayoutSegment[] {
    return this.keyframes.map((kf, index) => {
      const next = this.keyframes[index + 1];
      return {
        index,
        startFrame: kf.frame,
        endFrame: next ? next.frame : Number.POSITIVE_INFINITY,
        label: kf.label ?? `segment-${index + 1}`,
      };
    });
  }

  /** Defensive copy so callers cannot mutate the timeline in place. */
  get timeline(): LayoutKeyframe[] {
    return this.keyframes.map((kf) => ({
      frame: kf.frame,
      label: kf.label,
      rects: { ...kf.rects },
    }));
  }

  /** Reset edge-triggered segment tracking for a fresh export run. */
  resetEmission(): void {
    this.lastEmittedSegment = -1;
  }

  /**
   * Insert or replace a keyframe. Used for manual drag/resize edits and for
   * loading authored layouts. Existing keyframes on the same frame are replaced.
   */
  upsertKeyframe(keyframe: LayoutKeyframe): void {
    const idx = this.keyframes.findIndex((kf) => kf.frame === keyframe.frame);
    if (idx >= 0) this.keyframes[idx] = { ...keyframe };
    else this.keyframes.push({ ...keyframe });
    this.keyframes.sort((a, b) => a.frame - b.frame);
  }

  sample(frame: number): LayoutSample {
    const f = clamp(frame, 0, this.durationFrames);
    const atKey = this.keyframes.findIndex((kf) => kf.frame === f);
    if (atKey >= 0) {
      const first = this.keyframes[0];
      return {
        frame: f,
        rects: cloneRects(this.keyframes[atKey].rects),
        transitioning: false,
        segmentIndex: atKey,
      };
    }
    let hi = this.keyframes.findIndex((kf) => kf.frame > f);
    if (hi < 0) {
      const last = this.keyframes[this.keyframes.length - 1];
      return {
        frame: f,
        rects: cloneRects(last.rects),
        transitioning: false,
        segmentIndex: this.keyframes.length - 1,
      };
    }
    if (hi === 0) {
      const first = this.keyframes[0];
      return {
        frame: f,
        rects: cloneRects(first.rects),
        transitioning: false,
        segmentIndex: 0,
      };
    }
    const a = this.keyframes[hi - 1];
    const b = this.keyframes[hi];
    const span = b.frame - a.frame;
    const raw = span <= 0 ? 1 : (f - a.frame) / span;
    const t = smoothstep(raw);
    const rects = {} as PanelRects;
    for (const id of PANEL_IDS) {
      rects[id] = lerpRect(a.rects[id], b.rects[id], t);
    }
    return {
      frame: f,
      rects,
      transitioning: raw > 0 && raw < 1,
      segmentIndex: hi - 1,
    };
  }

  /**
   * Emit a layout-change event whenever the active keyframe segment changes.
   * Returns null while the same segment remains active. Smooth interpolation
   * inside a segment does not count as a layout change.
   */
  emitLayoutEvent(frame: number): ManifestEvent | null {
    const sample = this.sample(frame);
    if (sample.segmentIndex === this.lastEmittedSegment) return null;
    const previous = this.lastEmittedSegment;
    this.lastEmittedSegment = sample.segmentIndex;
    const kf = this.keyframes[sample.segmentIndex];
    return {
      frame: Math.round(frame),
      timeSec: Math.round(frame / this.frameRate * 1000) / 1000,
      type: 'layout-change',
      detail:
        previous < 0
          ? `initial layout: ${kf.label ?? `segment-${sample.segmentIndex + 1}`}`
          : `layout changed at segment ${sample.segmentIndex + 1}: ${
              kf.label ?? 'unnamed'
            }`,
    };
  }

  /** True when any panel rect actually moved compared with another sample. */
  static rectsChanged(a: PanelRects, b: PanelRects): boolean {
    return PANEL_IDS.some((id) => !rectsEqual(a[id], b[id]));
  }

  static clampRect(r: Rect): Rect {
    const w = clamp(r.w, 0.02, 1);
    const h = clamp(r.h, 0.02, 1);
    return {
      x: clamp(r.x, 0, 1 - w),
      y: clamp(r.y, 0, 1 - h),
      w,
      h,
    };
  }
}

function cloneRects(rects: PanelRects): PanelRects {
  const out = {} as PanelRects;
  for (const id of PANEL_IDS) out[id] = { ...rects[id] };
  return out;
}
