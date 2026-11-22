import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuotaConfig } from "../src/shared/protocol.ts";
import { Scheduler } from "../src/server/scheduler.ts";

export const testQuota: QuotaConfig = {
  maxCpuCores: 4,
  maxMemoryMB: 512,
  maxTmpMB: 256,
  maxConcurrent: 3,
  memoryPressureRatio: 2,
  tmpPressureRatio: 2,
  cpuPressureRatio: 2,
};

export async function createTestScheduler(): Promise<{
  scheduler: Scheduler;
  workdir: string;
  dispose: () => Promise<void>;
}> {
  const workdir = await mkdtemp(join(tmpdir(), "scheduler-it-"));
  const previousCwd = process.cwd();
  process.chdir(workdir);
  const scheduler = new Scheduler(testQuota);
  await scheduler.start();
  return {
    scheduler,
    workdir,
    dispose: async () => {
      await scheduler.stop();
      process.chdir(previousCwd);
      const { safeRm } = await import("../src/server/util/atomic.ts");
      await safeRm(workdir);
    },
  };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export async function waitForState(
  scheduler: Scheduler,
  taskId: string,
  states: string[],
  timeoutMs = 12000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (states.includes(scheduler.getTask(taskId)!.state)) return;
    await sleep(150);
  }
  throw new Error(
    `任务 ${taskId} 未在 ${timeoutMs}ms 内进入 ${states.join("/")}，实际 ${scheduler.getTask(taskId)!.state}`,
  );
}
