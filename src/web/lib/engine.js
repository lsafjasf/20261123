// 浏览器端检测引擎镜像：与 src/shared/engine.ts 同算法，
// 让样本实验室无需上传即可在本地核对检测结果。阈值与后端 /api/config 对齐。

function runsFromFlags(flags, gapTolerance, minFrames) {
  const runs = [];
  let start = -1;
  let pendingEnd = -1;
  let gap = 0;
  const flush = (end) => {
    if (start >= 0 && end - start + 1 >= minFrames) runs.push({ start, end });
    start = -1;
    pendingEnd = -1;
    gap = 0;
  };
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i]) {
      if (start < 0) start = i;
      pendingEnd = i;
      gap = 0;
    } else if (start >= 0) {
      gap += 1;
      if (gap > gapTolerance) flush(pendingEnd);
    }
  }
  if (start >= 0) flush(pendingEnd);
  return runs;
}

const avg = (values, pick) =>
  values.length ? values.reduce((sum, item) => sum + pick(item), 0) / values.length : 0;

export function analyze(frames, fps, config) {
  const blackFlags = frames.map((f) => f.blackRatio >= config.black.frameBlackRatio);
  const black = runsFromFlags(
    blackFlags,
    config.black.gapToleranceFrames,
    Math.round(config.black.minDurationSec * fps),
  );
  const blackIndexSet = new Set();
  black.forEach((run) => {
    for (let i = run.start; i <= run.end; i += 1) blackIndexSet.add(i);
  });

  const freezeFlags = frames.map(
    (f) =>
      f.index > 0 &&
      !blackIndexSet.has(f.index) &&
      f.diff <= config.freeze.diffThreshold &&
      f.motion <= config.freeze.motionThreshold,
  );
  const freeze = runsFromFlags(
    freezeFlags,
    config.freeze.gapToleranceFrames,
    Math.round(config.freeze.minDurationSec * fps),
  );

  const hit = frames.map(
    (f) =>
      f.motion >= config.shake.motionThreshold &&
      f.motionDisorder >= config.shake.disorderThreshold,
  );
  const windowFlags = frames.map((_, index) => {
    const from = Math.max(0, index - config.shake.windowFrames + 1);
    let hits = 0;
    for (let j = from; j <= index; j += 1) if (hit[j]) hits += 1;
    return hits / (index - from + 1) >= config.shake.windowHitRatio;
  });
  const shake = runsFromFlags(
    windowFlags,
    0,
    Math.round(config.shake.minDurationSec * fps),
  );

  const cuts = detectCuts(frames, config, shake, black);
  const boundaries = [0, ...cuts.map((cut) => cut.frame), frames.length];
  const minShot = Math.round(config.shot.minShotDurationSec * fps);
  const shots = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const run = { start: boundaries[i], end: boundaries[i + 1] - 1 };
    const prev = shots[shots.length - 1];
    if (prev && (run.end - run.start + 1 < minShot || prev.end - prev.start + 1 < minShot)) {
      prev.end = run.end;
    } else {
      shots.push({ ...run });
    }
  }
  return {
    black,
    freeze,
    shake,
    cuts,
    shots: shots.filter((run) => run.end >= run.start),
    averages: {
      blackMeanLuma: avg(frames, (f) => f.meanLuma),
      freezeDiff: avg(frames, (f) => f.diff),
      shakeMotion: avg(frames, (f) => f.motion),
    },
  };
}

function inRun(index, runs) {
  return runs.some((run) => index >= run.start && index <= run.end);
}

function detectCuts(frames, config, shakeRuns, blackRuns) {
  const cuts = [];
  const window = config.shot.dissolveWindowFrames;
  for (let i = 1; i < frames.length; i += 1) {
    if (inRun(i, shakeRuns) && inRun(i - 1, shakeRuns)) continue;
    if (inRun(i, blackRuns) || inRun(i - 1, blackRuns)) continue;
    const frame = frames[i];
    if (frame.motionDisorder >= config.shake.disorderThreshold) continue;
    if (frame.diff >= config.shot.hardCutDiff && frame.motion <= frame.diff * 1.25) {
      cuts.push({ frame: i, hard: true, score: frame.diff });
      continue;
    }
    const from = Math.max(1, i - window + 1);
    let sum = 0;
    for (let j = from; j <= i; j += 1) sum += frames[j].diff;
    const averageDiff = sum / (i - from + 1);
    const mid = (from + i) >> 1;
    const rising = frames[mid].diff - frames[from].diff;
    const falling = frames[mid].diff - frames[i].diff;
    const arched =
      rising >= config.shot.dissolveAvgDiff * 0.25 &&
      falling >= config.shot.dissolveAvgDiff * 0.25;
    if (
      averageDiff >= config.shot.dissolveAvgDiff &&
      frame.diff > config.freeze.diffThreshold &&
      arched &&
      frame.motionDisorder < config.shake.disorderThreshold
    ) {
      cuts.push({ frame: i, hard: false, score: averageDiff });
    }
  }
  const deduped = [];
  for (const cut of cuts) {
    const last = deduped[deduped.length - 1];
    if (last && cut.frame - last.frame < window) {
      if (cut.score > last.score) deduped[deduped.length - 1] = cut;
    } else {
      deduped.push(cut);
    }
  }
  return deduped;
}
