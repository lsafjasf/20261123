// Cue store: editing operations (nudge, overlap, generate) and
// lossless export/import. UI-independent so it stays testable.

import {
  createCueList,
  serializeCueList,
  parseCueList,
  cueListsEqual,
  triggerSample,
  sortCues,
  listFrameRate,
  type Cue,
  type CueList,
  type SoundKind,
} from '../shared/cuelist.ts';
import { frameToSample, type FrameRate } from '../shared/timebase.ts';
import { sceneEvents, eventFrame } from '../shared/scene.ts';

export class CueStore {
  private list: CueList;
  private nextId = 1;
  onchange: (() => void) | null = null;

  constructor(rate: FrameRate, sampleRate: number) {
    this.list = createCueList(rate, sampleRate);
  }

  get cues(): Cue[] {
    return sortCues(this.list.cues);
  }

  get cueList(): CueList {
    return this.list;
  }

  private emit(): void {
    this.onchange?.();
  }

  private allocId(): string {
    let id: string;
    do {
      id = `cue-${this.nextId++}`;
    } while (this.list.cues.some((c) => c.id === id));
    return id;
  }

  addCue(frame: number, sound: SoundKind, gain = 1, label = '', offsetSamples = 0): Cue {
    const cue: Cue = { id: this.allocId(), frame, offsetSamples, sound, gain, label };
    this.list.cues.push(cue);
    this.emit();
    return cue;
  }

  removeCue(id: string): void {
    this.list.cues = this.list.cues.filter((c) => c.id !== id);
    this.emit();
  }

  clear(): void {
    this.list.cues = [];
    this.emit();
  }

  /** Sub-frame fine-tune in whole samples (may cross frame boundaries). */
  nudgeSamples(id: string, delta: number): void {
    const cue = this.list.cues.find((c) => c.id === id);
    if (!cue) return;
    cue.offsetSamples += Math.round(delta);
    this.emit();
  }

  nudgeFrames(id: string, delta: number): void {
    const cue = this.list.cues.find((c) => c.id === id);
    if (!cue) return;
    cue.frame = Math.max(0, cue.frame + Math.round(delta));
    this.emit();
  }

  setGain(id: string, gain: number): void {
    const cue = this.list.cues.find((c) => c.id === id);
    if (!cue) return;
    cue.gain = Math.min(1, Math.max(0, gain));
    this.emit();
  }

  /** Generate cues on every scene event whose frame falls in [from, to]. */
  generateFromScene(fromFrame: number, toFrame: number, fps: number): number {
    let added = 0;
    for (const ev of sceneEvents()) {
      const frame = eventFrame(ev, fps);
      if (frame < fromFrame || frame > toFrame) continue;
      this.addCue(frame, ev.kind, 1, ev.label);
      added++;
    }
    return added;
  }

  /** Generate evenly spaced cues of one kind across a frame range. */
  generateInterval(fromFrame: number, toFrame: number, everyFrames: number, sound: SoundKind): number {
    let added = 0;
    for (let f = fromFrame; f <= toFrame; f += Math.max(1, Math.round(everyFrames))) {
      this.addCue(f, sound, 1, `${sound} @${f}`);
      added++;
    }
    return added;
  }

  setFrameRate(rate: FrameRate): void {
    this.list.fpsNum = rate.num;
    this.list.fpsDen = rate.den;
    this.emit();
  }

  setSampleRate(sampleRate: number): void {
    this.list.sampleRate = sampleRate;
    this.emit();
  }

  export(): string {
    return serializeCueList(this.list);
  }

  /** Replace the store from an exported document. Positions are taken
   *  verbatim from the integer fields, so reloads are bit-identical. */
  import(json: string): void {
    const parsed = parseCueList(json);
    this.list = parsed;
    this.nextId =
      parsed.cues.reduce((m, c) => {
        const n = Number(/^cue-(\d+)$/.exec(c.id)?.[1]);
        return Number.isFinite(n) ? Math.max(m, n + 1) : m;
      }, 1);
    this.emit();
  }

  /** Self-check: export -> import -> export must be a fixed point. */
  verifyRoundTrip(): boolean {
    const once = this.export();
    const restored = parseCueList(once);
    return cueListsEqual(this.list, restored) && serializeCueList(restored) === once;
  }

  /** Absolute trigger sample for a cue under the store's current list. */
  triggerOf(cue: Cue): number {
    return triggerSample(cue, this.list);
  }

  frameRate(): FrameRate {
    return listFrameRate(this.list);
  }

  samplesPerFrame(): number {
    const rate = this.frameRate();
    return frameToSample(1, rate, this.list.sampleRate) - frameToSample(0, rate, this.list.sampleRate);
  }
}
