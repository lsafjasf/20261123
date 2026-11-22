import assert from "node:assert/strict";
import test from "node:test";
import { checkManifestInput, formatCheckReport } from "../src/checker/checker.ts";
import { parseManifest } from "../src/checker/manifest.ts";
import { simulateRoundedDurationAccumulation } from "../src/diagnostics/rounding.ts";
import { Rational, rational } from "../src/time/rational.ts";
import { ExactTimeline } from "../src/time/timeline.ts";

const NTSC_FPS = rational("30000/1001");
const timeline = new ExactTimeline({
  sourceFps: NTSC_FPS,
  displayFps: NTSC_FPS,
  audioSampleRate: "48000",
});

test("root cause: rounded 33 ms frame duration accumulates past one second", () => {
  const legacy = simulateRoundedDurationAccumulation(NTSC_FPS, 3000n);
  assert.equal(legacy.frameDurationMs.toString(), "33");
  assert.equal(legacy.accumulatedTimeMs.toString(), "99000");
  assert.equal(legacy.exactTimeMs.toString(), "100100");
  assert.equal(legacy.driftMs.abs().toString(), "1100");
});

test("the fixed clock stays on frame 1,000,000 with zero shift", () => {
  const sourceFrame = 1_000_000n;
  const time = timeline.sourceFrameTime(sourceFrame);
  const display = timeline.timeToDisplayFrame(time);
  const audio = timeline.timeToAudioSample(time);
  assert.equal(display.integer, sourceFrame);
  assert.equal(display.residual.toString(), "0");
  assert.equal(audio.integer, 1_601_600_000n);
  assert.equal(audio.residual.toString(), "0");
  assert.equal(time.toString(), "100100/3");
});

test("long mixed sequence proves cuts, subtitles and audio stay on targets", () => {
  const events: unknown[] = [];
  const spanFrames = 100_000_000n;
  const eventCount = 12_000;
  for (let index = 0; index < eventCount; index += 1) {
    const frame = (spanFrames * BigInt(index + 1)) / BigInt(eventCount + 1);
    const at = timeline.sourceFrameTime(frame).toString();
    if (index % 3 === 0) {
      events.push({ id: `cut-${index}`, kind: "cut", at, sourceFrame: frame.toString() });
    } else if (index % 3 === 1) {
      const end = timeline.sourceFrameTime(frame + 240n).toString();
      events.push({ id: `sub-${index}`, kind: "subtitle", start: at, end });
    } else {
      events.push({ id: `audio-${index}`, kind: "audio", at });
    }
  }
  const report = checkManifestInput({
    sourceFps: "30000/1001",
    displayFps: "30000/1001",
    audioSampleRate: "48000",
    events,
  });
  assert.equal(report.ok, true);
  assert.equal(report.passed, eventCount);
  assert.equal(report.failed, 0);
  for (const event of report.events) {
    for (const marker of event.markers) {
      assert.equal(marker.frameResidual.toString(), "0");
      assert.ok(marker.sampleResidual.abs().compare(Rational.of(1n, 2n)) <= 0);
    }
  }
});

test("checker reports frames and samples instead of only formatted seconds", () => {
  const report = checkManifestInput({
    sourceFps: "30000/1001",
    displayFps: "30000/1001",
    audioSampleRate: "48000",
    events: [
      {
        id: "cut",
        kind: "cut",
        at: "1001/10",
        sourceFrame: "3000",
      },
      {
        id: "subtitle",
        kind: "subtitle",
        start: "1001/10",
        end: "1001/5",
      },
      {
        id: "audio",
        kind: "audio",
        at: "1001/10",
      },
    ],
  });
  const output = formatCheckReport(report);
  assert.match(output, /sourceFps=30000\/1001/);
  assert.match(output, /audioSampleRate=48000/);
  assert.match(output, /displayFrame=3000/);
  assert.match(output, /audioSample=4804800/);
  assert.match(output, /edit=1001\/10s/);
  assert.match(output, /zero global offset accepted/);
  assert.doesNotMatch(output, /^PASS.*seconds$/m);
});

test("manifest persistence round-trips rates and edit time as exact ratios", () => {
  const report = checkManifestInput({
    sourceFps: { n: "30000", d: "1001" },
    displayFps: { n: "30000", d: "1001" },
    audioSampleRate: { n: "48000", d: "1" },
    events: [
      {
        id: "persisted-cut",
        kind: "cut",
        at: { n: "1001", d: "10" },
        sourceFrame: "3000",
      },
    ],
  });
  assert.equal(report.ok, true);
  assert.equal(report.events[0].markers[0].editTime.toString(), "1001/10");
  assert.equal(report.events[0].markers[0].displayFrame, 3000n);
  assert.equal(report.events[0].markers[0].audioSample, 4_804_800n);
});

test("a source-frame mismatch is reported and never silently offset", () => {
  const report = checkManifestInput({
    sourceFps: "30000/1001",
    displayFps: "30000/1001",
    audioSampleRate: "48000",
    events: [{ id: "late-cut", kind: "cut", at: "1002/10", sourceFrame: "3000" }],
  });
  assert.equal(report.ok, false);
  assert.match(report.events[0].failures[0], /no offset applied/);
});

test("global/manual offset knobs are rejected at parse time", () => {
  for (const key of ["globalOffset", "globalOffsetMs", "manualOffset", "syncOffset"]) {
    assert.throws(
      () =>
        parseManifest({
          sourceFps: "30000/1001",
          displayFps: "30000/1001",
          audioSampleRate: "48000",
          events: [],
          [key]: "1",
        }),
      /is not accepted/,
    );
  }
});
