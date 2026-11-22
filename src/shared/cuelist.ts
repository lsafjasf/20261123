// Foley cue list model + deterministic serialization.
//
// Round-trip guarantee: positions are stored ONLY as integers
// (frame + offsetSamples) alongside the rational frame rate and the
// sample rate. No float seconds ever touch the file, so a list that is
// exported and re-imported yields bit-identical trigger samples.

import { frameToSample, type FrameRate } from './timebase.ts';

export const CUE_FORMAT = 'foley-cues/1' as const;

export const SOUND_KINDS = [
  'footstep-l',
  'footstep-r',
  'impact',
  'door-latch',
  'door-creak',
  'door-thud',
] as const;

export type SoundKind = (typeof SOUND_KINDS)[number];

export interface Cue {
  id: string;
  frame: number; // integer frame in the project's frame rate
  offsetSamples: number; // signed fine-tune offset, in samples
  sound: SoundKind;
  gain: number; // 0..1, quantized to 1e-6 on export
  label: string;
}

export interface CueList {
  format: typeof CUE_FORMAT;
  fpsNum: number;
  fpsDen: number;
  sampleRate: number;
  cues: Cue[];
}

export function createCueList(rate: FrameRate, sampleRate: number): CueList {
  return { format: CUE_FORMAT, fpsNum: rate.num, fpsDen: rate.den, sampleRate, cues: [] };
}

export function listFrameRate(list: CueList): FrameRate {
  return { num: list.fpsNum, den: list.fpsDen };
}

/** Absolute trigger sample of a cue — the single source of truth for playback. */
export function triggerSample(cue: Cue, list: CueList): number {
  return frameToSample(cue.frame, listFrameRate(list), list.sampleRate) + cue.offsetSamples;
}

export function sortCues(cues: Cue[]): Cue[] {
  return [...cues].sort(
    (a, b) => a.frame - b.frame || a.offsetSamples - b.offsetSamples || a.id.localeCompare(b.id),
  );
}

function quantizeGain(gain: number): number {
  return Math.round(gain * 1e6) / 1e6;
}

/** Deterministic JSON: sorted cues, fixed key order, quantized gains. */
export function serializeCueList(list: CueList): string {
  const cues = sortCues(list.cues).map((c) => ({
    id: c.id,
    frame: c.frame,
    offsetSamples: c.offsetSamples,
    sound: c.sound,
    gain: quantizeGain(c.gain),
    label: c.label,
  }));
  const doc = {
    format: list.format,
    fpsNum: list.fpsNum,
    fpsDen: list.fpsDen,
    sampleRate: list.sampleRate,
    cues,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

function isSoundKind(v: unknown): v is SoundKind {
  return typeof v === 'string' && (SOUND_KINDS as readonly string[]).includes(v);
}

function parseCue(v: unknown, index: number): Cue {
  if (typeof v !== 'object' || v === null) throw new SyntaxError(`cue[${index}] is not an object`);
  const c = v as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) throw new SyntaxError(`cue[${index}].id`);
  if (!Number.isInteger(c.frame)) throw new SyntaxError(`cue[${index}].frame must be an integer`);
  if (!Number.isInteger(c.offsetSamples))
    throw new SyntaxError(`cue[${index}].offsetSamples must be an integer`);
  if (!isSoundKind(c.sound)) throw new SyntaxError(`cue[${index}].sound is invalid`);
  if (typeof c.gain !== 'number' || !(c.gain >= 0 && c.gain <= 1))
    throw new SyntaxError(`cue[${index}].gain must be in [0,1]`);
  return {
    id: c.id,
    frame: c.frame as number,
    offsetSamples: c.offsetSamples as number,
    sound: c.sound,
    gain: c.gain,
    label: typeof c.label === 'string' ? c.label : '',
  };
}

/** Strict parse. Positions come from integer fields only; nothing is recomputed. */
export function parseCueList(json: string): CueList {
  const doc: unknown = JSON.parse(json);
  if (typeof doc !== 'object' || doc === null) throw new SyntaxError('cue list is not an object');
  const d = doc as Record<string, unknown>;
  if (d.format !== CUE_FORMAT) throw new SyntaxError(`unsupported format ${String(d.format)}`);
  if (!Number.isInteger(d.fpsNum) || !Number.isInteger(d.fpsDen) || (d.fpsNum as number) <= 0 || (d.fpsDen as number) <= 0)
    throw new SyntaxError('invalid frame rate');
  if (!Number.isInteger(d.sampleRate) || (d.sampleRate as number) <= 0)
    throw new SyntaxError('invalid sampleRate');
  if (!Array.isArray(d.cues)) throw new SyntaxError('cues must be an array');
  const cues = d.cues.map((c, i) => parseCue(c, i));
  const ids = new Set(cues.map((c) => c.id));
  if (ids.size !== cues.length) throw new SyntaxError('duplicate cue ids');
  return {
    format: CUE_FORMAT,
    fpsNum: d.fpsNum as number,
    fpsDen: d.fpsDen as number,
    sampleRate: d.sampleRate as number,
    cues,
  };
}

/** Deep-compare two lists by trigger-relevant content (order-insensitive). */
export function cueListsEqual(a: CueList, b: CueList): boolean {
  if (a.fpsNum !== b.fpsNum || a.fpsDen !== b.fpsDen || a.sampleRate !== b.sampleRate) return false;
  const ca = sortCues(a.cues);
  const cb = sortCues(b.cues);
  if (ca.length !== cb.length) return false;
  return ca.every(
    (c, i) =>
      c.id === cb[i].id &&
      c.frame === cb[i].frame &&
      c.offsetSamples === cb[i].offsetSamples &&
      c.sound === cb[i].sound &&
      quantizeGain(c.gain) === quantizeGain(cb[i].gain) &&
      c.label === cb[i].label,
  );
}
