import { coveredFraction } from './geometry.ts';
import type {
  HudZone,
  ManifestEvent,
  OcclusionLevel,
  OcclusionResult,
  PanelId,
  PanelRects,
} from './types.ts';

const BLOCKED_RATIO = 0.85;

/**
 * Occlusion monitor for key HUD zones on the main feed.
 *
 * HUD zones are authored in the main panel's local coordinate space, so they
 * track the main panel as it moves. Other panels are tested as occluders in
 * canvas-normalized space. State is edge-triggered: manifest events are only
 * emitted when a zone enters or leaves an alert state, not on every frame.
 */
export class OcclusionMonitor {
  private readonly zones: HudZone[];
  private readonly levels = new Map<string, OcclusionLevel>();

  constructor(zones: HudZone[]) {
    this.zones = zones.map((z) => ({ ...z, rect: { ...z.rect } }));
    for (const zone of this.zones) this.levels.set(zone.id, 'clear');
  }

  /** Convert a local HUD rect into canvas-normalized space. */
  private static toCanvas(
    local: HudZone['rect'],
    panel: PanelRects[PanelId],
  ): HudZone['rect'] {
    return {
      x: panel.x + local.x * panel.w,
      y: panel.y + local.y * panel.h,
      w: local.w * panel.w,
      h: local.h * panel.h,
    };
  }

  evaluate(
    rects: PanelRects,
    frame: number,
    frameRate: number,
  ): { results: OcclusionResult[]; events: ManifestEvent[] } {
    const results: OcclusionResult[] = [];
    const events: ManifestEvent[] = [];
    const occluders: PanelId[] = ['cams', 'map'];

    for (const zone of this.zones) {
      const canvasZone = OcclusionMonitor.toCanvas(zone.rect, rects.main);
      let covered = 0;
      for (const id of occluders) {
        covered = Math.max(covered, coveredFraction(canvasZone, rects[id]));
      }
      const level: OcclusionLevel =
        covered >= BLOCKED_RATIO
          ? 'blocked'
          : covered > zone.tolerance
            ? 'partial'
            : 'clear';
      results.push({ zoneId: zone.id, level, covered });

      const previous = this.levels.get(zone.id) ?? 'clear';
      if (level !== previous) {
        this.levels.set(zone.id, level);
        events.push({
          frame: Math.round(frame),
          timeSec: Math.round((frame / frameRate) * 1000) / 1000,
          type: level === 'clear' ? 'occlusion-clear' : 'occlusion',
          zoneId: zone.id,
          level,
          detail:
            level === 'clear'
              ? `HUD zone "${zone.label}" is visible again`
              : `HUD zone "${zone.label}" ${level} (${(covered * 100).toFixed(1)}% covered)`,
        });
      }
    }
    return { results, events };
  }

  get currentLevels(): ReadonlyMap<string, OcclusionLevel> {
    return this.levels;
  }

  /** Clear edge-triggered state so a new export run starts from "clear". */
  reset(): void {
    for (const zone of this.zones) this.levels.set(zone.id, 'clear');
  }
}
