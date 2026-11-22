import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { muxMp4 } from "../client/mp4/mux.js";
import { parseMp4 } from "../client/mp4/reader.js";

const ROOT = new URL("../../../", import.meta.url);
const INPUT = new Uint8Array(readFileSync(new URL("samples/demo-course.mp4", ROOT)));

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function audioHash(bytes: Uint8Array, file: ReturnType<typeof parseMp4>): string {
  if (!file.audio) return "";
  const hash = createHash("sha256");
  for (const sample of file.audio.samples) hash.update(bytes.subarray(sample.offset, sample.offset + sample.size));
  return hash.digest("hex");
}

test("MP4 reader resolves the complete sample table and codec configuration", () => {
  const file = parseMp4(INPUT);
  assert.equal(file.video.codec.startsWith("avc1."), true);
  assert.equal(file.video.width, 1280);
  assert.equal(file.video.height, 720);
  assert.equal(file.video.samples.length, 420);
  assert.ok((file.video.description?.length ?? 0) >= 40);
  assert.equal(file.audio?.samples.length, 658);
  assert.ok((file.audio?.sampleEntry?.length ?? 0) > 0);
});

test("muxer preserves every AAC packet byte-for-byte and keeps frame timestamps", () => {
  const source = parseMp4(INPUT);
  const videoStartSeconds = source.video.presentationStartSeconds;
  const audioStartSeconds = source.audio?.presentationStartSeconds ?? videoStartSeconds;
  const videoSamples = source.video.samples.map((sample) => ({
    data: INPUT.slice(sample.offset, sample.offset + sample.size),
    timestampUs: Math.round(((sample.cts - source.video.editMediaTime) / source.video.timescale - videoStartSeconds) * 1_000_000),
    durationUs: Math.round((sample.duration / source.video.timescale) * 1_000_000),
    isKey: sample.isKey
  }));
  const output = muxMp4({
    width: source.video.width,
    height: source.video.height,
    source,
    videoSamples,
    videoDescription: source.video.description!,
    audioStartUs: Math.max(0, Math.round((audioStartSeconds - videoStartSeconds) * 1_000_000))
  });
  const parsed = parseMp4(output.mp4);
  assert.equal(parsed.video.samples.length, 420);
  assert.equal(parsed.video.width, 1280);
  assert.equal(parsed.video.height, 720);
  assert.equal(parsed.audio?.samples.length, 658);
  assert.equal(audioHash(INPUT, source), audioHash(output.mp4, parsed));
  assert.equal(output.audioBytesPreserved, source.audio!.samples.reduce((sum, sample) => sum + sample.size, 0));
  assert.equal(parsed.video.presentationStartSeconds, 0);
});

test("input remains unchanged while muxing", () => {
  const before = digest(INPUT);
  parseMp4(INPUT);
  assert.equal(digest(INPUT), before);
});
