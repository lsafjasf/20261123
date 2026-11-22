import { test } from "node:test";
import assert from "node:assert/strict";
import { ColorTimeline } from "../src/core/timeline.ts";
import type { ColorNode } from "../src/core/types.ts";

function node(id: string, time: number, lutId: string | null, intensity: number): ColorNode {
  return { id, time, lutId, intensity };
}

test("空时间线返回 null", () => {
  assert.equal(new ColorTimeline().sampleAt(1), null);
});

test("节点按时间自动排序，区间外钳制到首尾节点", () => {
  const timeline = new ColorTimeline();
  timeline.addNode(node("b", 2, "L2", 1));
  timeline.addNode(node("a", 0, "L1", 0.5));
  const nodes = timeline.getNodes();
  assert.equal(nodes[0].id, "a");
  const before = timeline.sampleAt(-1);
  assert.equal(before?.fromLutId, "L1");
  const after = timeline.sampleAt(99);
  assert.equal(after?.fromLutId, "L2");
});

test("区间中点做平滑交叉：mix=0.5、强度线性插值", () => {
  const timeline = new ColorTimeline();
  timeline.addNode(node("a", 0, "L1", 0));
  timeline.addNode(node("b", 2, "L2", 1));
  const sample = timeline.sampleAt(1);
  assert.equal(sample?.fromLutId, "L1");
  assert.equal(sample?.toLutId, "L2");
  assert.ok(Math.abs((sample?.mix ?? 0) - 0.5) < 1e-9);
  assert.ok(Math.abs((sample?.intensity ?? 0) - 0.5) < 1e-9);
});

test("smoothstep 在节点边界处导数为 0，过渡无折点", () => {
  const timeline = new ColorTimeline();
  timeline.addNode(node("a", 0, "L1", 1));
  timeline.addNode(node("b", 1, "L2", 1));
  assert.equal(timeline.sampleAt(0)?.mix, 0);
  assert.equal(timeline.sampleAt(1)?.mix, 0);
});

test("删除与更新节点生效", () => {
  const timeline = new ColorTimeline();
  timeline.addNode(node("a", 0, "L1", 1));
  timeline.updateNode("a", { intensity: 0.2 });
  assert.equal(timeline.getNodes()[0].intensity, 0.2);
  timeline.removeNode("a");
  assert.equal(timeline.getNodes().length, 0);
});
