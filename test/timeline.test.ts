import assert from "node:assert/strict";
import test from "node:test";
import { Rational, rational } from "../src/time/rational.ts";
import { ExactTimeline } from "../src/time/timeline.ts";

const ntsc = new ExactTimeline({
  sourceFps: "30000/1001",
  displayFps: "30000/1001",
  audioSampleRate: "48000",
});

test("matching source and display rates have zero residual at long distances", () => {
  const frames = [0n, 1n, 3000n, 1_000_000n, 100_000_000n];
  for (const sourceFrame of frames) {
    const mapping = ntsc.mapSourceFrameToDisplayFrame(sourceFrame);
    assert.equal(mapping.displayFrame, sourceFrame);
    assert.equal(mapping.residual.toString(), "0");
    assert.ok(
      ntsc.displayFrameTime(mapping.displayFrame).equals(ntsc.sourceFrameTime(sourceFrame)),
    );
  }
});

test("audio sample positions use absolute edit time and exact ratios", () => {
  const tenMinutes = Rational.integer(600n);
  assert.equal(ntsc.timeToAudioSample(tenMinutes).integer, 28_800_000n);
  assert.equal(ntsc.timeToAudioSample(tenMinutes).residual.toString(), "0");
  assert.ok(ntsc.audioSampleTime(28_800_000n).equals(tenMinutes));
});

test("non-commensurate rates keep residual bounded instead of accumulating", () => {
  const timeline = new ExactTimeline({
    sourceFps: "24000/1001",
    displayFps: "25",
    audioSampleRate: "44100",
  });
  for (let frame = 1n; frame <= 500_000n; frame += 997n) {
    const mapping = timeline.mapSourceFrameToDisplayFrame(frame);
    assert.ok(mapping.residual.abs().compare(Rational.of(1n, 2n)) <= 0);
    const sample = timeline.timeToAudioSample(timeline.sourceFrameTime(frame));
    assert.ok(sample.residual.abs().compare(Rational.of(1n, 2n)) <= 0);
  }
});

test("microsecond conversion happens once per absolute time", () => {
  const start = ntsc.timeToMicroseconds(ntsc.sourceFrameTime(0n));
  const end = ntsc.timeToMicroseconds(ntsc.sourceFrameTime(9_000_000n));
  assert.equal(start, 0n);
  assert.equal(end, 300_300_000_000n);
  const sum = Rational.integer(end - start).div(Rational.of(1_000_000n));
  assert.equal(sum.toString(), "300300");
});

test("display-to-source reverse mapping is deterministic", () => {
  for (const frame of [0n, 1n, 29_970n, 3_000_000n]) {
    const source = ntsc.mapDisplayFrameToSourceFrame(frame);
    assert.equal(source, frame);
  }
  const mixed = new ExactTimeline({
    sourceFps: rational("24000/1001"),
    displayFps: rational("25"),
    audioSampleRate: rational("48000"),
  });
  assert.equal(mixed.mapDisplayFrameToSourceFrame(1n), 0n);
  assert.equal(mixed.mapDisplayFrameToSourceFrame(2n), 1n);
});
