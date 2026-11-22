/**
 * 离线演示：不启动 HTTP，直接在进程内复现
 * “一个大任务占满资源 + 小任务排队 + 压力暂停 + 断点恢复”的完整过程。
 * 运行：npm run demo
 */
import { Scheduler } from "./scheduler.ts";
import type { QuotaConfig, TaskSpec } from "../shared/protocol.ts";
import { writeFileAtomic, ensureDir } from "./util/atomic.ts";
import { join } from "node:path";

const quota: QuotaConfig = {
  maxCpuCores: 6,
  maxMemoryMB: 1024,
  maxTmpMB: 512,
  maxConcurrent: 4,
  memoryPressureRatio: 0.9,
  tmpPressureRatio: 0.92,
  cpuPressureRatio: 0.95,
};

function task(overrides: Partial<TaskSpec>): Omit<TaskSpec, "id" | "createdAt"> {
  return {
    name: "demo",
    kind: "proxy",
    priority: 5,
    cpu: 1,
    memoryMB: 128,
    tmpMB: 64,
    maxRetries: 1,
    payload: { chunks: 12, chunkWorkMs: 120 },
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const scheduler = new Scheduler(quota);
await scheduler.start();
await ensureDir(join(process.cwd(), "data", "files"));
await writeFileAtomic(
  join(process.cwd(), "data", "files", "demo-source.bin"),
  Buffer.alloc(8 * 1024 * 1024, 0x5a),
);

console.log("== 1. 提交两个吃资源的大任务（各 4 核 / 700MB）==");
const big1 = scheduler.submit(
  task({
    name: "大任务-代理A",
    kind: "proxy",
    cpu: 4,
    memoryMB: 700,
    tmpMB: 300,
    priority: 4,
    payload: { chunks: 40, chunkWorkMs: 150, outputPath: "outputs/big1.dat" },
  }),
);
const big2 = scheduler.submit(
  task({
    name: "大任务-成片B",
    kind: "output",
    cpu: 4,
    memoryMB: 700,
    tmpMB: 300,
    priority: 3,
    payload: { chunks: 40, chunkWorkMs: 150, outputPath: "outputs/big2.dat" },
  }),
);

console.log("== 2. 提交一个高优先级小任务，观察它的等待原因 ==");
const small = scheduler.submit(
  task({
    name: "小任务-加急",
    kind: "upload",
    cpu: 1,
    memoryMB: 96,
    tmpMB: 32,
    priority: 9,
    payload: {
      chunks: 4,
      chunkWorkMs: 60,
      sourcePath: "files/demo-source.bin",
      outputPath: "outputs/small.dat",
    },
  }),
);

await sleep(1200);
for (const id of [big1.task!.id, big2.task!.id, small.task!.id]) {
  const current = scheduler.getTask(id)!;
  console.log(
    `  ${current.name.padEnd(14)} ${current.state.padEnd(8)} 等待=${current.waitReason} | ${current.reasonDetail}`,
  );
}

console.log("== 3. 手动暂停大任务1，验证检查点暂停 ==");
scheduler.pause(big1.task!.id);
await sleep(1500);
const paused = scheduler.getTask(big1.task!.id)!;
console.log(`  ${paused.name} -> ${paused.state}，检查点 chunk=${paused.checkpoint?.chunk ?? 0}`);

console.log("== 4. 恢复大任务1，全部跑完后输出终态 ==");
scheduler.resume(big1.task!.id);
const all = [big1.task!.id, big2.task!.id, small.task!.id];
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  if (all.every((id) => ["completed", "failed", "cancelled"].includes(scheduler.getTask(id)!.state))) {
    break;
  }
  await sleep(500);
}
for (const id of all) {
  const current = scheduler.getTask(id)!;
  console.log(
    `  ${current.name.padEnd(14)} ${current.state.padEnd(8)} 进度=${(current.progress * 100).toFixed(0)}% 尝试=${current.attempts}`,
  );
}
console.log("\n最近调度决策:");
for (const decision of scheduler.decisions().slice(-8)) {
  console.log(
    `  [${new Date(decision.at).toLocaleTimeString("zh-CN")}] ${decision.action} ${decision.reason} - ${decision.detail}`,
  );
}
await scheduler.stop();
process.exit(0);
