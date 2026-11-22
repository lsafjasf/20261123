/**
 * Offline sample-material generator.
 * Produces synthetic WAV deliverables under samples/ using only Node stdlib,
 * including deliberately defective tracks so the QC pipeline has findings.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav16 } from '../core/wav.ts';
import type { PcmBuffer } from '../core/types.ts';

const SAMPLE_RATE = 48000;

function makeMono(seconds: number, fill: (frame: number, t: number) => number): PcmBuffer {
  const frames = Math.floor(SAMPLE_RATE * seconds);
  const channel = new Float32Array(frames);
  for (let i = 0; i < frames; i++) channel[i] = fill(i, i / SAMPLE_RATE);
  return { sampleRate: SAMPLE_RATE, channels: [channel] };
}

function makeStereo(seconds: number, fill: (t: number, ch: number) => number): PcmBuffer {
  const frames = Math.floor(SAMPLE_RATE * seconds);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    left[i] = fill(t, 0);
    right[i] = fill(t, 1);
  }
  return { sampleRate: SAMPLE_RATE, channels: [left, right] };
}

/** Speech-like amplitude: pauses plus an amplitude wobble to model phrases. */
function speechEnvelope(t: number): number {
  const phrase = t % 1.6;
  const talking = phrase < 1.1 ? 1 : 0.02;
  const wobble = 0.75 + 0.25 * Math.sin(2 * Math.PI * 5 * t);
  return talking * wobble;
}

function writeWav(dir: string, name: string, pcm: PcmBuffer): void {
  const buffer = encodeWav16(pcm);
  writeFileSync(join(dir, name), Buffer.from(buffer));
  console.log(`wrote ${name} (${(buffer.byteLength / 1024).toFixed(1)} KiB)`);
}

export function generateSamples(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  const duration = 12;
  const tail = 0.4; // healthy short tail of silence

  // Chinese dialogue: ~300 Hz formant-ish tone with speech envelope.
  const zh = makeMono(duration, (_f, t) => {
    if (t > duration - tail) return 0;
    return 0.12 * speechEnvelope(t) * Math.sin(2 * Math.PI * 320 * t);
  });
  writeWav(outDir, 'film_dialogue_zh_v1.wav', zh);

  // English dialogue: slightly different pitch, same length.
  const en = makeMono(duration, (_f, t) => {
    if (t > duration - tail) return 0;
    return 0.115 * speechEnvelope(t + 0.4) * Math.sin(2 * Math.PI * 240 * t);
  });
  writeWav(outDir, 'film_dialogue_en_v1.wav', en);

  // Music & effects: stereo pad, gentle chord, multichannel-friendly stereo.
  const music = makeStereo(duration, (t, ch) => {
    if (t > duration - tail) return 0;
    const base = ch === 0 ? 196 : 220;
    const pad = 0.1 * (Math.sin(2 * Math.PI * base * t) + 0.5 * Math.sin(2 * Math.PI * base * 1.5 * t));
    return pad;
  });
  writeWav(outDir, 'film_music_MnE_v1.wav', music);

  // Defective English alternate: short duration, over-loud, clipped short tail.
  const badDuration = 9.2;
  const badEn = makeMono(badDuration, (_f, t) => {
    const raw = 0.95 * speechEnvelope(t) * Math.sin(2 * Math.PI * 240 * t);
    return Math.max(-0.98, Math.min(0.98, raw)); // hard clip -> high true peak
  });
  writeWav(outDir, 'film_dialogue_en_LOUD_short.wav', badEn);

  // Defective music alternate: long dead tail of silence (> 2 s).
  const deadTail = makeStereo(duration, (t, ch) => {
    if (t > duration - 3.2) return 0; // 3.2 s dead tail
    const base = ch === 0 ? 174 : 196;
    return 0.095 * Math.sin(2 * Math.PI * base * t);
  });
  writeWav(outDir, 'film_music_deadtail.wav', deadTail);

  // Unknown-named track to exercise identification fallback.
  const mystery = makeMono(duration, (_f, t) => 0.11 * Math.sin(2 * Math.PI * 400 * t));
  writeWav(outDir, 'film_track99_mystery.wav', mystery);
}

const invokedPath = process.argv[1] ? process.argv[1].replaceAll('\\', '/') : '';
if (invokedPath.endsWith('generate-samples.ts')) {
  const target = process.argv[2] ?? join(process.cwd(), 'samples');
  generateSamples(target);
}
