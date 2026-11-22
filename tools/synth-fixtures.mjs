import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "public", "fixtures");
const TMP = join(ROOT, ".fixture-tmp");
const TRUTH = join(ROOT, "tests", "fixtures");
const SR = 48000;
const TAU = Math.PI * 2;

const tracks = [
  { id: "glass-overture", title: "Glass Overture", duration: 4.77, color: "#f3b35b", noEditList: false },
  { id: "pulse-grid", title: "Pulse Grid", duration: 4.21, color: "#e98262", noEditList: false },
  { id: "low-ceiling", title: "Low Ceiling", duration: 5.63, color: "#d75d77", noEditList: false },
  { id: "hands-0412", title: "Hands / 04:12", duration: 4.83, color: "#b35b9c", noEditList: false },
  { id: "riser-field", title: "Riser Field", duration: 5.09, color: "#7a68bd", noEditList: false },
  { id: "rebar", title: "Encore: Rebar", duration: 4.47, color: "#4e84c4", noEditList: false },
  { id: "house-left", title: "House Left / Unknown", duration: 4.62, color: "#3fa3a7", noEditList: true },
  { id: "crowd-bleed", title: "Crowd Bleed / Unknown", duration: 4.18, color: "#65a86e", noEditList: true }
];

let seed = 0x51f15e;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
}

const sampleCounts = tracks.map((track) => Math.round(track.duration * SR));
const totalSamples = sampleCounts.reduce((sum, count) => sum + count, 0);
const left = new Float32Array(totalSamples);
const right = new Float32Array(totalSamples);

function addSample(index, value, pan) {
  if (index < 0 || index >= totalSamples) return;
  left[index] += value * Math.sqrt((1 - pan) * 0.5);
  right[index] += value * Math.sqrt((1 + pan) * 0.5);
}

function kick(start) {
  for (let i = 0; i < SR * 0.38; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 13.5) * Math.min(1, t * 1200);
    const hz = 49 + 42 * Math.exp(-t * 31);
    addSample(start + i, Math.sin(TAU * hz * t) * env * 0.83, -0.06);
  }
}

function snare(start, pan) {
  let previous = 0;
  for (let i = 0; i < SR * 0.23; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 24) * Math.min(1, t * 2400);
    const noise = random() * 2 - 1;
    const bright = noise - previous * 0.74;
    previous = noise;
    const body = Math.sin(TAU * 187 * t) * 0.34;
    addSample(start + i, (bright * 0.43 + body) * env, pan);
  }
}

function hat(start, pan, open = false) {
  let previous = 0;
  const length = SR * (open ? 0.28 : 0.055);
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    const env = Math.exp(-t * (open ? 13 : 64)) * 0.2;
    const noise = random() * 2 - 1;
    const high = noise - previous;
    previous = noise;
    addSample(start + i, high * env, pan);
  }
}

function bass(start, hz, length) {
  for (let i = 0; i < SR * length; i++) {
    const t = i / SR;
    const env = Math.min(1, t * 70) * Math.exp(-t * 2.6);
    const saw = ((hz * t) % 1) * 2 - 1;
    const sub = Math.sin(TAU * hz * 0.5 * t);
    addSample(start + i, (saw * 0.09 + sub * 0.16) * env, 0.08);
  }
}

function pad(start, length) {
  const chord = [110, 130.81, 164.81, 220];
  for (let i = 0; i < SR * length; i++) {
    const t = i / SR;
    const env = Math.min(1, t * 0.9) * Math.min(1, (length - t) * 1.2);
    let value = 0;
    for (let c = 0; c < chord.length; c++) {
      value += Math.sin(TAU * chord[c] * t + c * 0.7) * 0.009;
    }
    addSample(start + i, value * env, Math.sin(t * 0.4) * 0.3);
  }
}

const beat = 60 / 128;
for (let start = 0; start < totalSamples; start += Math.round(beat * SR)) {
  kick(start);
  snare(start + Math.round(beat * 2 * SR), 0.18);
  hat(start + Math.round(beat * 0.5 * SR), -0.35);
  hat(start + Math.round(beat * 1.5 * SR), 0.34, true);
  bass(start + Math.round(beat * 0.25 * SR), [55, 55, 65.41, 49][Math.floor(start / SR) % 4], beat * 0.43);
}
for (let start = 0; start < totalSamples; start += SR * 2) pad(start, Math.min(2, (totalSamples - start) / SR));

for (let i = 0; i < totalSamples; i++) {
  const fade = Math.min(1, i / (SR * 0.08), (totalSamples - i) / (SR * 0.13));
  left[i] = Math.tanh(left[i] * 1.1) * fade;
  right[i] = Math.tanh(right[i] * 1.1) * fade;
}

function wavHeader(samples, channels) {
  const dataBytes = samples * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(SR, 24);
  buffer.writeUInt32LE(SR * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function sliceWav(offset, count) {
  const buffer = wavHeader(count, 2);
  let cursor = 44;
  for (let i = 0; i < count; i++) {
    const l = Math.max(-1, Math.min(1, left[offset + i]));
    const r = Math.max(-1, Math.min(1, right[offset + i]));
    buffer.writeInt16LE(Math.round(l * 32767), cursor);
    buffer.writeInt16LE(Math.round(r * 32767), cursor + 2);
    cursor += 4;
  }
  return buffer;
}

await mkdir(OUT, { recursive: true });
await mkdir(TMP, { recursive: true });

let offset = 0;
const manifest = {
  title: "Glasshouse / Live Continuity",
  codec: "AAC-LC 48 kHz",
  generated: "2026-11-23",
  segments: []
};
const truth = {
  sampleRate: SR,
  totalSamples,
  segments: []
};

for (let index = 0; index < tracks.length; index++) {
  const track = tracks[index];
  const count = sampleCounts[index];
  const wav = join(TMP, `${track.id}.wav`);
  const m4a = join(OUT, `${track.id}.m4a`);
  const frag = join(OUT, `${track.id}-frag.mp4`);
  await writeFile(wav, sliceWav(offset, count));
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", wav, "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart", "-use_editlist", track.noEditList ? "0" : "1", m4a
  ];
  execFileSync("ffmpeg", args, { stdio: "inherit" });
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", m4a, "-c:a", "copy", "-movflags",
    "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", frag
  ], { stdio: "inherit" });
  manifest.segments.push({
    id: track.id,
    title: track.title,
    file: `${track.id}.m4a`,
    fragmentedFile: `${track.id}-frag.mp4`,
    color: track.color,
    ordinal: index + 1
  });
  truth.segments.push({
    id: track.id,
    cutStart: offset,
    cutEnd: offset + count,
    sourceSamples: count,
    hasEditList: !track.noEditList
  });
  offset += count;
}

await writeFile(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await mkdir(TRUTH, { recursive: true });
await writeFile(join(TRUTH, "truth.json"), JSON.stringify(truth, null, 2) + "\n");
console.log(`Wrote ${tracks.length} AAC segments, ${(totalSamples / SR).toFixed(2)} s, ${totalSamples} source samples.`);
