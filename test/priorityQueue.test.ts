import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PriorityTaskQueue } from "../src/server/priorityQueue.ts";
import type { TaskRecord } from "../src/shared/protocol.ts";

function makeTask(id: string, priority: number, createdAt: number): TaskRecord {
  return {
    id,
    name: id,
    kind: "proxy",
    priority,
    cpu: 1,
    memoryMB: 64,
    tmpMB: 32,
    maxRetries: 0,
    payload: {},
    createdAt,
    state: "queued",
    waitReason: "none",
    reasonDetail: "",
    attempts: 0,
    progress: 0,
    checkpoint: null,
    pauseSource: null,
    lastError: null,
    leasedBy: null,
    leaseExpiresAt: null,
    notBefore: createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
  };
}

describe("PriorityTaskQueue", () => {
  it("按显式优先级排序", () => {
    const queue = new PriorityTaskQueue();
    queue.add(makeTask("low", 1, 1000));
    queue.add(makeTask("high", 9, 1000));
    queue.add(makeTask("mid", 5, 1000));
    const ordered = queue.ordered(2000).map((task) => task.id);
    assert.deepEqual(ordered, ["high", "mid", "low"]);
  });

  it("老化机制让等待很久的低优先级任务反超", () => {
    const queue = new PriorityTaskQueue();
    const now = 100_000;
    queue.add(makeTask("old-low", 1, 0)); // 等了 100s，等效优先级 +25
    queue.add(makeTask("new-high", 5, now - 1000));
    const peeked = queue.peek(now);
    assert.equal(peeked?.id, "old-low");
  });

  it("同优先级时先创建的排前面（FIFO）", () => {
    const queue = new PriorityTaskQueue();
    queue.add(makeTask("a", 3, 100));
    queue.add(makeTask("b", 3, 200));
    assert.equal(queue.peek(1000)?.id, "a");
  });

  it("remove 后不再参与排序", () => {
    const queue = new PriorityTaskQueue();
    queue.add(makeTask("a", 1, 1));
    queue.add(makeTask("b", 9, 1));
    queue.remove("b");
    assert.equal(queue.size(), 1);
    assert.equal(queue.peek(10)?.id, "a");
  });
});
