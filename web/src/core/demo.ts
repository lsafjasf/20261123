import type { AudioSource } from "./types.ts";

interface DemoEvent {
  start: number;
  duration: number;
  pitch: number;
  energy: number;
  texture: "speech" | "laugh" | "filler";
}

const EVENTS: DemoEvent[] = [
  { start: 0.35, duration: 2.05, pitch: 156, energy: 0.34, texture: "speech" },
  { start: 3.24, duration: 1.45, pitch: 142, energy: 0.3, texture: "speech" },
  { start: 4.93, duration: 0.34, pitch: 184, energy: 0.2, texture: "filler" },
  { start: 6.3, duration: 1.77, pitch: 161, energy: 0.32, texture: "speech" },
  { start: 8.9, duration: 1.1, pitch: 208, energy: 0.28, texture: "laugh" },
  { start: 10.3, duration: 1.85, pitch: 148, energy: 0.33, texture: "speech" },
  { start: 13.47, duration: 0.42, pitch: 192, energy: 0.18, texture: "filler" },
  { start: 14.8, duration: 2.13, pitch: 137, energy: 0.31, texture: "speech" },
  { start: 17.54, duration: 0.72, pitch: 215, energy: 0.24, texture: "laugh" },
  { start: 19.2, duration: 1.72, pitch: 152, energy: 0.34, texture: "speech" },
  { start: 21.63, duration: 1.65, pitch: 144, energy: 0.29, texture: "speech" },
];

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function envelope(position: number, duration: number): number {
  const attack = Math.min(0.045, duration * 0.15);
  const release = Math.min(0.16, duration * 0.22);
  const inGain = Math.min(1, position / Math.max(0.001, attack));
  const outGain = Math.min(1, (duration - position) / Math.max(0.001, release));
  return Math.max(0, Math.sin((Math.min(inGain, outGain) * Math.PI) / 2) ** 2);
}

function syllableGain(time: number, event: DemoEvent): number {
  const rate = event.texture === "laugh" ? 7.6 : event.texture === "filler" ? 2.8 : 4.2;
  const pulse = 0.3 + 0.7 * Math.sin(time * Math.PI * 2 * rate) ** 2;
  const drift = 0.82 + 0.18 * Math.sin(time * 7.4 + event.pitch);
  return pulse * drift;
}

export function generateDemoAudio(sampleRate = 48000): AudioSource {
  const duration = 24.4;
  const frameCount = Math.round(duration * sampleRate);
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  const random = makeRandom(0x51a7c0de);
  let room = 0;
  let roomRight = 0;

  for (let index = 0; index < frameCount; index += 1) {
    room = room * 0.995 + (random() * 2 - 1) * 0.0005;
    roomRight = roomRight * 0.994 + (random() * 2 - 1) * 0.00052;
    left[index] = room * 0.23;
    right[index] = roomRight * 0.21;
  }

  for (const event of EVENTS) {
    const start = Math.round(event.start * sampleRate);
    const count = Math.round(event.duration * sampleRate);
    let phaseA = random() * Math.PI * 2;
    let phaseB = random() * Math.PI * 2;
    for (let offset = 0; offset < count && start + offset < frameCount; offset += 1) {
      const time = offset / sampleRate;
      const position = time / event.duration;
      const glide = Math.sin(position * Math.PI * 1.35) * 7 + Math.sin(position * Math.PI * 4.2) * 2.2;
      const pitch = event.pitch + glide;
      phaseA += (Math.PI * 2 * pitch) / sampleRate;
      phaseB += (Math.PI * 2 * (pitch * 1.004 + 0.7)) / sampleRate;
      const vibration = 1 + Math.sin(time * Math.PI * 2 * 5.1) * 0.008;
      const fundamentalA = Math.sin(phaseA) + 0.48 * Math.sin(phaseA * 2 + 0.35) +
        0.24 * Math.sin(phaseA * 3 - 0.5) + 0.12 * Math.sin(phaseA * 5 + 0.2);
      const fundamentalB = Math.sin(phaseB) + 0.45 * Math.sin(phaseB * 2 + 0.2) +
        0.21 * Math.sin(phaseB * 3 + 0.5) + 0.1 * Math.sin(phaseB * 5 - 0.3);
      const breath = (random() * 2 - 1) * (event.texture === "speech" ? 0.08 : 0.15);
      const shaped = (fundamentalA * 0.27 + breath) * event.energy * envelope(offset, count) *
        syllableGain(time, event) * vibration;
      const shapedRight = (fundamentalB * 0.26 + breath * 0.82) * event.energy *
        envelope(offset, count) * syllableGain(time + 0.003, event) * vibration;
      const writeIndex = start + offset;
      left[writeIndex] += shaped;
      right[writeIndex] += shapedRight;
    }
  }

  for (const channel of [left, right]) {
    for (let index = 1; index < channel.length; index += 1) {
      channel[index] = channel[index] * 0.9 + channel[index - 1] * 0.1;
    }
  }

  let peak = 0;
  for (const channel of [left, right]) {
    for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  }
  const preGain = peak > 0 ? Math.min(4, 0.58 / peak) : 1;
  for (const channel of [left, right]) {
    for (let index = 0; index < channel.length; index += 1) channel[index] *= preGain;
  }

  return {
    name: "pause-study-demo.wav",
    sampleRate,
    channels: [left, right],
    bitDepth: 24,
    format: "demo",
    originalBytes: frameCount * 2 * 3,
    isDemo: true,
  };
}
