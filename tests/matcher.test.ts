import assert from "node:assert/strict";
import test from "node:test";
import { audioSimilarity, proposeMatch, visualSimilarity } from "../src/client/matcher.ts";
import type { Candidate, MediaRef } from "../src/client/types.ts";

function ref(overrides: Partial<MediaRef> = {}): MediaRef {
  return {
    key: "r1",
    assetId: "r1",
    name: "IMG_0001.MOV",
    filename: "IMG_0001.MOV",
    sourcePath: "/old/IMG_0001.MOV",
    duration: 5,
    width: 1280,
    height: 720,
    fps: 30,
    videoCodec: "avc1",
    audioCodec: "mp4a",
    audioChannels: 2,
    sampleRate: 48000,
    timelineRefs: [{ id: "clip-1", kind: "clip", offset: "0s", start: "0s", duration: "5s" }],
    ...overrides
  };
}

function candidate(path: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    path,
    relPath: path.split("/").slice(-2).join("/"),
    name: "IMG_0001.MOV",
    ext: ".mov",
    size: 1000,
    mtimeMs: 1,
    duration: 5,
    width: 1280,
    height: 720,
    fps: 30,
    videoCodec: "avc1",
    audioCodec: "mp4a",
    audioChannels: 2,
    sampleRate: 48000,
    ...overrides
  };
}

test("exact hash produces an automatic match", () => {
  const proposal = proposeMatch(
    ref({ sha256: "abc" }),
    [candidate("/new/a/IMG_0001.MOV", { sha256: "abc" }), candidate("/new/b/IMG_0001.MOV", { sha256: "def" })]
  );
  assert.equal(proposal.decision, "auto");
  assert.match(proposal.reason, /SHA-256/);
});

test("same-name candidates without reference evidence require review", () => {
  const proposal = proposeMatch(ref(), [
    candidate("/new/a/IMG_0001.MOV", { visualHash: "a".repeat(128) }),
    candidate("/new/b/IMG_0001.MOV", { visualHash: "b".repeat(128) })
  ]);
  assert.equal(proposal.decision, "review");
  assert.equal(proposal.ranked.length, 2);
});

test("a unique candidate with exact metadata can be matched automatically", () => {
  const proposal = proposeMatch(ref(), [candidate("/new/only/IMG_0001.MOV")]);
  assert.equal(proposal.decision, "auto");
});

test("missing media is reported separately", () => {
  const proposal = proposeMatch(ref(), []);
  assert.equal(proposal.decision, "missing");
  assert.equal(proposal.ranked.length, 0);
});

test("a hash conflict prevents automatic matching", () => {
  const proposal = proposeMatch(
    ref({ sha256: "abc" }),
    [candidate("/new/a/IMG_0001.MOV", { sha256: "def" })]
  );
  assert.equal(proposal.decision, "review");
  assert.ok(proposal.ranked[0].flags.includes("哈希冲突"));
});

test("audio and visual comparisons prefer the identical fingerprint", () => {
  const fp = { v: 1 as const, sr: 48000, bands: 8, frames: 16, data: "AAAA" };
  assert.equal(audioSimilarity(fp, fp), 1);
  assert.equal(visualSimilarity("abcd", "abcd"), 1);
  assert.ok((visualSimilarity("abcd", "abce") ?? 1) < 1);
});
