import assert from "node:assert/strict";
import test from "node:test";
import { buildFrameSchedule } from "../public/js/core/timeline.js";
import {
  DEFAULT_SETTINGS,
  interpolateFrame
} from "../public/js/core/interpolation.js";
import { rgbaToLuma } from "../public/js/core/color.js";
import { estimatePairMotion } from "../public/js/core/motion.js";
import {
  syntheticFrameAt,
  syntheticPanelMaskAt
} from "../public/js/core/synthetic.js";
import { lumaMae } from "../public/js/core/metrics.js";

function interpolateSyntheticSequence({ speed, width, height, frameCount }) {
  const sourceFps = 24;
  const targetFps = 60;
  const source = Array.from({ length: frameCount }, (_, index) =>
    syntheticFrameAt(index / sourceFps, width, height, speed)
  );
  const luma = source.map(rgbaToLuma);
  const schedule = buildFrameSchedule({
    sourceFps,
    targetFps,
    sourceFrameCount: frameCount
  });
  const motionCache = new Map();
  let meanError = 0;
  let nearestError = 0;
  let panelError = 0;
  let panelNearestError = 0;
  let occludedPixels = 0;
  let occlusionEdges = 0;

  for (const entry of schedule) {
    const next = entry.nextSourceIndex;
    let motion = motionCache.get(entry.sourceIndex);
    if (!motion) {
      motion = estimatePairMotion(
        luma[entry.sourceIndex],
        luma[next],
        DEFAULT_SETTINGS
      );
      motionCache.set(entry.sourceIndex, motion);
    }
    const result = interpolateFrame(
      source[entry.sourceIndex],
      source[next],
      entry.sourcePhase,
      DEFAULT_SETTINGS,
      motion,
      luma[entry.sourceIndex],
      luma[next]
    );
    const truth = syntheticFrameAt(entry.timeSec, width, height, speed);
    const panelMask = syntheticPanelMaskAt(entry.timeSec, width, height, speed);
    const nearest = source[entry.nearestSourceIndex];
    meanError += lumaMae(result.frame, truth);
    nearestError += lumaMae(nearest, truth);
    panelError += lumaMae(result.frame, truth, panelMask);
    panelNearestError += lumaMae(nearest, truth, panelMask);
    occludedPixels += result.stats.occludedPixels / (width * height);
    occlusionEdges += result.occlusionEdgeMask.reduce(
      (total, value) => total + (value ? 1 : 0),
      0
    );
  }

  const count = schedule.length;
  return {
    schedule,
    meanError: meanError / count,
    nearestError: nearestError / count,
    panelError: panelError / count,
    panelNearestError: panelNearestError / count,
    occludedRatio: occludedPixels / count,
    occlusionEdges
  };
}

test("translation plus rotation beats nearest-frame hold", () => {
  const metrics = interpolateSyntheticSequence({
    speed: 1.5,
    width: 192,
    height: 108,
    frameCount: 24
  });

  assert.ok(metrics.meanError < metrics.nearestError * 0.95);
  assert.ok(metrics.panelError < metrics.panelNearestError);
  assert.ok(metrics.occlusionEdges > 0);
  assert.ok(metrics.occludedRatio < 0.2);
});

test("fast motion rejects blend instead of creating a large ghost", () => {
  const metrics = interpolateSyntheticSequence({
    speed: 3,
    width: 192,
    height: 108,
    frameCount: 24
  });

  assert.ok(metrics.meanError < 8);
  assert.ok(metrics.panelError <= metrics.panelNearestError * 1.02);
  assert.ok(metrics.occludedRatio < 0.15);
});

test("ROI keeps pixels outside the region on the source frame", () => {
  const width = 96;
  const height = 54;
  const source = syntheticFrameAt(0.4, width, height);
  const target = syntheticFrameAt(0.5, width, height);
  const sourceLuma = rgbaToLuma(source);
  const targetLuma = rgbaToLuma(target);
  const motion = estimatePairMotion(sourceLuma, targetLuma, DEFAULT_SETTINGS);
  const settings = {
    ...DEFAULT_SETTINGS,
    region: {
      ...DEFAULT_SETTINGS.region,
      enabled: true,
      x: 0,
      y: 0,
      width: 0.25,
      height: 1,
      feather: 0,
      strength: 1
    }
  };
  const result = interpolateFrame(
    source,
    target,
    0.5,
    settings,
    motion,
    sourceLuma,
    targetLuma
  );
  const pixel = (Math.floor(height / 2) * width + Math.floor(width * 0.8)) * 4;
  assert.deepEqual(
    Array.from(result.frame.data.slice(pixel, pixel + 4)),
    Array.from(target.data.slice(pixel, pixel + 4))
  );
});
