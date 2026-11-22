import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { demux, samplesForRange, extractSample } from "../src/shared/mp4.ts";

const SAMPLE = new URL("../media/sample.mp4", import.meta.url).pathname;
const SAMPLE_NOBF = new URL("../media/sample-nobf.mp4", import.meta.url).pathname;

function ffprobeVideoPts(path: string): number[] {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "frame=pts_time", "-of", "csv=p=0", path,
  ]).toString().trim();
  return out.split("\n").map(l => Number(l.split(",")[0]));
}

function ffprobeKeyframes(path: string): number[] {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "frame=best_effort_timestamp_time,pict_type",
    "-of", "csv=p=0", path,
  ]).toString().trim().split("\n");
  return out.filter(l => l.split(",")[1] === "I").map(l => Number(l.split(",")[0]));
}

test("demux parses video and audio tracks", () => {
  const buf = readFileSync(SAMPLE);
  const d = demux(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  assert.ok(d.video, "video track");
  assert.ok(d.audio, "audio track");
  assert.equal(d.video.width, 960);
  assert.equal(d.video.height, 540);
  assert.match(d.video.codec, /^avc1\./);
  assert.ok(d.video.codecDescription, "avcC description present");
  assert.equal(d.video.samples.length, 360);
  assert.equal(d.audio.sampleRate, 48000);
  assert.ok(d.audio.samples.length > 500, "aac frames present");
});

test("video CTS matches ffprobe pts (B-frame reorder)", () => {
  const buf = readFileSync(SAMPLE);
  const d = demux(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const probe = ffprobeVideoPts(SAMPLE);
  const ours = d.video!.samples.map(s => s.cts).sort((a, b) => a - b);
  assert.equal(ours.length, probe.length);
  for (let i = 0; i < ours.length; i++) {
    assert.ok(Math.abs(ours[i] - probe[i]) < 1e-3,
      `pts[${i}] ours=${ours[i]} probe=${probe[i]}`);
  }
});

test("keyframe positions match ffprobe", () => {
  const buf = readFileSync(SAMPLE);
  const d = demux(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const probe = ffprobeKeyframes(SAMPLE);
  const ours = d.video!.samples.filter(s => s.keyframe).map(s => s.cts);
  assert.deepEqual(
    ours.map(t => Math.round(t * 1000)),
    probe.map(t => Math.round(t * 1000)),
  );
});

test("samplesForRange starts at keyframe at/before range start", () => {
  const buf = readFileSync(SAMPLE);
  const d = demux(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  // 10.0..12.0: keyframes at every 1s, so first sample must be cts ~10.0
  const range = samplesForRange(d.video!, 10.0, 12.0);
  assert.ok(range[0].keyframe);
  assert.ok(Math.abs(range[0].cts - 10.0) < 0.04, `first cts=${range[0].cts}`);
  const lastCts = Math.max(...range.map(s => s.cts));
  assert.ok(lastCts >= 11.9, `last cts=${lastCts}`);
  // 10.5..12.0: must still begin at the 10.0 keyframe
  const range2 = samplesForRange(d.video!, 10.5, 12.0);
  assert.ok(range2[0].keyframe);
  assert.ok(range2[0].cts <= 10.5);
});

test("extractSample returns NAL data starting with annex-b or length prefix", () => {
  const buf = readFileSync(SAMPLE_NOBF);
  const d = demux(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const s = d.video!.samples.find(x => x.keyframe)!;
  const raw = extractSample(d.data, s);
  assert.equal(raw.length, s.size);
  // AVCC: first 4 bytes are the NAL length
  const nalLen = new DataView(raw.buffer, raw.byteOffset).getUint32(0);
  assert.ok(nalLen > 0 && nalLen < raw.length);
});

test("no-B-frames clip: dts order equals cts order", () => {
  const buf = readFileSync(SAMPLE_NOBF);
  const d = demux(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const cts = d.video!.samples.map(s => s.cts);
  const sorted = [...cts].sort((a, b) => a - b);
  assert.deepEqual(cts, sorted);
});
