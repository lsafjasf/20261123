import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_OPTIONS,
  dragCut,
  naturalBoundary,
  planCuts,
  resetCut,
} from "../src/core/planner.ts";
import type { Beat, Clip } from "../src/core/types.ts";

function makeClips(): Clip[] {
  const durations = [4, 3, 5, 3.5, 5, 4, 4.5, 4];
  const weights: Clip["weight"][] = [
    "strong", "normal", "strong", "weak",
    "strong", "normal", "weak", "normal",
  ];
  let start = 0;
  return durations.map((duration, i) => {
    const clip: Clip = {
      id: `c${i + 1}`,
      name: `片段${i + 1}`,
      start,
      duration,
      weight: weights[i],
      source: { sourceId: `s${i + 1}`, inPoint: 0 },
    };
    start += duration;
    return clip;
  });
}

function makeBeats(period: number, duration: number): Beat[] {
  const beats: Beat[] = [];
  let index = 0;
  for (let t = 0; t <= duration; t += period, index++) {
    beats.push({ time: Number(t.toFixed(3)), strength: 0.6, downbeat: index % 4 === 0 });
  }
  return beats;
}

test("planCuts 保持首尾边界与片段数量", () => {
  const clips = makeClips();
  const beats = makeBeats(0.5, 40);
  const { cuts } = planCuts(clips, beats, DEFAULT_OPTIONS);
  assert.equal(cuts.length, clips.length + 1);
  assert.equal(cuts[0].time, clips[0].start);
  const end = naturalBoundary(clips, clips.length);
  assert.equal(cuts[cuts.length - 1].time, end);
});

test("planCuts 切点向节拍靠拢且不违反最短停留", () => {
  const clips = makeClips();
  const beats = makeBeats(0.5, 40);
  const options = { ...DEFAULT_OPTIONS, defaultMinDuration: 2 };
  const { cuts } = planCuts(clips, beats, options);
  for (let i = 1; i < cuts.length; i++) {
    const gap = cuts[i].time - cuts[i - 1].time;
    assert.ok(gap >= 2 - 1e-6, `片段停留 ${gap} 短于 2s`);
  }
  const snapped = cuts.filter((c) => c.beatTime !== null).length;
  assert.ok(snapped >= 4, `应有多个切点吸附节拍，实际 ${snapped}`);
});

test("不是每个节拍都产生切点", () => {
  const clips = makeClips();
  const beats = makeBeats(0.5, 40);
  const { cuts } = planCuts(clips, beats, DEFAULT_OPTIONS);
  assert.ok(cuts.length < beats.length);
});

test("dragCut 只移动目标切点，其他切点完全不变", () => {
  const clips = makeClips();
  const beats = makeBeats(0.5, 40);
  const { cuts } = planCuts(clips, beats, DEFAULT_OPTIONS);
  const beforeSnapshots = cuts.map((c) => ({ id: c.id, time: c.time }));
  const target = cuts[3];
  const next = dragCut(cuts, target.id, target.time + 0.9, clips, beats, DEFAULT_OPTIONS);

  for (const snapshot of beforeSnapshots) {
    if (snapshot.id === target.id) continue;
    const moved = next.find((c) => c.id === snapshot.id)!;
    assert.equal(moved.time, snapshot.time, `切点 ${snapshot.id} 被意外联动`);
  }
  const movedTarget = next.find((c) => c.id === target.id)!;
  assert.equal(movedTarget.manual, true);
  assert.notEqual(movedTarget.time, target.time);
});

test("dragCut 受相邻片段最短停留约束", () => {
  const clips = makeClips();
  const beats = makeBeats(0.5, 40);
  const options = { ...DEFAULT_OPTIONS, defaultMinDuration: 2.5 };
  const { cuts } = planCuts(clips, beats, options);
  const target = cuts[2];
  const next = dragCut(cuts, target.id, target.time + 10, clips, beats, options);
  const moved = next.find((c) => c.id === target.id)!;
  const rightGap = next[3].time - moved.time;
  assert.ok(rightGap >= 2.5 - 1e-6);
});

test("重算规划时手动切点被保留", () => {
  const clips = makeClips();
  const beats = makeBeats(0.5, 40);
  const { cuts } = planCuts(clips, beats, DEFAULT_OPTIONS);
  const dragged = dragCut(cuts, cuts[2].id, cuts[2].time + 0.3, clips, beats, DEFAULT_OPTIONS);
  const manualTime = dragged[2].time;
  const replanned = planCuts(clips, makeBeats(0.48, 40), DEFAULT_OPTIONS, dragged);
  assert.equal(replanned.cuts[2].time, manualTime);
  assert.equal(replanned.cuts[2].manual, true);
});

test("resetCut 恢复建议时间并取消手动标记", () => {
  const clips = makeClips();
  const beats = makeBeats(0.5, 40);
  const { cuts } = planCuts(clips, beats, DEFAULT_OPTIONS);
  const dragged = dragCut(cuts, cuts[2].id, cuts[2].time + 0.5, clips, beats, DEFAULT_OPTIONS);
  const reset = resetCut(dragged, cuts[2].id, clips, DEFAULT_OPTIONS);
  const target = reset.find((c) => c.id === cuts[2].id)!;
  assert.equal(target.manual, false);
  assert.equal(target.time, target.suggestedTime);
});
