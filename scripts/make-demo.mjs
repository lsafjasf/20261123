import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sampleRate = 44100;
const duration = 18;
const length = sampleRate * duration;
const left = new Float32Array(length);
const right = new Float32Array(length);

let noiseState = 0x51f15e;
function random() {
  noiseState = (noiseState * 1664525 + 1013904223) >>> 0;
  return noiseState / 4294967296;
}

function addRoomNoise() {
  let lowL = 0;
  let lowR = 0;
  for (let index = 0; index < length; index += 1) {
    const whiteL = random() * 2 - 1;
    const whiteR = random() * 2 - 1;
    lowL = lowL * 0.94 + whiteL * 0.06;
    lowR = lowR * 0.94 + whiteR * 0.06;
    const hum = Math.sin((2 * Math.PI * 50 * index) / sampleRate) * 0.00022;
    left[index] += lowL * 0.007 + whiteL * 0.0007 + hum;
    right[index] += lowR * 0.007 + whiteR * 0.00065 + hum * 0.8;
  }
}

function envelope(time, start, end, attack = 0.018, release = 0.06) {
  if (time < start || time > end) return 0;
  const inGain = Math.min(1, (time - start) / attack);
  const outGain = Math.min(1, (end - time) / release);
  return Math.max(0, Math.min(inGain, outGain));
}

function addSpeech(start, end, basePitch, pan = 0.5) {
  const syllableLength = 0.19;
  let phase = 0;
  let consonant = 0;
  for (let index = Math.floor(start * sampleRate); index < Math.floor(end * sampleRate); index += 1) {
    const time = index / sampleRate;
    const local = time - start;
    const syllable = (local % syllableLength) / syllableLength;
    const syllableEnv = Math.pow(Math.sin(Math.PI * Math.min(1, syllable * 1.2)), 0.65);
    const sentenceEnv = envelope(time, start, end, 0.08, 0.14);
    const gate = local % 0.76 > 0.66 ? 0.12 : 1;
    const jitter = Math.sin(local * 18.7) * 0.012 + Math.sin(local * 3.1) * 0.018;
    const pitch = basePitch * (1 + jitter + Math.sin(local * 0.74) * 0.025);
    phase += (2 * Math.PI * pitch) / sampleRate;
    const formant1 = Math.sin(phase * 2) * 0.22;
    const formant2 = Math.sin(phase * 3 + 0.4) * 0.13;
    const formant3 = Math.sin(phase * 5 + 1.2) * 0.075;
    const formant4 = Math.sin(phase * 7 + 0.7) * 0.036;
    const voiced = (Math.sin(phase) * 0.55 + formant1 + formant2 + formant3 + formant4) * 0.13;
    consonant = consonant * 0.85 + (random() * 2 - 1) * 0.15;
    const consonantEnv = Math.max(0, 1 - syllable * 11) + Math.max(0, 1 - (1 - syllable) * 22);
    const value = (voiced + consonant * 0.1) * syllableEnv * sentenceEnv * gate;
    left[index] += value * (1 - pan * 0.25);
    right[index] += value * (0.72 + pan * 0.3);
  }
}

function addBreath(start, end, level, brightness = 0.4, pan = 0.5) {
  let low = 0;
  let previous = 0;
  for (let index = Math.floor(start * sampleRate); index < Math.floor(end * sampleRate); index += 1) {
    const time = index / sampleRate;
    const local = (time - start) / (end - start);
    const shape = Math.pow(Math.sin(Math.PI * local), 1.25);
    const white = random() * 2 - 1;
    low = low * (0.86 - brightness * 0.2) + white * (0.14 + brightness * 0.2);
    const high = white - low;
    const value = (low * (1 - brightness) + high * brightness) * shape * level;
    const softness = Math.sin(2 * Math.PI * 3.2 * local) * 0.03 * level;
    left[index] += (value + softness) * (1 - pan * 0.18);
    right[index] += (value * 0.93 + softness) * (0.84 + pan * 0.25);
    previous = value;
  }
  void previous;
}

function addLowImpulse(start, level = 0.46) {
  const startSample = Math.floor(start * sampleRate);
  const impulseLength = Math.floor(sampleRate * 0.085);
  for (let offset = 0; offset < impulseLength; offset += 1) {
    const time = offset / sampleRate;
    const decay = Math.exp(-time * 54);
    const thump =
      Math.sin(2 * Math.PI * 58 * time) * 0.78 +
      Math.sin(2 * Math.PI * 91 * time + 0.3) * 0.22;
    const click = offset < 34 ? (random() * 2 - 1) * Math.exp(-offset / 7) * 0.22 : 0;
    const value = (thump * decay + click) * level;
    if (startSample + offset < length) {
      left[startSample + offset] += value;
      right[startSample + offset] += value * 0.94;
    }
  }
}

addRoomNoise();
addSpeech(1.05, 3.72, 168, 0.35);
addBreath(3.81, 4.03, 0.052, 0.55, 0.35);
addSpeech(4.22, 7.20, 153, 0.48);
addBreath(7.30, 7.52, 0.043, 0.6, 0.58);
addBreath(7.68, 8.32, 0.125, 0.24, 0.62);
addSpeech(8.47, 11.78, 146, 0.61);
addLowImpulse(11.84, 0.34);
addSpeech(12.08, 12.93, 162, 0.42);
addBreath(12.99, 13.32, 0.058, 0.48, 0.46);
addSpeech(13.47, 16.94, 157, 0.51);
addBreath(17.06, 17.34, 0.05, 0.5, 0.6);

let peak = 0;
for (let index = 0; index < length; index += 1) {
  peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
}
const gain = 0.88 / Math.max(0.001, peak);
const bytes = 44 + length * 4;
const buffer = Buffer.alloc(bytes);
buffer.write("RIFF", 0);
buffer.writeUInt32LE(bytes - 8, 4);
buffer.write("WAVE", 8);
buffer.write("fmt ", 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(2, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * 4, 28);
buffer.writeUInt16LE(4, 32);
buffer.writeUInt16LE(16, 34);
buffer.write("data", 36);
buffer.writeUInt32LE(length * 4, 40);
let offset = 44;
for (let index = 0; index < length; index += 1) {
  const l = Math.max(-1, Math.min(1, left[index] * gain));
  const r = Math.max(-1, Math.min(1, right[index] * gain));
  buffer.writeInt16LE(Math.round(l * 32767), offset);
  buffer.writeInt16LE(Math.round(r * 32767), offset + 2);
  offset += 4;
}

await mkdir(join(root, "public"), { recursive: true });
await writeFile(join(root, "public", "demo.wav"), buffer);
console.log(`Generated public/demo.wav (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
