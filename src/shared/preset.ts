import type { HudZone, LayoutKeyframe } from './types.ts';

export const DEFAULT_FRAME_RATE = 30;
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;

/**
 * Authored multiview layout for a 20-second (600-frame) coaching clip.
 * Panels reposition/resize across segments; the engine smooths every change
 * with smoothstep interpolation instead of hard jumps.
 */
export function defaultKeyframes(): LayoutKeyframe[] {
  return [
    {
      frame: 0,
      label: 'draft view',
      rects: {
        main: { x: 0, y: 0, w: 0.72, h: 1 },
        cams: { x: 0.72, y: 0, w: 0.28, h: 0.5 },
        map: { x: 0.72, y: 0.5, w: 0.28, h: 0.5 },
      },
    },
    {
      frame: 150,
      label: 'lane phase',
      rects: {
        main: { x: 0, y: 0, w: 0.6, h: 0.75 },
        cams: { x: 0.6, y: 0, w: 0.4, h: 0.45 },
        map: { x: 0.6, y: 0.45, w: 0.4, h: 0.55 },
      },
    },
    {
      frame: 330,
      label: 'team fight',
      rects: {
        main: { x: 0.18, y: 0, w: 0.82, h: 0.7 },
        cams: { x: 0, y: 0.25, w: 0.24, h: 0.45 },
        map: { x: 0.3, y: 0.7, w: 0.4, h: 0.3 },
      },
    },
    {
      frame: 480,
      label: 'post fight review',
      rects: {
        main: { x: 0, y: 0.1, w: 0.66, h: 0.9 },
        cams: { x: 0.66, y: 0.1, w: 0.34, h: 0.4 },
        map: { x: 0.66, y: 0.5, w: 0.34, h: 0.5 },
      },
    },
  ];
}

/**
 * Key HUD regions on the main broadcast feed, expressed in the main panel's
 * local coordinate space so they follow the panel as the layout animates.
 */
export function defaultHudZones(): HudZone[] {
  return [
    {
      id: 'scoreboard',
      label: 'Top scoreboard',
      rect: { x: 0.25, y: 0.0, w: 0.5, h: 0.12 },
      tolerance: 0.1,
    },
    {
      id: 'killfeed',
      label: 'Kill feed',
      rect: { x: 0.82, y: 0.12, w: 0.18, h: 0.28 },
      tolerance: 0.15,
    },
    {
      id: 'ability-bar',
      label: 'Ability bar',
      rect: { x: 0.35, y: 0.88, w: 0.3, h: 0.12 },
      tolerance: 0.1,
    },
  ];
}
