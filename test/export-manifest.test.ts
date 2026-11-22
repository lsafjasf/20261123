import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../src/shared/types.ts";
import { buildExportManifest, buildPlans, buildTimeline } from "../src/shared/timeline.ts";
import { cropAt } from "../src/shared/camera.ts";
import { rectContainsRect } from "../src/shared/geometry.ts";

const project = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures", "project.json"), "utf8"),
) as Project;

test("fixture project keeps all 18 images in order with narration-driven holds", () => {
  assert.equal(project.images.length, 18);
  const timeline = buildTimeline(project);
  assert.deepEqual(
    timeline.segments.map((segment) => segment.imageId),
    project.images.map((image) => image.id),
  );
  const longText = project.images.find((image) => (image.narrationText?.length ?? 0) > 20);
  const shortText = project.images.find((image) => (image.narrationText?.length ?? 0) < 6);
  assert.ok(longText && shortText);
  const longSegment = timeline.segments.find((segment) => segment.imageId === longText.id);
  const shortSegment = timeline.segments.find((segment) => segment.imageId === shortText.id);
  assert.ok(longSegment && shortSegment);
  assert.ok(longSegment.holdSeconds > shortSegment.holdSeconds);
  assert.ok(longSegment.holdSeconds <= project.narration.maxHoldSeconds);
});

test("export manifest crops stay inside usable frames at every sample", () => {
  const bundle = buildPlans(project);
  const { segments } = buildExportManifest(project, bundle, new Date(0).toISOString());
  assert.equal(segments.length, 18);
  for (const record of segments) {
    const image = project.images.find((item) => item.id === record.imageId);
    assert.ok(image);
    assert.ok(record.inPoint < record.outPoint);
    for (const sample of record.cropSamples) {
      const crop = sample.crop;
      const epsilon = 1e-9;
      assert.ok(rectContainsRect(
        {
          x: image.usableFrame.x - epsilon,
          y: image.usableFrame.y - epsilon,
          width: image.usableFrame.width + epsilon * 2,
          height: image.usableFrame.height + epsilon * 2,
        },
        crop,
      ));
      assert.ok(Math.abs(crop.width / crop.height - project.video.width / project.video.height) < 1e-9);
    }
  }
});

test("manifest crop samples match the camera function at matching progress", () => {
  const bundle = buildPlans(project);
  const { segments } = buildExportManifest(project, bundle, new Date(0).toISOString());
  const plan = bundle.plans.get(project.images[0].id);
  assert.ok(plan);
  const record = segments[0];
  for (const sample of record.cropSamples) {
    const expected = cropAt(plan, sample.progress);
    assert.ok(Math.abs(expected.x - sample.crop.x) < 1e-12);
    assert.ok(Math.abs(expected.width - sample.crop.width) < 1e-12);
  }
});
