import type { AudioTrack } from "../shared/types.ts";
import { encodeWavPcm16 } from "../shared/wav.ts";

export interface FixtureSpec {
  durationSec: number;
  rate: number;
  startOffsetMs: number;
  driftMsPerSec: number;
  driftKinkAtSec: number;
  driftKinkMsPerSec: number;
  seed: number;
}

export const DEFAULT_SPEC: FixtureSpec = {
  durationSec: 60,
  rate: 48000,
  startOffsetMs: 120,
  driftMsPerSec: 0.6,
  driftKinkAtSec: 30,
  driftKinkMsPerSec: -1.4,
  seed: 20261123,
};

export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function offsetTruth(spec: FixtureSpec, cameraT: number): number {
  if (cameraT < spec.driftKinkAtSec) {
    return spec.startOffsetMs + spec.driftMsPerSec * cameraT;
  }
  const atKink = spec.startOffsetMs + spec.driftMsPerSec * spec.driftKinkAtSec;
  return atKink + spec.driftKinkMsPerSec * (cameraT - spec.driftKinkAtSec);
}

export function buildFixtures(spec: FixtureSpec = DEFAULT_SPEC): { camera: AudioTrack; recorder: AudioTrack } {
  const rng = makeRng(spec.seed);
  const total = spec.durationSec * spec.rate;
  const camera = new Float32Array(total);
  const recorder = new Float32Array(total);

  addAmbience(camera, rng);
  addToneBursts(camera, spec.rate);
  const clapTimes = [4, 9.5, 15, 21.7, 27.3, 33.1, 38.8, 44.6, 50.2, 56.4];
  for (const t of clapTimes) addClap(camera, t * spec.rate, spec.rate, rng);

  for (let recFrame = 0; recFrame < total; recFrame++) {
    const recT = recFrame / spec.rate;
    const cameraT = recT - offsetTruth(spec, recT) / 1000;
    const index = cameraT * spec.rate;
    const idx = Math.floor(index);
    const frac = index - idx;
    const a = camera[idx] ?? 0;
    const b = camera[idx + 1] ?? a;
    recorder[recFrame] = a + (b - a) * frac;
  }

  return {
    camera: { name: "camera.wav", sampleRate: spec.rate, channels: [camera], duration: spec.durationSec },
    recorder: { name: "recorder.wav", sampleRate: spec.rate, channels: [recorder], duration: spec.durationSec },
  };
}

function addAmbience(buffer: Float32Array, rng: () => number): void {
  let previous = 0;
  for (let i = 0; i < buffer.length; i++) {
    const white = rng() * 2 - 1;
    previous = previous * 0.92 + white * 0.08;
    buffer[i] = previous * 0.12;
  }
  for (const region of [[18, 20], [41, 43]] as const) {
    for (let i = region[0] * 48000; i < region[1] * 48000 && i < buffer.length; i++) buffer[i] = 0;
  }
}

function addToneBursts(buffer: Float32Array, rate: number): void {
  const regions: Array<[number, number, number]> = [[10, 13, 220], [46, 49, 330]];
  for (const [start, end, freq] of regions) {
    for (let i = start * rate; i < end * rate && i < buffer.length; i++) {
      const t = (i - start * rate) / rate;
      buffer[i] = (buffer[i] ?? 0) + 0.2 * Math.sin(2 * Math.PI * freq * t);
    }
  }
}

function addClap(buffer: Float32Array, frame: number, rate: number, rng: () => number): void {
  const length = Math.floor(rate * 0.08);
  for (let i = 0; i < length; i++) {
    const env = Math.exp(-i / (rate * 0.012));
    buffer[frame + i] = (buffer[frame + i] ?? 0) + (rng() * 2 - 1) * env * 0.9;
  }
}

export function fixtureWavBuffers(spec: FixtureSpec = DEFAULT_SPEC): { camera: ArrayBuffer; recorder: ArrayBuffer } {
  const { camera, recorder } = buildFixtures(spec);
  return { camera: encodeWavPcm16(camera), recorder: encodeWavPcm16(recorder) };
}
