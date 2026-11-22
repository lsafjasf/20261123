import { rgbaToLuma } from "../core/color.js";
import { DEFAULT_SETTINGS, interpolateFrame } from "../core/interpolation.js";
import { lumaMae, peakLumaError } from "../core/metrics.js";
import { estimatePairMotion } from "../core/motion.js";
import {
  syntheticFrameAt,
  syntheticPanelMaskAt
} from "../core/synthetic.js";
import { buildFrameSchedule, summarizeTiming } from "../core/timeline.js";
                                                       

function runSequence(speed        , width = 192, height = 108, frameCount = 24)                 {
  const sourceFps = 24;
  const targetFps = 60;
  const start = performance.now();
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
  let panelNearest = 0;
  let peakError = 0;
  let edgeFrames = 0;
  let guardedRatio = 0;

  for (const entry of schedule) {
    let motion = motionCache.get(entry.sourceIndex);
    if (!motion) {
      motion = estimatePairMotion(
        luma[entry.sourceIndex],
        luma[entry.nextSourceIndex],
        DEFAULT_SETTINGS
      );
      motionCache.set(entry.sourceIndex, motion);
    }
    const result = interpolateFrame(
      source[entry.sourceIndex],
      source[entry.nextSourceIndex],
      entry.sourcePhase,
      DEFAULT_SETTINGS,
      motion,
      luma[entry.sourceIndex],
      luma[entry.nextSourceIndex]
    );
    const truth = syntheticFrameAt(entry.timeSec, width, height, speed);
    const nearest = source[entry.nearestSourceIndex];
    const panelMask = syntheticPanelMaskAt(entry.timeSec, width, height, speed);
    meanError += lumaMae(result.frame, truth);
    nearestError += lumaMae(nearest, truth);
    panelError += lumaMae(result.frame, truth, panelMask);
    panelNearest += lumaMae(nearest, truth, panelMask);
    peakError = Math.max(peakError, peakLumaError(result.frame, truth, panelMask));
    if (result.occlusionEdgeMask.some(Boolean)) edgeFrames += 1;
    guardedRatio += result.stats.occludedPixels / (width * height);
  }

  const count = schedule.length;
  const averageMean = meanError / count;
  const averageNearest = nearestError / count;
  return {
    sourceFrames: frameCount,
    outputFrames: count,
    timing: summarizeTiming(schedule, targetFps),
    meanAbsoluteError: averageMean,
    nearestFrameError: averageNearest,
    errorImprovement: averageNearest > 0 ? 1 - averageMean / averageNearest : 0,
    panelMeanAbsoluteError: panelError / count,
    panelNearestFrameError: panelNearest / count,
    peakAbsoluteError: peakError,
    occlusionEdgeCoverage: edgeFrames / count,
    guardedPixelRatio: guardedRatio / count,
    elapsedMs: performance.now() - start
  };
}

                                   
                         
                       
 

export async function runValidation()                            {
  await new Promise      ((resolve) => setTimeout(resolve, 20));
  const steady = runSequence(1.5);
  await new Promise      ((resolve) => setTimeout(resolve, 20));
  const fast = runSequence(3);
  return { steady, fast };
}
