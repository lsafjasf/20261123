/**
 * 纯函数检测引擎：输入 FrameMetric[]，输出黑场/静止/抖动区间与镜头切分。
 * 不访问文件系统、网络或时间源（analyzedAt 由调用方注入），
 * 因此同样的指标与配置必然产生同样的结果，便于单测与重复扫描一致性校验。
 */
import {
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  SCHEMA_VERSION,
  configHash,
  fnv1a,
} from './config.ts';
import type { DetectorConfig } from './config.ts';
import { frameToTimecode } from './timecode.ts';
import type {
  AnalysisResult,
  FileLabel,
  FrameMetric,
  MetricBundle,
  Segment,
  ShotSegment,
} from './types.ts';

interface Run {
  start: number;
  end: number;
}

/** 把逐帧布尔判定合并为带容差、带最短时长的连续区间。 */
function runsFromFlags(
  flags: boolean[],
  gapTolerance: number,
  minFrames: number,
): Run[] {
  const runs: Run[] = [];
  let start = -1;
  let pendingEnd = -1;
  let gap = 0;
  const flush = (end: number): void => {
    if (start >= 0 && end - start + 1 >= minFrames) {
      runs.push({ start, end });
    }
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

function average(frames: FrameMetric[], pick: (frame: FrameMetric) => number): number {
  if (frames.length === 0) return 0;
  let sum = 0;
  for (const frame of frames) sum += pick(frame);
  return sum / frames.length;
}

function toSegment(
  run: Run,
  frames: FrameMetric[],
  fps: number,
  kind: Segment['kind'],
  severity: number,
  evidence: Record<string, number>,
): Segment {
  const startFrame = frames[run.start].index;
  const endFrame = frames[run.end].index;
  const startPts = frames[run.start].pts;
  const endPts = frames[run.end].pts;
  return {
    kind,
    startFrame,
    endFrame,
    startPts,
    endPts,
    startTc: frameToTimecode(startFrame, fps),
    endTc: frameToTimecode(endFrame + 1, fps),
    durationSec: Math.max(0, endPts - startPts) + 1 / fps,
    severity: clamp01(severity),
    evidence,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function detectBlack(
  frames: FrameMetric[],
  fps: number,
  config: DetectorConfig = DEFAULT_CONFIG,
): Segment[] {
  const flags = frames.map(
    (frame) => frame.blackRatio >= config.black.frameBlackRatio,
  );
  const minFrames = Math.max(1, Math.round(config.black.minDurationSec * fps));
  return runsFromFlags(flags, config.black.gapToleranceFrames, minFrames).map((run) => {
    const slice = frames.slice(run.start, run.end + 1);
    const meanLuma = average(slice, (frame) => frame.meanLuma);
    const blackRatio = average(slice, (frame) => frame.blackRatio);
    return toSegment(run, frames, fps, 'black', blackRatio, {
      meanLuma,
      blackRatio,
    });
  });
}

export function detectFreeze(
  frames: FrameMetric[],
  fps: number,
  config: DetectorConfig = DEFAULT_CONFIG,
  exclude: ReadonlySet<number> = new Set(),
): Segment[] {
  const flags = frames.map(
    (frame) =>
      !exclude.has(frame.index) &&
      frame.index > 0 &&
      frame.diff <= config.freeze.diffThreshold &&
      frame.motion <= config.freeze.motionThreshold,
  );
  const minFrames = Math.max(1, Math.round(config.freeze.minDurationSec * fps));
  return runsFromFlags(flags, config.freeze.gapToleranceFrames, minFrames).map((run) => {
    const slice = frames.slice(run.start, run.end + 1);
    const diff = average(slice, (frame) => frame.diff);
    const motion = average(slice, (frame) => frame.motion);
    const severity = clamp01(
      1 - (diff + motion) / (config.freeze.diffThreshold + config.freeze.motionThreshold),
    );
    return toSegment(run, frames, fps, 'freeze', severity, { diff, motion });
  });
}

export function detectShake(
  frames: FrameMetric[],
  fps: number,
  config: DetectorConfig = DEFAULT_CONFIG,
): Segment[] {
  const hit = frames.map(
    (frame) =>
      frame.motion >= config.shake.motionThreshold &&
      frame.motionDisorder >= config.shake.disorderThreshold,
  );
  const window = config.shake.windowFrames;
  const windowFlags: boolean[] = frames.map((_, index) => {
    const from = Math.max(0, index - window + 1);
    let hits = 0;
    let count = 0;
    for (let j = from; j <= index; j += 1) {
      count += 1;
      if (hit[j]) hits += 1;
    }
    return hits / count >= config.shake.windowHitRatio;
  });
  const minFrames = Math.max(1, Math.round(config.shake.minDurationSec * fps));
  return runsFromFlags(windowFlags, 0, minFrames).map((run) => {
    const slice = frames.slice(run.start, run.end + 1);
    const motion = average(slice, (frame) => frame.motion);
    const disorder = average(slice, (frame) => frame.motionDisorder);
    const severity = clamp01(
      (disorder / config.shake.disorderThreshold) * 0.6 +
        Math.min(1, motion / (config.shake.motionThreshold * 3)) * 0.4,
    );
    return toSegment(run, frames, fps, 'shake', severity, { motion, disorder });
  });
}

export interface Cut {
  frame: number;
  hard: boolean;
  score: number;
}

/** 镜头边界：硬切看单帧差，软切（叠化）看窗口均值。 */
export function detectCuts(
  frames: FrameMetric[],
  config: DetectorConfig = DEFAULT_CONFIG,
  guardRuns: Run[] = [],
  blackRuns: Run[] = [],
): Cut[] {
  const cuts: Cut[] = [];
  const dissolveWindow = config.shot.dissolveWindowFrames;
  for (let i = 1; i < frames.length; i += 1) {
    // 仅屏蔽抖动区间内部帧；区间边界上的真实硬切必须保留。
    if (inAnyRun(i, guardRuns) && inAnyRun(i - 1, guardRuns)) continue;
    const frame = frames[i];
    // 黑场中的闪白/恢复帧不是镜头切换：相邻帧落在黑场区间则跳过。
    if (inAnyRun(i, blackRuns) || inAnyRun(i - 1, blackRuns)) continue;
    // 高方向无序是抖动而非切换；正常硬切前后块运动方向基本一致。
    if (frame.motionDisorder >= config.shake.disorderThreshold) continue;
    // 真硬切：大面积像素变化但可匹配的块运动很少；平移/抖动残余则运动占比高。
    const coherentHardCut =
      frame.diff >= config.shot.hardCutDiff &&
      frame.motion <= frame.diff * 1.25;
    if (coherentHardCut) {
      cuts.push({ frame: i, hard: true, score: frame.diff });
      continue;
    }
    const from = Math.max(1, i - dissolveWindow + 1);
    let sum = 0;
    for (let j = from; j <= i; j += 1) sum += frames[j].diff;
    const avg = sum / (i - from + 1);
    // 叠化是渐变过程：窗口内 diff 应呈「先升后降」的拱形，
    // 持续平移/抖动只有高均值却没有拱形，借此排除误判。
    const mid = (from + i) >> 1;
    const rising = frames[mid].diff - frames[from].diff;
    const falling = frames[mid].diff - frames[i].diff;
    const arched =
      rising >= config.shot.dissolveAvgDiff * 0.25 &&
      falling >= config.shot.dissolveAvgDiff * 0.25;
    if (
      avg >= config.shot.dissolveAvgDiff &&
      frame.diff > config.freeze.diffThreshold &&
      arched &&
      frame.motionDisorder < config.shake.disorderThreshold
    ) {
      cuts.push({ frame: i, hard: false, score: avg });
    }
  }
  const deduped: Cut[] = [];
  for (const cut of cuts) {
    const last = deduped[deduped.length - 1];
    if (last && cut.frame - last.frame < dissolveWindow) {
      if (cut.score > last.score) deduped[deduped.length - 1] = cut;
    } else {
      deduped.push(cut);
    }
  }
  return deduped;
}

function inAnyRun(index: number, runs: Run[]): boolean {
  return runs.some((run) => index >= run.start && index <= run.end);
}

/** 把检测到的区间映射回帧号集合，供交叉信号去重使用。 */
export function segmentFrameSet(segments: Segment[], frames: FrameMetric[]): Set<number> {
  const set = new Set<number>();
  for (const segment of segments) {
    const start = indexOfFrame(frames, segment.startFrame);
    const end = indexOfFrame(frames, segment.endFrame);
    for (let i = start; i <= end; i += 1) set.add(frames[i].index);
  }
  return set;
}

function buildShotRuns(frameCount: number, cuts: Cut[], fps: number, config: DetectorConfig): Run[] {
  const boundaries = [0, ...cuts.map((cut) => cut.frame), frameCount];
  const raw: Run[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    raw.push({ start: boundaries[i], end: boundaries[i + 1] - 1 });
  }
  const minFrames = Math.round(config.shot.minShotDurationSec * fps);
  const merged: Run[] = [];
  for (const run of raw) {
    const prev = merged[merged.length - 1];
    if (prev && run.end - run.start + 1 < minFrames) {
      prev.end = run.end;
    } else if (prev && prev.end - prev.start + 1 < minFrames) {
      prev.end = run.end;
    } else {
      merged.push({ ...run });
    }
  }
  return merged.filter((run) => run.end >= run.start);
}

function overlaps(segment: Segment, run: Run, frames: FrameMetric[]): boolean {
  const startIndex = indexOfFrame(frames, segment.startFrame);
  const endIndex = indexOfFrame(frames, segment.endFrame);
  return startIndex <= run.end && endIndex >= run.start;
}

function indexOfFrame(frames: FrameMetric[], frameIndex: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].index === frameIndex) return mid;
    if (frames[mid].index < frameIndex) lo = mid + 1;
    else hi = mid - 1;
  }
  return lo;
}

export function analyzeBundle(
  bundle: MetricBundle,
  config: DetectorConfig = DEFAULT_CONFIG,
  now: Date = new Date(),
): AnalysisResult {
  const frames = bundle.frames;
  const fps = bundle.video.frameRate;
  const black = detectBlack(frames, fps, config);
  const blackFramesSet = segmentFrameSet(black, frames);
  const freeze = detectFreeze(frames, fps, config, blackFramesSet);
  const shake = detectShake(frames, fps, config);
  const toIndexRuns = (segments: Segment[]): Run[] =>
    segments.map((segment) => ({
      start: indexOfFrame(frames, segment.startFrame),
      end: indexOfFrame(frames, segment.endFrame),
    }));
  const shakeFrameIndexes = shake.map((segment) => ({
    start: indexOfFrame(frames, segment.startFrame),
    end: indexOfFrame(frames, segment.endFrame),
  }));
  const cuts = detectCuts(frames, config, shakeFrameIndexes, toIndexRuns(black));
  const shotRuns = buildShotRuns(frames.length, cuts, fps, config);

  const shots: ShotSegment[] = shotRuns.map((run, position) => {
    const base = toSegment(run, frames, fps, 'shot', 0, {
      cuts: 0,
    }) as ShotSegment;
    base.shotId = position + 1;
    const flags = new Set<string>();
    for (const segment of [...black, ...freeze, ...shake]) {
      if (overlaps(segment, run, frames)) flags.add(segment.kind);
    }
    base.flags = [...flags].sort();
    const key = `${bundle.file.sha256}:${base.startFrame}`;
    base.assignee = config.assignees[fnv1a(key) % config.assignees.length];
    base.evidence = {
      cuts: cuts.filter((cut) => cut.frame > run.start && cut.frame <= run.end).length,
    };
    return base;
  });

  const labels = buildLabels(bundle, black, freeze, shake, config);
  return {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    sha256: bundle.file.sha256,
    fileName: bundle.file.name,
    frameRate: fps,
    frameCount: bundle.video.frameCount,
    durationSec: bundle.video.durationSec,
    labels,
    black,
    freeze,
    shake,
    shots,
    configHash: configHash(config),
    analyzedAt: now.toISOString(),
  };
}

function buildLabels(
  bundle: MetricBundle,
  black: Segment[],
  freeze: Segment[],
  shake: Segment[],
  config: DetectorConfig,
): FileLabel[] {
  const duration = Math.max(1e-6, bundle.video.durationSec);
  const make = (
    label: FileLabel['label'],
    segments: Segment[],
  ): FileLabel | null => {
    if (segments.length === 0) return null;
    const covered = segments.reduce((sum, segment) => sum + segment.durationSec, 0);
    const coverage = clamp01(covered / duration);
    const severity: FileLabel['severity'] =
      coverage >= config.labelCoverage.high
        ? 'high'
        : coverage >= config.labelCoverage.medium
          ? 'medium'
          : 'low';
    return { label, severity, coverage, occurrences: segments.length };
  };
  return [make('black', black), make('still', freeze), make('shaky', shake)].filter(
    (item): item is FileLabel => item !== null,
  );
}
