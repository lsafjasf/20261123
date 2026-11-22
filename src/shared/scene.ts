// Parametric demo animation: a single source of truth for both the
// canvas preview and the foley cue auto-generation, so picture and
// sound are aligned by construction.
//
// Timeline (seconds):
//   0.00 - 5.00  walker crosses the stage, footsteps every 0.5 s
//   5.00 - 8.50  ball drops and bounces (impacts from physics sim)
//   8.50 - 12.00 door unlatches, creaks open, thuds against the stop

import type { SoundKind } from './cuelist.ts';

export const SCENE_DURATION = 12; // seconds

export interface SceneEvent {
  t: number; // seconds
  kind: SoundKind;
  label: string;
}

// --- Act 1: walker -------------------------------------------------------
export const WALK_START = 0;
export const WALK_END = 5;
export const STEP_INTERVAL = 0.5;
export const FIRST_STEP_T = 0.25;

/** Walker horizontal position, 0..1 across the stage. */
export function walkerX(t: number): number {
  if (t <= WALK_START) return 0;
  if (t >= WALK_END) return 1;
  return (t - WALK_START) / (WALK_END - WALK_START);
}

/** Leg swing phase in radians; feet plant at multiples of STEP_INTERVAL. */
export function walkerPhase(t: number): number {
  return (Math.PI * 2 * (t - FIRST_STEP_T)) / STEP_INTERVAL;
}

// --- Act 2: bouncing ball --------------------------------------------------
export const BOUNCE_START = 5;
export const BOUNCE_END = 8.5;
const GRAVITY = 9.8; // stage-units / s^2 (stage height = 1)
const RESTITUTION = 0.55;
const BALL_START_HEIGHT = 0.9;
const SIM_DT = 1 / 4800;

export interface BounceSim {
  /** height above floor (0..1) at time t, or null outside the act */
  heightAt(t: number): number | null;
  impacts: number[]; // impact times in seconds
}

let cachedSim: BounceSim | null = null;

export function ballSim(): BounceSim {
  if (cachedSim) return cachedSim;
  const samples: number[] = [];
  const impacts: number[] = [];
  let y = BALL_START_HEIGHT;
  let v = 0;
  const n = Math.round((BOUNCE_END - BOUNCE_START) / SIM_DT);
  for (let i = 0; i <= n; i++) {
    samples.push(y);
    v -= GRAVITY * SIM_DT;
    y += v * SIM_DT;
    if (y <= 0 && v < 0) {
      y = 0;
      if (v < -0.2) impacts.push(BOUNCE_START + i * SIM_DT);
      v = -v * RESTITUTION;
    }
  }
  cachedSim = {
    impacts,
    heightAt(t: number): number | null {
      if (t < BOUNCE_START || t > BOUNCE_END) return null;
      const i = Math.min(n, Math.max(0, Math.round((t - BOUNCE_START) / SIM_DT)));
      return samples[i];
    },
  };
  return cachedSim;
}

// --- Act 3: door -----------------------------------------------------------
export const DOOR_START = 8.5;
export const DOOR_LATCH_T = 8.75;
export const CREAK_START_T = 9.0;
export const CREAK_END_T = 11.0;
export const DOOR_THUD_T = 11.2;

/** Door swing angle in radians (0 = closed). Eased swing during the creak. */
export function doorAngle(t: number): number {
  const maxAngle = Math.PI / 2.4;
  if (t <= CREAK_START_T) return 0;
  if (t >= DOOR_THUD_T) return maxAngle;
  const p = (t - CREAK_START_T) / (DOOR_THUD_T - CREAK_START_T);
  // ease-in-out with a slight sticky judder, like a real hinge
  const eased = p * p * (3 - 2 * p);
  const judder = 0.02 * Math.sin(p * 40) * (1 - p);
  return maxAngle * Math.max(0, eased + judder);
}

// --- Events -----------------------------------------------------------------
let cachedEvents: SceneEvent[] | null = null;

/** All sound-worthy moments in the scene, in time order. */
export function sceneEvents(): SceneEvent[] {
  if (cachedEvents) return cachedEvents;
  const events: SceneEvent[] = [];
  let side = 0;
  for (let t = FIRST_STEP_T; t < WALK_END; t += STEP_INTERVAL) {
    events.push({
      t,
      kind: side % 2 === 0 ? 'footstep-l' : 'footstep-r',
      label: `step ${side + 1}`,
    });
    side++;
  }
  ballSim().impacts.forEach((t, i) => events.push({ t, kind: 'impact', label: `bounce ${i + 1}` }));
  events.push({ t: DOOR_LATCH_T, kind: 'door-latch', label: 'latch' });
  events.push({ t: CREAK_START_T, kind: 'door-creak', label: 'creak' });
  events.push({ t: DOOR_THUD_T, kind: 'door-thud', label: 'thud' });
  events.sort((a, b) => a.t - b.t);
  cachedEvents = events;
  return events;
}

/** Frame index for an event at the given fps (nearest frame). */
export function eventFrame(event: SceneEvent, fps: number): number {
  return Math.round(event.t * fps);
}
