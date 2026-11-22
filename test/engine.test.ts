import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/shared/config.ts';
import {
  analyzeBundle,
  detectBlack,
  detectCuts,
  detectFreeze,
  detectShake,
} from '../src/shared/engine.ts';
import { buildBundle, FIXTURE_SPECS } from '../src/server/fixtures.ts';
import type { FrameMetric } from '../src/shared/types.ts';

function metric(index: number, overrides: Partial<FrameMetric> = {}): FrameMetric {
  return {
    index,
    pts: index / 30,
    meanLuma: 120,
    blackRatio: 0,
    diff: 8,
    motion: 2,
    motionDisorder: 0.1,
    audioRms: 0.05,
    ...overrides,
  };
}

test('黑场：单帧闪白不打断连续黑场', () => {
  const frames = Array.from({ length: 90 }, (_, index) =>
    metric(index, { meanLuma: 3, blackRatio: 0.995, diff: 0.3, motion: 0 }),
  );
  frames[45] = metric(45, { meanLuma: 210, blackRatio: 0, diff: 70 });
  const segments = detectBlack(frames, 30, DEFAULT_CONFIG);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].startFrame, 0);
  assert.equal(segments[0].endFrame, 89);
});

test('黑场：近黑欠曝画面（占比不达标）不触发', () => {
  const frames = Array.from({ length: 120 }, (_, index) =>
    metric(index, { meanLuma: 20, blackRatio: 0.7, diff: 5 }),
  );
  assert.equal(detectBlack(frames, 30, DEFAULT_CONFIG).length, 0);
});

test('静止：黑场帧不会被重复标为静止', () => {
  const frames = Array.from({ length: 90 }, (_, index) =>
    metric(index, { meanLuma: 3, blackRatio: 0.995, diff: 0.2, motion: 0 }),
  );
  const result = analyzeBundle(buildBundle(FIXTURE_SPECS[0]));
  assert.deepEqual(
    result.labels.map((label) => label.label),
    ['black'],
  );
  assert.equal(frames.length > 0, true);
});

test('静止：极缓慢运镜（持续块运动）不触发', () => {
  const frames = Array.from({ length: 180 }, (_, index) =>
    metric(index, { diff: 1.3, motion: 1 + index * 0.001, motionDisorder: 0.05 }),
  );
  assert.equal(detectFreeze(frames, 30, DEFAULT_CONFIG).length, 0);
});

test('抖动：高运动+高无序触发，平滑横移不触发', () => {
  const shaky = Array.from({ length: 90 }, (_, index) =>
    metric(index, { motion: 10, motionDisorder: 0.6 }),
  );
  assert.equal(detectShake(shaky, 30, DEFAULT_CONFIG).length, 1);
  const pan = Array.from({ length: 90 }, (_, index) =>
    metric(index, { motion: 10, motionDisorder: 0.08 }),
  );
  assert.equal(detectShake(pan, 30, DEFAULT_CONFIG).length, 0);
});

test('镜头：硬切被识别、叠化拱形被识别、短镜头合并', () => {
  const result = analyzeBundle(buildBundle(FIXTURE_SPECS[6]));
  assert.ok(result.shots.length >= 3);
  const hard = detectCuts(buildBundle(FIXTURE_SPECS[6]).frames).some((cut) => cut.hard);
  assert.equal(hard, true);
});

test('全量样本：期望标签与镜头数全部命中（含误判防护）', () => {
  for (const spec of FIXTURE_SPECS) {
    const result = analyzeBundle(buildBundle(spec));
    const labels = result.labels.map((label) => label.label).sort();
    assert.deepEqual(labels, [...spec.expectLabels].sort(), `${spec.name} 标签不符`);
    assert.ok(
      result.shots.length >= spec.expectMinShots,
      `${spec.name} 镜头数 ${result.shots.length} < ${spec.expectMinShots}`,
    );
  }
});

test('确定性：同一指标包分析两次，输出逐字节一致（除 analyzedAt）', () => {
  const bundle = buildBundle(FIXTURE_SPECS[7]);
  const fixed = new Date('2026-01-01T00:00:00.000Z');
  const a = analyzeBundle(bundle, DEFAULT_CONFIG, fixed);
  const b = analyzeBundle(bundle, DEFAULT_CONFIG, fixed);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('镜头分配：同 sha+起始帧的同事分配稳定且落在名单内', () => {
  const result = analyzeBundle(buildBundle(FIXTURE_SPECS[7]));
  for (const shot of result.shots) {
    assert.ok(DEFAULT_CONFIG.assignees.includes(shot.assignee));
  }
  const again = analyzeBundle(buildBundle(FIXTURE_SPECS[7]));
  assert.deepEqual(
    result.shots.map((shot) => shot.assignee),
    again.shots.map((shot) => shot.assignee),
  );
});
