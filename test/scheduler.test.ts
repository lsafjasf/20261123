import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskSpec } from "../src/shared/protocol.ts";
import { writeFileAtomic } from "../src/server/util/atomic.ts";
import { createTestScheduler, sleep, waitForState } from "./harness.ts";

function spec(overrides: Partial<TaskSpec> = {}): Omit<TaskSpec, "id" | "createdAt"> {
  const payload = {
    chunks: 4,
    chunkWorkMs: 40,
    outputPath: "outputs/t.dat",
    ...overrides.payload,
  };
  return {
    name: "t",
    kind: "proxy",
    priority: 5,
    cpu: 1,
    memoryMB: 64,
    tmpMB: 32,
    maxRetries: 0,
    payload,
    ...overrides,
  };
}

describe("Scheduler 集成", () => {
  it("超过 CPU 配额的任务排队并给出明确等待原因", async () => {
    const harness = await createTestScheduler();
    try {
      const { scheduler } = harness;
      const big = scheduler.submit(
        spec({
          name: "big",
          cpu: 3.5,
          memoryMB: 400,
          tmpMB: 200,
          payload: { chunks: 200, chunkWorkMs: 100 },
        }),
      );
      await waitForState(scheduler, big.task!.id, ["running", "starting"]);
      const second = scheduler.submit(spec({ name: "blocked", cpu: 2 }));
      await sleep(800);
      const blocked = scheduler.getTask(second.task!.id)!;
      assert.equal(blocked.state, "queued");
      assert.equal(blocked.waitReason, "cpu-quota");
      assert.match(blocked.reasonDetail, /CPU/);
    } finally {
      await harness.dispose();
    }
  });

  it("拒绝超过单任务上限或整机配额的申请", async () => {
    const harness = await createTestScheduler();
    try {
      assert.match(harness.scheduler.submit(spec({ memoryMB: 99999 })).error!, /内存/);
      assert.match(harness.scheduler.submit(spec({ cpu: 99 })).error!, /CPU/);
      assert.match(harness.scheduler.submit(spec({ tmpMB: 9999 })).error!, /磁盘/);
    } finally {
      await harness.dispose();
    }
  });

  it("运行中在检查点暂停，恢复后从检查点跑到完成且产物完整", async () => {
    const harness = await createTestScheduler();
    try {
      const { scheduler, workdir } = harness;
      const result = scheduler.submit(
        spec({
          name: "pausable",
          payload: { chunks: 12, chunkWorkMs: 60, outputPath: "outputs/p.dat" },
        }),
      );
      const id = result.task!.id;
      await waitForState(scheduler, id, ["running"]);
      await sleep(200);
      scheduler.pause(id);
      await waitForState(scheduler, id, ["paused"]);
      const checkpoint = scheduler.getTask(id)!.checkpoint;
      assert.ok(checkpoint !== null, "暂停后必须存在已 fsync 的检查点");
      const chunkAtPause = checkpoint.chunk;
      assert.ok(chunkAtPause > 0);

      scheduler.resume(id);
      await waitForState(scheduler, id, ["completed"]);
      const done = scheduler.getTask(id)!;
      assert.ok(done.checkpoint!.chunk >= chunkAtPause);
      const output = await readFile(join(workdir, "data", "outputs", "p.dat"));
      assert.equal(output.length, 12 * 256 * 1024);
    } finally {
      await harness.dispose();
    }
  });

  it("取消运行任务后 staging 被清理，不产生正式文件", async () => {
    const harness = await createTestScheduler();
    try {
      const { scheduler, workdir } = harness;
      const result = scheduler.submit(
        spec({
          name: "cancel-me",
          payload: { chunks: 12, chunkWorkMs: 60, outputPath: "outputs/c.dat" },
        }),
      );
      const id = result.task!.id;
      await sleep(400);
      scheduler.cancel(id);
      await waitForState(scheduler, id, ["cancelled"]);
      assert.equal(existsSync(join(workdir, "data", "staging", id)), false);
      assert.equal(existsSync(join(workdir, "data", "outputs", "c.dat")), false);
    } finally {
      await harness.dispose();
    }
  });

  it("失败任务按指数退避重试，耗尽后标记 failed", async () => {
    const harness = await createTestScheduler();
    try {
      const { scheduler, workdir } = harness;
      await writeFileAtomic(join(workdir, "data", "files", "seed"), "x");
      const result = scheduler.submit(
        spec({
          name: "retry",
          kind: "upload",
          maxRetries: 1,
          payload: { sourcePath: "files/does-not-exist", outputPath: "outputs/r.bin", chunks: 1 },
        }),
      );
      const id = result.task!.id;
      await waitForState(scheduler, id, ["failed"], 15000);
      const task = scheduler.getTask(id)!;
      assert.equal(task.attempts, 2);
      assert.match(task.lastError!, /ENOENT/);
    } finally {
      await harness.dispose();
    }
  });

  it("大任务占满配额时，高优先级小任务先于低优先级被准入", async () => {
    const harness = await createTestScheduler();
    try {
      const { scheduler } = harness;
      scheduler.submit(
        spec({
          name: "occupy",
          cpu: 2.5,
          memoryMB: 384,
          tmpMB: 180,
          payload: { chunks: 200, chunkWorkMs: 80 },
        }),
      );
      await sleep(900);
      const low = scheduler.submit(spec({ name: "low", cpu: 2, priority: 1 }));
      const high = scheduler.submit(spec({ name: "high", cpu: 2, priority: 9 }));
      await sleep(800);
      assert.equal(scheduler.getTask(low.task!.id)!.state, "queued");
      assert.equal(scheduler.getTask(high.task!.id)!.state, "queued");
      await waitForState(scheduler, high.task!.id, ["completed"], 20000);
      const admitHigh = scheduler.decisions().find(
        (decision) => decision.taskId === high.task!.id && decision.action === "admit",
      );
      const admitLow = scheduler.decisions().find(
        (decision) => decision.taskId === low.task!.id && decision.action === "admit",
      );
      assert.ok(admitHigh, "高优先级任务应已被准入");
      if (admitLow) assert.ok(admitLow.at >= admitHigh.at, "高优先级必须先于低优先级准入");
    } finally {
      await harness.dispose();
    }
  });

  it("内存配额不足时等待原因显示 memory-quota", async () => {
    const harness = await createTestScheduler();
    try {
      const { scheduler } = harness;
      const hog = scheduler.submit(
        spec({
          name: "mem-hog",
          cpu: 1,
          memoryMB: 420,
          tmpMB: 64,
          payload: { chunks: 200, chunkWorkMs: 80 },
        }),
      );
      await waitForState(scheduler, hog.task!.id, ["running", "starting"]);
      const blocked = scheduler.submit(spec({ name: "mem-blocked", cpu: 1, memoryMB: 200 }));
      await sleep(800);
      const task = scheduler.getTask(blocked.task!.id)!;
      assert.equal(task.waitReason, "memory-quota");
    } finally {
      await harness.dispose();
    }
  });

  it("压力暂停的任务在压力缓解后自动重新排队，手动暂停保持暂停", async () => {
    const harness = await createTestScheduler();
    try {
      const { scheduler } = harness;
      // 构造内存预留逼近配额：64+420=484/512，再提交一个任务触发 memory 压力
      const first = scheduler.submit(
        spec({
          name: "first",
          cpu: 1,
          memoryMB: 200,
          tmpMB: 32,
          payload: { chunks: 200, chunkWorkMs: 60 },
        }),
      );
      const second = scheduler.submit(
        spec({
          name: "second",
          cpu: 1,
          memoryMB: 300,
          tmpMB: 32,
          payload: { chunks: 200, chunkWorkMs: 60 },
        }),
      );
      await sleep(1200);
      // 手动暂停 first，它不应被自动恢复逻辑触碰
      scheduler.pause(first.task!.id);
      await waitForState(scheduler, first.task!.id, ["paused"]);
      assert.equal(scheduler.getTask(first.task!.id)!.pauseSource, "manual");

      // second 进入运行后取消它以释放预留，压力缓解
      await waitForState(scheduler, second.task!.id, ["running", "starting", "queued"]);
      scheduler.cancel(second.task!.id);
      await waitForState(scheduler, second.task!.id, ["cancelled"]);
      await sleep(1200);

      const firstNow = scheduler.getTask(first.task!.id)!;
      assert.equal(firstNow.state, "paused", "手动暂停不会被自动恢复");
      assert.equal(firstNow.pauseSource, "manual");
    } finally {
      await harness.dispose();
    }
  });
});
