import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const imageDir = join(root, "fixtures", "images");
const audioDir = join(root, "fixtures", "audio");
mkdirSync(imageDir, { recursive: true });
mkdirSync(audioDir, { recursive: true });

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);
  const header = new ArrayBuffer(4);
  new DataView(header).setUint32(0, data.length);
  const checksum = new ArrayBuffer(4);
  new DataView(checksum).setUint32(0, crc32(body));
  const out = new Uint8Array(4 + body.length + 4);
  out.set(new Uint8Array(header), 0);
  out.set(body, 4);
  out.set(new Uint8Array(checksum), 4 + body.length);
  return out;
}

function writePng(path: string, width: number, height: number, seed: number): void {
  const bytesPerPixel = 3;
  const rowLength = width * bytesPerPixel + 1;
  const raw = new Uint8Array(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * rowLength;
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + 1 + x * bytesPerPixel;
      raw[offset] = (x * 255) / width;
      raw[offset + 1] = (y * 255) / height;
      raw[offset + 2] = (seed * 23 + x * 0.4 + y * 0.25) & 0xff;
    }
  }
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new ArrayBuffer(13);
  const ihdrView = new DataView(ihdr);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdrView.setUint8(8, 8);
  ihdrView.setUint8(9, 2);
  const png = concat([
    signature,
    chunk("IHDR", new Uint8Array(ihdr)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
  writeFileSync(path, png);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function writeWav(path: string, seconds: number, seed: number, sampleRate = 48000): void {
  const frameCount = Math.ceil(seconds * sampleRate);
  const dataBytes = frameCount * 2 * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    new TextEncoder().encode(text).forEach((byte, index) => view.setUint8(offset + index, byte));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  const frequency = 180 + seed * 24;
  for (let i = 0; i < frameCount; i += 1) {
    const t = i / sampleRate;
    const fade = Math.min(1, t * 8, Math.max(0, (seconds - t) * 4));
    const sample = Math.sin(2 * Math.PI * frequency * t) * 0.12 * fade;
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 4, value * 0x7fff, true);
    view.setInt16(46 + i * 4, value * 0.6 * 0x7fff, true);
  }
  writeFileSync(path, new Uint8Array(buffer));
}

const width = 3840;
const height = 2160;
for (let i = 1; i <= 18; i += 1) {
  const seed = createHash("sha256").update(String(i)).digest()[0];
  writePng(join(imageDir, `img-${i}.png`), width, height, seed);
  writeWav(join(audioDir, `seg-${i}.wav`), 3.2 + (i % 5) * 0.4, i);
}

writeWav(join(audioDir, "narration.wav"), 92, 1);
console.log("generated 18 PNG images and 19 WAV files");
