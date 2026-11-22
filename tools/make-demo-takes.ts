// Generates 12 synthetic speech-like takes of the same 6-sentence script into
// takes/. Each take varies per-sentence timing, pitch/energy (emotion), and
// noise floor, with breath noise between sentences — enough to exercise
// segmentation, alignment, metrics and comping fully offline.
// Run: node tools/make-demo-takes.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeWavPcm16 } from "../src/shared/wav.ts";

const SR = 24000;
const SENTENCES = [1.6, 1.1, 1.9, 1.3, 1.5, 1.0]; // base durations, seconds

interface Syllable {
  dur: number;
  gap: number;
  f0Ratio: number;
  amp: number;
}

// The "script": one fixed syllable pattern per sentence, shared by all takes,
// so rhythm envelopes correlate across takes of the same sentence.
const SCRIPT: Syllable[][] = SENTENCES.map((dur, s) => {
  const rand = rng(9000 + s);
  const syls: Syllable[] = [];
  let t = 0;
  while (t < dur) {
    const sd = 0.09 + rand() * 0.13;
    const gap = rand() < 0.25 ? 0.03 + rand() * 0.05 : 0.008;
    syls.push({ dur: sd, gap, f0Ratio: 0.9 + rand() * 0.25, amp: 0.6 + rand() * 0.4 });
    t += sd + gap;
  }
  return syls;
});

// Deterministic PRNG (mulberry32).
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthSentence(
  out: Float32Array,
  sr: number,
  fromSec: number,
  syls: Syllable[],
  tempo: number,
  f0: number,
  level: number,
  rand: () => number,
): void {
  // Syllable train from the shared script, stretched by this take's tempo.
  let t = 0;
  let phase = 0;
  for (const syl of syls) {
    const sd = syl.dur * tempo * (0.95 + rand() * 0.1);
    const f = f0 * syl.f0Ratio;
    const amp = level * syl.amp;
    const n0 = Math.floor((fromSec + t) * sr);
    const n1 = Math.min(out.length, Math.floor((fromSec + t + sd) * sr));
    for (let n = n0; n < n1; n++) {
      const tt = n / sr;
      const local = (n - n0) / Math.max(1, n1 - n0);
      const env = Math.sin(Math.PI * local) ** 1.5;
      phase += (2 * Math.PI * f) / sr;
      // Buzz: fundamental + a few harmonics with rolloff.
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(phase * h) / h;
      // Slight amplitude wobble for "voice" texture.
      out[n] += v * 0.25 * amp * env * (1 + 0.1 * Math.sin(2 * Math.PI * 5 * tt));
    }
    t += sd + syl.gap * tempo;
  }
}

function addBreath(out: Float32Array, sr: number, atSec: number, durSec: number, level: number, rand: () => number): void {
  const n0 = Math.floor(atSec * sr);
  const n1 = Math.min(out.length, Math.floor((atSec + durSec) * sr));
  let lp = 0;
  for (let n = n0; n < n1; n++) {
    const local = (n - n0) / Math.max(1, n1 - n0);
    const env = Math.sin(Math.PI * local);
    lp += 0.15 * ((rand() * 2 - 1) - lp); // lowpassed noise ≈ breath
    out[n] += lp * level * env;
  }
}

function makeTake(takeIdx: number): Float32Array {
  const rand = rng(1234 + takeIdx * 777);
  const totalSec = SENTENCES.reduce((a, b) => a + b, 0) + SENTENCES.length * 1.4 + 2;
  const out = new Float32Array(Math.ceil(totalSec * SR));
  // Per-take character: base pitch & loudness & noise floor.
  const baseF0 = 110 + takeIdx * 6 + rand() * 8;
  const baseLevel = 0.5 + rand() * 0.15;
  const noiseDb = -62 + takeIdx * 2.2 + rand() * 3; // takes differ in noise floor
  const noiseAmp = 10 ** (noiseDb / 20);

  let cursor = 0.6 + rand() * 0.3;
  for (let s = 0; s < SENTENCES.length; s++) {
    // Per-sentence timing jitter: some takes rush/drag specific sentences.
    const tempo = 0.82 + rand() * 0.4;
    const emo = 0.75 + rand() * 0.5; // per-sentence emotion (level) variation
    const before = cursor;
    synthSentence(out, SR, cursor, SCRIPT[s], tempo, baseF0 * (0.95 + rand() * 0.1), baseLevel * emo, rand);
    const sylDur = SCRIPT[s].reduce((a, y) => a + y.dur + y.gap, 0) * tempo;
    cursor = before + sylDur + 0.05;
    if (s < SENTENCES.length - 1) {
      const gap = 0.55 + rand() * 0.5;
      addBreath(out, SR, cursor + gap * 0.25, 0.16 + rand() * 0.12, 0.05 + rand() * 0.04, rand);
      cursor += gap;
    }
  }
  // Constant noise floor.
  for (let n = 0; n < out.length; n++) out[n] += (rand() * 2 - 1) * noiseAmp;
  return out;
}

mkdirSync("takes", { recursive: true });
for (let t = 0; t < 12; t++) {
  const samples = makeTake(t);
  const name = `take-${String(t + 1).padStart(2, "0")}.wav`;
  writeFileSync(join("takes", name), Buffer.from(encodeWavPcm16([samples], SR)));
  console.log(`wrote takes/${name} (${(samples.length / SR).toFixed(1)}s)`);
}
