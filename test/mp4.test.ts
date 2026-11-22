import assert from "node:assert/strict";
import test from "node:test";
import { probeMp4Timing } from "../src/media/mp4/probe.ts";

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function typeBytes(type: string): Uint8Array {
  return Uint8Array.from(type, (character) => character.charCodeAt(0));
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, 8 + payload.length);
  header.set(typeBytes(type), 4);
  return concat([header, payload]);
}

function u32(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value));
  return bytes;
}

function i32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value);
  return bytes;
}

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value);
  return bytes;
}

function fullBox(type: string, version: number, payload: Uint8Array): Uint8Array {
  return box(type, concat([Uint8Array.of(version, 0, 0, 0), payload]));
}

function headerBox(type: string, timescale: number, duration: number): Uint8Array {
  return fullBox(type, 0, concat([u32(0, 0, timescale, duration)]));
}

function stts(entries: [number, number][]): Uint8Array {
  return fullBox("stts", 0, concat([u32(entries.length), ...entries.flatMap(([c, d]) => u32(c, d))]));
}

function stsdWithAudioRate(sampleRate: number): Uint8Array {
  const entry = new Uint8Array(36);
  new DataView(entry.buffer).setUint32(0, 36);
  entry.set(typeBytes("mp4a"), 4);
  new DataView(entry.buffer).setUint32(32, sampleRate * 65_536);
  return fullBox("stsd", 0, concat([u32(1), entry]));
}

function track(options: {
  trackId: number;
  handler: "vide" | "soun";
  timescale: number;
  duration: number;
  stts: Uint8Array;
  stsd?: Uint8Array;
  elst?: Uint8Array;
}): Uint8Array {
  const tkhd = fullBox("tkhd", 0, u32(0, 0, options.trackId, 0));
  const hdlr = fullBox("hdlr", 0, concat([u32(0), typeBytes(options.handler)]));
  const stbl = box(
    "stbl",
    concat([options.stts, options.stsd ?? new Uint8Array(0)]),
  );
  const minf = box("minf", stbl);
  const mdia = box("mdia", concat([headerBox("mdhd", options.timescale, options.duration), hdlr, minf]));
  const parts = [tkhd];
  if (options.elst) parts.push(box("edts", options.elst));
  parts.push(mdia);
  return box("trak", concat(parts));
}

function sampleMp4(): Uint8Array {
  const movieTimescale = 1000;
  const mvhd = headerBox("mvhd", movieTimescale, 1_001_000);
  const video = track({
    trackId: 1,
    handler: "vide",
    timescale: 90_000,
    duration: 9_009_000,
    stts: stts([[3000, 3003]]),
    elst: fullBox("elst", 0, concat([u32(1), u32(1_001_000), i32(0), u32(65_536)])),
  });
  const audio = track({
    trackId: 2,
    handler: "soun",
    timescale: 48_000,
    duration: 4_804_800,
    stts: stts([[4692, 1024]]),
    stsd: stsdWithAudioRate(48_000),
  });
  return concat([box("moov", concat([mvhd, video, audio]))]);
}

test("MP4 probe recovers exact NTSC rate from timescale and stts", () => {
  const bytes = sampleMp4();
  const timing = probeMp4Timing(bytes.buffer);
  assert.equal(timing.movieTimescale, 1000n);
  assert.equal(timing.duration.toString(), "1001");
  assert.equal(timing.tracks.length, 2);

  const video = timing.tracks[0];
  assert.equal(video.handler, "video");
  assert.equal(video.frameRate?.toString(), "30000/1001");
  assert.equal(video.frameDuration?.toString(), "1001/30000");
  assert.equal(video.sampleCount, 3000n);
  assert.equal(video.edits[0].segmentDuration.toString(), "1001");
  assert.equal(video.edits[0].mediaTime?.toString(), "0");
  assert.equal(video.edits[0].rate.toString(), "1");

  const audioTrack = timing.tracks[1];
  assert.equal(audioTrack.handler, "audio");
  assert.equal(audioTrack.audioSampleRate?.toString(), "48000");
  assert.equal(audioTrack.frameRate, undefined);
});

test("MP4 probe keeps a VFR track from claiming a single frame rate", () => {
  const mvhd = headerBox("mvhd", 1000, 2000);
  const video = track({
    trackId: 1,
    handler: "vide",
    timescale: 90_000,
    duration: 180_000,
    stts: stts([[10, 3003], [10, 3004]]),
  });
  const timing = probeMp4Timing(concat([box("moov", concat([mvhd, video]))]).buffer);
  assert.equal(timing.tracks[0].variableFrameRate, true);
  assert.equal(timing.tracks[0].frameRate, undefined);
  assert.equal(timing.tracks[0].sampleCount, 20n);
});

test("malformed MP4 boxes fail instead of producing a guessed rate", () => {
  assert.throws(() => probeMp4Timing(new Uint8Array(4).buffer), /truncated/);
  assert.throws(
    () => probeMp4Timing(concat([box("free", new Uint8Array(0))]).buffer),
    /missing moov/,
  );
});
