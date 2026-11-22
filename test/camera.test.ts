import test from "node:test";
import assert from "node:assert/strict";
import type { MotionMode, Rect } from "../src/shared/types.ts";
import { buildCameraPlan, cropAt, sampleCrops } from "../src/shared/camera.ts";

const usable: Rect = { x: 0.04, y: 0.05, width: 0.92, height: 0.9 };
const focus: Rect = { x: 0.3, y: 0.28, width: 0.18, height: 0.24 };
const aspect = 16 / 9;

function contained(outer: Rect, inner: Rect): boolean {
  const epsilon = 1e-9;
  return inner.x >= outer.x - epsilon &&
    inner.y >= outer.y - epsilon &&
    inner.x + inner.width <= outer.x + outer.width + epsilon &&
    inner.y + inner.height <= outer.y + outer.height + epsilon;
}

function planFor(mode: MotionMode, index = 0, focusOverride?: Rect, usableOverride?: Rect) {
  return buildCameraPlan({
    imageId: "img",
    pixelWidth: 3840,
    pixelHeight: 2160,
    focusBox: focusOverride ?? focus,
    usableFrame: usableOverride ?? usable,
    mode,
    outputAspect: aspect,
    index,
  });
}

for (const mode of ["push-in", "pull-out", "pan", "auto"] as MotionMode[]) {
  test(`${mode} crops never leave the usable frame`, () => {
    const plan = planFor(mode);
    for (const sample of sampleCrops(plan, 40)) {
      assert.ok(
        contained(usable, sample.crop),
        `crop escapes usable frame: ${JSON.stringify(sample.crop)}`,
      );
    }
  });
}

test("push-in narrows the crop and pull-out widens it", () => {
  const push = planFor("push-in");
  assert.ok(push.endCrop.width < push.startCrop.width);
  const pull = planFor("pull-out");
  assert.ok(pull.endCrop.width > pull.startCrop.width);
});

test("all intermediate crops keep the output aspect ratio", () => {
  const plan = planFor("auto", 3);
  for (let i = 0; i <= 20; i += 1) {
    const crop = cropAt(plan, i / 20);
    assert.ok(Math.abs(crop.width / crop.height - aspect) < 1e-9);
  }
});

test("tight usable frame still produces a valid contained crop covering focus", () => {
  const tight: Rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.55 };
  const plan = planFor("push-in", 0, focus, tight);
  for (const sample of sampleCrops(plan, 10)) {
    assert.ok(contained(tight, sample.crop));
  }
});

test("pan with edge focus keeps every frame inside bounds", () => {
  const edgeFocus: Rect = { x: 0.76, y: 0.62, width: 0.16, height: 0.2 };
  const plan = planFor("pan", 1, edgeFocus);
  for (const sample of sampleCrops(plan, 30)) {
    assert.ok(contained(usable, sample.crop));
  }
});

test("large focus box remains inside every crop window", () => {
  const largeFocus: Rect = { x: 0.2, y: 0.2, width: 0.6, height: 0.5 };
  for (const mode of ["push-in", "pull-out", "pan"] as MotionMode[]) {
    const plan = planFor(mode, 0, largeFocus);
    for (const sample of sampleCrops(plan, 20)) {
      const crop = sample.crop;
      assert.ok(crop.x <= largeFocus.x + 1e-9);
      assert.ok(crop.y <= largeFocus.y + 1e-9);
      assert.ok(crop.x + crop.width >= largeFocus.x + largeFocus.width - 1e-9);
      assert.ok(crop.y + crop.height >= largeFocus.y + largeFocus.height - 1e-9);
    }
  }
});
