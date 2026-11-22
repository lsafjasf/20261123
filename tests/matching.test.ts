import assert from "node:assert/strict";
import { test } from "node:test";
import { findRepeatedTakes } from "../src/analysis/matching.ts";
import type { AudioFeatures, AnalysisSettings } from "../src/shared/types.ts";

const HOP = 0.05;

function makeFeatures(durationSec: number): AudioFeatures {
  const frameCount = Math.ceil(durationSec / HOP);
  return {
    durationSec,
    sampleRate: 8000,
    hopSec: HOP,
    frameCount,
    midi: new Float32Array(frameCount).fill(Number.NaN),
    confidence: new Float32Array(frameCount),
    rms: new Float32Array(frameCount),
    flatness: new Float32Array(frameCount).fill(0.1),
    voiced: new Uint8Array(frameCount),
    stats: {
      voicedSec: 0,
      silentSec: 0,
      noisySec: 0,
      rejectedRegions: 0,
    },
  };
}

function addPhrase(
  features: AudioFeatures,
  startSec: number,
  notes: number[],
  noteSec: number,
  transpose = 0,
  flatness = 0.1,
): void {
  for (let noteIndex = 0; noteIndex < notes.length; noteIndex++) {
    const from = Math.floor((startSec + noteIndex * noteSec) / HOP);
    const to = Math.floor((startSec + (noteIndex + 1) * noteSec) / HOP);
    for (let frame = from; frame < to && frame < features.frameCount; frame++) {
      features.midi[frame] = notes[noteIndex] + transpose;
      features.voiced[frame] = 1;
      features.confidence[frame] = 0.82;
      features.rms[frame] = 0.08;
      features.flatness[frame] = flatness;
    }
  }
}

const MELODY = [60, 62, 64, 67, 64, 62, 60, 59, 60, 64, 67, 69];
const OTHER = [72, 71, 69, 67, 65, 64, 62, 60, 58, 57, 55, 53];

const SETTINGS: AnalysisSettings = {
  minRepeatSec: 3,
  minGapSec: 30,
  transposeSemitones: 2,
  similarityThreshold: 0.76,
};

test("finds a repeated melody far apart and ignores another melody", () => {
  const features = makeFeatures(120);
  addPhrase(features, 10, MELODY, 0.45);
  addPhrase(features, 20, OTHER, 0.45);
  addPhrase(features, 72, MELODY, 0.5, 1);
  addPhrase(features, 100, OTHER, 0.5);
  const result = findRepeatedTakes(features, SETTINGS);
  assert.ok(result.groups.length >= 2);
  const best = result.groups.find((group) => group.occurrences.some((item) => item.start < 20 && item.start > 5) && group.occurrences.some((item) => item.start > 70 && item.start < 90));
  if (!best) throw new Error("Expected a group spanning both distant takes");
  assert.ok(best.occurrences.some((item) => item.start < 20));
  assert.ok(best.occurrences.some((item) => item.start > 70));
  for (const occurrence of best.occurrences) {
    assert.ok(occurrence.end - occurrence.start >= 2.9);
  }
});

test("does not treat repeated broadband-noise-like regions as takes", () => {
  const features = makeFeatures(120);
  addPhrase(features, 10, MELODY, 0.45, 0, 0.82);
  addPhrase(features, 72, MELODY, 0.5, 1, 0.82);
  const result = findRepeatedTakes(features, SETTINGS);
  assert.equal(result.groups.length, 0);
});

test("respects the minimum distance between repeated takes", () => {
  const features = makeFeatures(70);
  addPhrase(features, 10, MELODY, 0.45);
  addPhrase(features, 22, MELODY, 0.5, 1);
  const result = findRepeatedTakes(features, SETTINGS);
  assert.equal(result.groups.length, 0);
});
