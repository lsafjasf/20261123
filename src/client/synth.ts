// Procedural foley synthesis with WebAudio. Every sound is generated from
// a seeded PRNG, so the same cue renders identically on every playback —
// the synth is the clock source of truth; there is no recording to fix.

import type { SoundKind } from '../shared/cuelist.ts';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number, rand: () => number): AudioBuffer {
  const len = Math.max(1, Math.ceil(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = rand() * 2 - 1;
  return buf;
}

function adsrGain(ctx: BaseAudioContext, dest: AudioNode, when: number, peak: number, attack: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(peak, when + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  g.connect(dest);
  return g;
}

function noiseHit(
  ctx: BaseAudioContext, dest: AudioNode, when: number, rand: () => number,
  opts: { dur: number; type: BiquadFilterType; freq: number; q?: number; gain: number },
): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, opts.dur, rand);
  const filt = ctx.createBiquadFilter();
  filt.type = opts.type;
  filt.frequency.value = opts.freq;
  filt.Q.value = opts.q ?? 1;
  const g = adsrGain(ctx, dest, when, opts.gain, 0.003, opts.dur);
  src.connect(filt).connect(g);
  src.start(when);
  src.stop(when + opts.dur + 0.05);
}

function toneThump(
  ctx: BaseAudioContext, dest: AudioNode, when: number,
  opts: { freq: number; drop?: number; dur: number; gain: number; type?: OscillatorType },
): void {
  const osc = ctx.createOscillator();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(opts.freq, when);
  if (opts.drop) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freq - opts.drop), when + opts.dur);
  const g = adsrGain(ctx, dest, when, opts.gain, 0.004, opts.dur);
  osc.connect(g);
  osc.start(when);
  osc.stop(when + opts.dur + 0.05);
}

function footstep(ctx: BaseAudioContext, dest: AudioNode, when: number, gain: number, rand: () => number, right: boolean): void {
  const pan = ctx.createStereoPanner();
  pan.pan.value = right ? 0.25 : -0.25;
  pan.connect(dest);
  const heelFreq = 480 + rand() * 260 + (right ? 120 : 0);
  noiseHit(ctx, pan, when, rand, { dur: 0.07, type: 'lowpass', freq: heelFreq, gain: 0.9 * gain });
  toneThump(ctx, pan, when, { freq: 68 + rand() * 14, drop: 30, dur: 0.09, gain: 0.7 * gain });
}

function impact(ctx: BaseAudioContext, dest: AudioNode, when: number, gain: number, rand: () => number): void {
  noiseHit(ctx, dest, when, rand, { dur: 0.02, type: 'highpass', freq: 2500, gain: 0.5 * gain });
  noiseHit(ctx, dest, when, rand, { dur: 0.12, type: 'bandpass', freq: 700 + rand() * 300, q: 2, gain: 0.8 * gain });
  toneThump(ctx, dest, when, { freq: 130, drop: 80, dur: 0.28, gain: 0.9 * gain });
}

function doorLatch(ctx: BaseAudioContext, dest: AudioNode, when: number, gain: number, rand: () => number): void {
  for (const [dt, f] of [[0, 2200], [0.055, 1600]] as const) {
    toneThump(ctx, dest, when + dt, { freq: f, drop: f * 0.4, dur: 0.03, gain: 0.4 * gain, type: 'square' });
    noiseHit(ctx, dest, when + dt, rand, { dur: 0.015, type: 'highpass', freq: 3200, gain: 0.3 * gain });
  }
}

function doorCreak(ctx: BaseAudioContext, dest: AudioNode, when: number, gain: number, rand: () => number): void {
  const dur = 2.0;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(230, when);
  // Slow uneven rise with sticky judder, like a dry hinge.
  let t = 0;
  let f = 230;
  while (t < dur) {
    f = Math.min(520, f + 18 + rand() * 40);
    osc.frequency.linearRampToValueAtTime(f, when + t);
    t += 0.08 + rand() * 0.12;
  }
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 7;
  const lfoAmt = ctx.createGain();
  lfoAmt.gain.value = 45;
  lfo.connect(lfoAmt).connect(osc.frequency);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 780;
  bp.Q.value = 9;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(0.32 * gain, when + 0.25);
  g.gain.setValueAtTime(0.32 * gain, when + dur - 0.3);
  g.gain.linearRampToValueAtTime(0, when + dur);
  const trem = ctx.createOscillator();
  trem.frequency.value = 9;
  const tremAmt = ctx.createGain();
  tremAmt.gain.value = 0.12 * gain;
  trem.connect(tremAmt).connect(g.gain);
  osc.connect(bp).connect(g).connect(dest);
  osc.start(when); osc.stop(when + dur);
  lfo.start(when); lfo.stop(when + dur);
  trem.start(when); trem.stop(when + dur);
}

function doorThud(ctx: BaseAudioContext, dest: AudioNode, when: number, gain: number, rand: () => number): void {
  toneThump(ctx, dest, when, { freq: 58, drop: 25, dur: 0.4, gain: 1.0 * gain });
  noiseHit(ctx, dest, when, rand, { dur: 0.1, type: 'lowpass', freq: 220, gain: 0.7 * gain });
}

/** Schedule one foley sound at an exact AudioContext time. */
export function scheduleSound(
  ctx: BaseAudioContext, dest: AudioNode, kind: SoundKind, when: number, gain: number, seed: number,
): void {
  const rand = mulberry32(seed);
  switch (kind) {
    case 'footstep-l': footstep(ctx, dest, when, gain, rand, false); break;
    case 'footstep-r': footstep(ctx, dest, when, gain, rand, true); break;
    case 'impact': impact(ctx, dest, when, gain, rand); break;
    case 'door-latch': doorLatch(ctx, dest, when, gain, rand); break;
    case 'door-creak': doorCreak(ctx, dest, when, gain, rand); break;
    case 'door-thud': doorThud(ctx, dest, when, gain, rand); break;
  }
}
