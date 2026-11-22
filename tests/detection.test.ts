import test from "node:test";
import assert from "node:assert/strict";
import { detectPauses, detectionStats } from "../web/src/core/detection.ts";

function makeSource(parts: Array<"tone" | "silence">, sampleRate = 48000): Float32Array {
  const second = 1;
  const output = new Float32Array(parts.length * second * sampleRate);
  let cursor = 0;
  for (const part of parts) {
    if (part === "tone") {
      for (let index = 0; index < sampleRate; index += 1) {
        output[cursor + index] = Math.sin((Math.PI * 2 * 220 * index) / sampleRate) * 0.2;
      }
    }
    cursor += sampleRate;
  }
  return output;
}

test("finds a long pause between tone regions", () => {
  const channel = makeSource(["tone", "silence", "tone"]);
  const segments = detectPauses(
    { channels: [channel], sampleRate: 48000 },
    { minSilenceMs: 800, targetMs: 250, smartProtection: true },
  );

  assert.equal(segments.length, 1);
  assert.ok(segments[0].sourceStart >= 1 && segments[0].sourceStart < 1.04);
  assert.ok(segments[0].sourceEnd <= 2 && segments[0].sourceEnd > 1.95);
  assert.ok(segments[0].confidence >= 55);
  assert.equal(segments[0].state, "active");
});

test("short gaps stay untouched", () => {
  const source = { channels: [makeSource(["tone", "silence", "tone"])], sampleRate: 48000 };
  const segments = detectPauses(source, {
    minSilenceMs: 1200,
    targetMs: 250,
    smartProtection: true,
  });
  assert.equal(segments.length, 0);
});

test("stats only count active cuts", () => {
  const stats = detectionStats([
    {
      id: "a",
      sourceStart: 1,
      sourceEnd: 2.2,
      duration: 1.2,
      confidence: 90,
      levelDb: -70,
      spectralTilt: 0.1,
      state: "active",
      targetMs: 250,
      kind: "clean",
    },
    {
      id: "b",
      sourceStart: 3,
      sourceEnd: 4.2,
      duration: 1.2,
      confidence: 90,
      levelDb: -70,
      spectralTilt: 0.1,
      state: "bypassed",
      targetMs: 250,
      kind: "clean",
    },
  ]);
  assert.equal(stats.activeCount, 1);
  assert.ok(Math.abs(stats.removedSeconds - 0.95) < 1e-9);
});
