import test from "node:test";
import assert from "node:assert/strict";
import { generateDemoAudio } from "../web/src/core/demo.ts";
import { detectPauses } from "../web/src/core/detection.ts";
import { masterAudio } from "../web/src/core/loudness.ts";
import { renderProject } from "../web/src/core/render.ts";
import { decodeWav, encodeWav24 } from "../web/src/core/wav.ts";

test("demo project runs through detection, speed, mastering and WAV export", () => {
  const source = generateDemoAudio();
  const settings = { minSilenceMs: 800, targetMs: 250, smartProtection: true };
  const segments = detectPauses(source, settings);
  assert.ok(segments.length >= 6, `expected rich demo pauses, got ${segments.length}`);
  assert.ok(segments.every((segment) => segment.duration >= 0.75));

  const rendered = renderProject(source, {
    speed: 1.5,
    targetMs: 250,
    segments,
  });
  assert.ok(rendered.duration < source.channels[0].length / source.sampleRate / 1.5);
  assert.ok(rendered.timeline.every((item) => Math.abs(
    item.outputEnd - item.outputStart - 0.25,
  ) < 0.015));

  const mastered = masterAudio(rendered.channels, rendered.sampleRate, -14, -1);
  assert.ok(Math.abs(mastered.integratedLufs - -14) < 0.5, `LUFS ${mastered.integratedLufs}`);
  assert.ok(mastered.truePeakDb <= -0.9, `peak ${mastered.truePeakDb}`);

  const encoded = encodeWav24(mastered.channels, rendered.sampleRate);
  const decoded = decodeWav(encoded, "delivery.wav");
  assert.equal(decoded.bitDepth, 24);
  assert.equal(decoded.channels[0].length, rendered.channels[0].length);
});
