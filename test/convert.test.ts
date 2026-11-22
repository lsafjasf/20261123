import { test } from "node:test";
import assert from "node:assert/strict";
import { rational } from "../src/core/rational.ts";
import { videoGrid, audioGrid, defaultTolerance } from "../src/core/time.ts";
import { convertClip, convertTrack, type ConvertContext } from "../src/migrate/convert.ts";
import type { LegacyClip, LegacyMedia, LegacyTrack } from "../src/legacy/schema.ts";

const FPS = rational(30000n, 1001n);
const VIDEO = videoGrid(FPS);
const AUDIO = audioGrid(48000);
const TOL = defaultTolerance(VIDEO, AUDIO);

const mediaVideo: LegacyMedia = {
  id: "m1", path: "a.mp4", kind: "video", durationMs: 60000,
};
const mediaAudio: LegacyMedia = {
  id: "m2", path: "a.wav", kind: "audio", durationMs: 60000, sampleRate: 48000,
};

function ctx(grid = VIDEO): ConvertContext {
  return {
    sequenceId: "s", trackId: "t", grid,
    tolerance: TOL, sourceHash: "x",
  };
}

function clip(partial: Partial<LegacyClip>): LegacyClip {
  return {
    id: "c1", mediaId: "m1", timelineStartMs: 0,
    sourceInMs: 0, sourceOutMs: 1001,
    ...partial,
  };
}

test("exact cuts convert with empty rounded list", () => {
  const { clip: out, roundedCuts } = convertClip(clip({}), mediaVideo, ctx());
  assert.equal(out.timelineStart, 0);
  assert.equal(out.sourceIn, 0);
  assert.equal(out.sourceOut, 30);
  assert.equal(out.duration, 30);
  assert.equal(roundedCuts.length, 0);
  assert.equal(out.provenance.cuts.length >= 4, true);
});

test("inexact cut is recorded with signed error", () => {
  const { clip: out, roundedCuts } = convertClip(
    clip({ timelineStartMs: 1 }), mediaVideo, ctx(),
  );
  assert.equal(out.timelineStart, 0);
  assert.equal(roundedCuts.length, 1);
  assert.equal(roundedCuts[0].point, "timelineStart");
  assert.equal(roundedCuts[0].legacyMs, 1);
  assert.ok(Math.abs(roundedCuts[0].errorMs - 1) < 1e-9);
});

test("requireExactCuts quarantines inexact clips", () => {
  const strict = { ...ctx(), tolerance: { ...TOL, requireExactCuts: true } };
  assert.throws(
    () => convertClip(clip({ timelineStartMs: 1 }), mediaVideo, strict),
    /not exactly representable/,
  );
});

test("constant speed maps duration through the rate", () => {
  const { clip: out } = convertClip(
    clip({ sourceOutMs: 2002, speed: 2 }), mediaVideo, ctx(),
  );
  assert.equal(out.duration, 30);
  assert.deepEqual(out.speed, { num: 2, den: 1 });
});

test("speed segments accumulate exactly and round once per boundary", () => {
  const { clip: out } = convertClip(
    clip({
      sourceInMs: 0,
      sourceOutMs: 3003,
      speedSegments: [
        { sourceInMs: 0, sourceOutMs: 1001, rate: 1 },
        { sourceInMs: 1001, sourceOutMs: 2002, rate: 2 },
        { sourceInMs: 2002, sourceOutMs: 3003, rate: 0.5 },
      ],
    }),
    mediaVideo,
    ctx(),
  );
  assert.equal(out.duration, 105);
  assert.equal(out.speedSegments?.length, 3);
  assert.equal(out.speedSegments?.[1].timelineStart, 30);
  assert.equal(out.speedSegments?.[1].timelineDuration, 15);
});

test("bad clips throw ClipMigrationError with reasons", () => {
  assert.throws(
    () => convertClip(clip({ sourceOutMs: 0 }), mediaVideo, ctx()),
    /empty or reversed/,
  );
  assert.throws(
    () => convertClip(clip({ sourceOutMs: 99999 }), mediaVideo, ctx()),
    /exceeds media duration/,
  );
  assert.throws(
    () => convertClip(clip({ speed: 0 }), mediaVideo, ctx()),
    /invalid playback rate/,
  );
});

test("audio clip converts on the media sample rate", () => {
  const audioClip = clip({ mediaId: "m2", sourceOutMs: 1000 });
  const { clip: out } = convertClip(audioClip, mediaAudio, ctx(AUDIO));
  assert.equal(out.sourceOut, 48000);
  assert.equal(out.duration, 48000);
  assert.equal(out.sampleRate, 48000);
});

test("convertTrack isolates failures and resolves transitions", () => {
  const track: LegacyTrack = {
    id: "v1",
    kind: "video",
    clips: [
      clip({ id: "a", timelineStartMs: 0, sourceOutMs: 1001 }),
      clip({
        id: "b",
        timelineStartMs: 700,
        sourceInMs: 0,
        sourceOutMs: 1001,
        transitionIn: { type: "crossfade", durationMs: 300 },
      }),
      clip({ id: "bad", timelineStartMs: 5000, sourceOutMs: 99999 }),
    ],
  };
  const media = new Map([["m1", mediaVideo]]);
  const result = convertTrack(track, media, () => ctx());
  assert.deepEqual(result.clips.map((c) => c.id), ["a", "b"]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].clipId, "bad");
  const b = result.clips[1];
  assert.equal(b.transitionIn?.overlapWithClipId, "a");
  // a ends at frame 30; b starts at round(700ms) = 21 -> overlap 9 frames.
  assert.equal(b.transitionIn?.duration, 9);
});

test("transition exceeding overlap is quarantined", () => {
  const track: LegacyTrack = {
    id: "v1",
    kind: "video",
    clips: [
      clip({ id: "a", timelineStartMs: 0, sourceOutMs: 1001 }),
      clip({
        id: "b",
        timelineStartMs: 900,
        sourceInMs: 0,
        sourceOutMs: 1001,
        transitionIn: { type: "crossfade", durationMs: 500 },
      }),
    ],
  };
  const media = new Map([["m1", mediaVideo]]);
  const result = convertTrack(track, media, () => ctx());
  assert.deepEqual(result.clips.map((c) => c.id), ["a"]);
  assert.equal(result.failures[0].clipId, "b");
  assert.match(result.failures[0].reason, /exceeds overlap/);
});
