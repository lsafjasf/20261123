import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demux, extractSample } from "../src/shared/mp4.ts";
import { initSegment, mediaSegment, concatSegments, type MuxSample } from "../src/app/mux.ts";

const SAMPLE = new URL("../media/sample-nobf.mp4", import.meta.url).pathname;

test("muxed fMP4 is readable by ffprobe with correct packets", () => {
  const buf = readFileSync(SAMPLE);
  const d = demux(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const track = d.video!;
  const TIMESCALE = 90000;
  const src = track.samples.slice(0, 60); // 2 seconds, no B-frames
  const samples: MuxSample[] = src.map(s => ({
    data: extractSample(d.data, s),
    duration: Math.round(s.duration * TIMESCALE),
    ctsOffset: Math.round((s.cts - s.dts) * TIMESCALE),
    keyframe: s.keyframe,
  }));
  const init = initSegment({
    codec: track.codec,
    width: track.width,
    height: track.height,
    timescale: TIMESCALE,
    description: track.codecDescription!,
  });
  const media = mediaSegment(samples, 0);
  const file = concatSegments(init, media);
  const dir = mkdtempSync(join(tmpdir(), "mux-test-"));
  const path = join(dir, "out.mp4");
  writeFileSync(path, file);

  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-show_streams", "-show_format",
    "-of", "json", path,
  ]).toString());
  const vs = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  assert.equal(vs.codec_name, "h264");
  assert.equal(vs.width, 960);
  assert.equal(vs.height, 540);

  const packets = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "packet=pts_time,flags", "-of", "json", path,
  ]).toString()).packets;
  assert.equal(packets.length, 60);
  assert.ok(packets[0].flags.includes("K"), "first packet is keyframe");
  const pts = packets.map((p: { pts_time: string }) => Number(p.pts_time));
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i] > pts[i - 1], `pts monotonic at ${i}`);
  }
  assert.ok(Math.abs(pts[pts.length - 1] - 59 / 30) < 0.01, `last pts=${pts.at(-1)}`);
});
