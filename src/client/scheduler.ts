// Lookahead scheduler: converts cue trigger samples into exact
// AudioContext start times. Overlapping cues each get their own
// source graph, so any number of sounds may share a frame.

import { triggerSample, type CueList } from '../shared/cuelist.ts';
import { scheduleSound } from './synth.ts';
import { hashSeed } from './render.ts';
import type { Transport } from './transport.ts';

const TICK_MS = 25;
const LOOKAHEAD_S = 0.12;

export class CueScheduler {
  private timer: number | null = null;
  private scheduled = new Set<string>();
  private lastSample = 0;
  private ctx: AudioContext;
  private transport: Transport;
  private dest: AudioNode;

  constructor(ctx: AudioContext, transport: Transport, dest: AudioNode) {
    this.ctx = ctx;
    this.transport = transport;
    this.dest = dest;
  }

  start(getList: () => CueList): void {
    if (this.timer !== null) return;
    this.lastSample = this.transport.currentSample();
    this.timer = setInterval(() => this.tick(getList), TICK_MS) as unknown as number;
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.scheduled.clear();
  }

  private tick(getList: () => CueList): void {
    if (!this.transport.playing) {
      this.scheduled.clear();
      this.lastSample = this.transport.currentSample();
      return;
    }
    const now = this.transport.currentSample();
    if (now < this.lastSample) this.scheduled.clear(); // seeked backwards
    this.lastSample = now;
    const horizon = now + Math.ceil(LOOKAHEAD_S * this.transport.sampleRate);
    const list = getList();
    list.cues.forEach((cue, i) => {
      const trig = triggerSample(cue, list);
      if (trig <= now || trig > horizon || this.scheduled.has(cue.id)) return;
      const when = this.transport.contextTimeForSample(trig);
      if (when < this.ctx.currentTime) return;
      scheduleSound(this.ctx, this.dest, cue.sound, when, cue.gain, hashSeed(cue.id, i));
      this.scheduled.add(cue.id);
    });
    // Cues far behind the playhead no longer need dedup entries.
    if (this.scheduled.size > 512) {
      const keep = new Set<string>();
      for (const cue of list.cues) {
        if (triggerSample(cue, list) > now) keep.add(cue.id);
      }
      this.scheduled = keep;
    }
  }
}
