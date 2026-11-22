import test from "node:test";
import assert from "node:assert/strict";
import { makeProject } from "./helpers.ts";
import { buildExportManifest, buildPlans, buildTimeline, holdForSegment } from "../src/shared/timeline.ts";

test("narration length extends hold while order stays fixed", () => {
  const project = makeProject();
  const short = holdForSegment(project.images[0], project.narration);
  const long = holdForSegment({
    ...project.images[0],
    narrationText: "字".repeat(40),
  }, project.narration);

  assert.equal(short.holdSeconds, project.narration.baseHoldSeconds);
  assert.ok(long.holdSeconds > short.holdSeconds);
  assert.ok(long.holdSeconds <= project.narration.maxHoldSeconds);

  const timeline = buildTimeline(project);
  assert.equal(timeline.segments.length, 18);
  assert.deepEqual(
    timeline.segments.map((segment) => segment.imageId),
    project.images.map((image) => image.id),
  );
  for (let i = 1; i < timeline.segments.length; i += 1) {
    const previous = timeline.segments[i - 1];
    const current = timeline.segments[i];
    assert.ok(Math.abs(current.enterAt - previous.leaveAt) < 1e-9);
    assert.ok(Math.abs(current.enterAt - (previous.end - timeline.transitionSeconds)) < 1e-9);
    assert.ok(current.enterAt >= previous.enterAt);
  }
});

test("last segment has no outgoing transition and frame count matches duration", () => {
  const project = makeProject();
  const timeline = buildTimeline(project);
  const last = timeline.segments[17];
  assert.equal(last.end, timeline.duration);
  assert.equal(timeline.frameCount, Math.round(timeline.duration * project.video.fps));
});

test("full narration track can extend total duration", () => {
  const project = makeProject();
  const baseline = buildTimeline(project);
  const extended = buildTimeline(project, baseline.duration + 6);
  assert.ok(extended.duration > baseline.duration);
  assert.equal(extended.segments.length, baseline.segments.length);
});

test("export manifest carries in/out points and crop parameters", () => {
  const project = makeProject();
  const bundle = buildPlans(project);
  const manifest = buildExportManifest(project, bundle, new Date(0).toISOString());
  assert.equal(manifest.segments.length, 18);
  const first = manifest.segments[0];
  assert.equal(first.inPoint, 0);
  assert.equal(first.transitionIn, 0);
  assert.ok(first.transitionOut > 0);
  assert.ok(first.cropSamples.length >= 2);
  assert.ok(first.cropSamples[0].crop.width > 0);
});
