/**
 * worker_threads 入口：在独立线程里跑单个任务。
 * 每个 chunk 处理完检查一次 pause/cancel 信号，
 * 保证暂停/取消永远发生在 chunk 边界——临时文件始终处于一致状态。
 */
import { parentPort } from "node:worker_threads";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TaskCheckpoint, TaskRecord } from "../../shared/protocol.ts";
import { TaskAbortedError } from "./executor.ts";

if (!parentPort) throw new Error("jobWorker 必须在 worker_threads 中运行");
const port = parentPort;

let pauseRequested = false;
let cancelRequested = false;
port.on("message", (message: { type: string }) => {
  if (message.type === "pause") pauseRequested = true;
  if (message.type === "cancel") cancelRequested = true;
});

interface StartMessage {
  type: "start";
  task: TaskRecord;
  stagingDir: string;
  dataRoot: string;
}

interface CheckpointMessage {
  type: "checkpoint";
  checkpoint: TaskCheckpoint;
  progress: number;
  residentMB: number;
}

function residentMB(): number {
  return process.memoryUsage.rss() / 1024 / 1024;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function checkSignals(): Promise<void> {
  if (cancelRequested) throw new TaskAbortedError("任务已取消", true);
  if (pauseRequested) throw new TaskAbortedError("收到暂停信号，在检查点安全暂停", false);
}

async function emitCheckpoint(
  task: TaskRecord,
  chunk: number,
  segments: string[],
  progress: number,
  extra?: Record<string, unknown>,
): Promise<TaskCheckpoint> {
  const checkpoint: TaskCheckpoint = {
    chunk,
    segments,
    extra,
    savedAt: Date.now(),
  };
  const message: CheckpointMessage = {
    type: "checkpoint",
    checkpoint,
    progress,
    residentMB: residentMB(),
  };
  port.postMessage(message);
  await sleep(0);
  return checkpoint;
}

function resolveUnder(dataRoot: string, candidate: string): string {
  const resolved = candidate.startsWith("/")
    ? resolve(candidate)
    : resolve(join(dataRoot, candidate));
  const root = resolve(dataRoot);
  if (resolved !== root && !resolved.startsWith(root + "/")) {
    throw new Error(`路径越界，拒绝访问 data 目录之外: ${candidate}`);
  }
  return resolved;
}

/** 模拟 CPU 忙碌：分段 sleep 以便快速响应取消 */
async function busyWork(totalMs: number): Promise<void> {
  const step = 25;
  let elapsed = 0;
  while (elapsed < totalMs) {
    await checkSignals();
    const slice = Math.min(step, totalMs - elapsed);
    const deadline = performance.now() + slice;
    while (performance.now() < deadline) {
      // 紧凑自旋模拟真实转码的 CPU 占用
    }
    elapsed += slice;
  }
}

/** upload：固定块大小、可断点续传的流式拷贝 */
async function runUpload(task: TaskRecord, stagingDir: string, dataRoot: string): Promise<TaskCheckpoint> {
  const payload = task.payload;
  if (!payload.sourcePath || !payload.outputPath) throw new Error("upload 缺少 sourcePath/outputPath");
  const source = resolveUnder(dataRoot, payload.sourcePath);
  const partFile = join(stagingDir, `${task.id}.part`);
  const chunkBytes = 4 * 1024 * 1024;
  const chunks = payload.chunks ?? 8;

  const srcHandle = await open(source, "r");
  const info = await srcHandle.stat();
  const dstHandle = await open(partFile, "a");
  let chunk = task.checkpoint?.chunk ?? 0;
  try {
    while (chunk < chunks) {
      await checkSignals();
      const start = chunk * chunkBytes;
      if (start >= info.size) break;
      const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, info.size - start));
      const readResult = await srcHandle.read(buffer, 0, buffer.length, start);
      if (readResult.bytesRead === 0) break;
      await dstHandle.write(buffer.subarray(0, readResult.bytesRead), 0, readResult.bytesRead, start);
      await dstHandle.sync();
      chunk += 1;
      await emitCheckpoint(task, chunk, [`${task.id}.part`], chunk / chunks, { bytes: start + readResult.bytesRead });
    }
  } finally {
    await srcHandle.close();
    await dstHandle.close();
  }
  return emitCheckpoint(task, chunk, [`${task.id}.part`], 1);
}

/** proxy：生成代理文件（低质量预览），每块一段，落盘后报检查点 */
async function runChunkedEncode(task: TaskRecord, stagingDir: string): Promise<TaskCheckpoint> {
  const chunks = task.payload.chunks ?? 10;
  const workMs = task.payload.chunkWorkMs ?? 120;
  const segments = task.checkpoint?.segments ?? [];
  let chunk = task.checkpoint?.chunk ?? 0;
  while (chunk < chunks) {
    await checkSignals();
    await busyWork(workMs);
    const segmentName = `${task.id}.seg-${String(chunk).padStart(5, "0")}`;
    const segmentPath = join(stagingDir, segmentName);
    const block = Buffer.alloc(256 * 1024, chunk & 0xff);
    const handle = await open(segmentPath, "w");
    try {
      await handle.write(block);
      await handle.sync();
    } finally {
      await handle.close();
    }
    segments.push(segmentName);
    chunk += 1;
    await emitCheckpoint(task, chunk, [...segments], chunk / chunks);
  }
  return emitCheckpoint(task, chunk, [...segments], 1);
}

/** output：在代理分段基础上做“成片”，同样逐段产出并 fsync */
async function runOutput(task: TaskRecord, stagingDir: string): Promise<TaskCheckpoint> {
  const chunks = task.payload.chunks ?? 12;
  const workMs = task.payload.chunkWorkMs ?? 180;
  const segments = task.checkpoint?.segments ?? [];
  let chunk = task.checkpoint?.chunk ?? 0;
  while (chunk < chunks) {
    await checkSignals();
    await busyWork(workMs);
    const segmentName = `${task.id}.final-${String(chunk).padStart(5, "0")}`;
    const segmentPath = join(stagingDir, segmentName);
    const block = Buffer.alloc(512 * 1024, (chunk * 7) & 0xff);
    const handle = await open(segmentPath, "w");
    try {
      await handle.write(block);
      await handle.sync();
    } finally {
      await handle.close();
    }
    segments.push(segmentName);
    chunk += 1;
    await emitCheckpoint(task, chunk, [...segments], chunk / chunks);
  }
  return emitCheckpoint(task, chunk, [...segments], 1);
}

async function main(): Promise<void> {
  const startMessage = await new Promise<StartMessage>((resolvePromise) =>
    port.once("message", resolvePromise),
  );
  if (startMessage.type !== "start") throw new Error("worker 首条消息必须是 start");
  const { task, stagingDir, dataRoot } = startMessage;
  let checkpoint: TaskCheckpoint;
  try {
    if (task.kind === "upload") {
      checkpoint = await runUpload(task, stagingDir, dataRoot);
    } else if (task.kind === "proxy") {
      checkpoint = await runChunkedEncode(task, stagingDir);
    } else {
      checkpoint = await runOutput(task, stagingDir);
    }
    port.postMessage({ type: "done", checkpoint });
  } catch (err) {
    const aborted = err instanceof TaskAbortedError;
    port.postMessage({
      type: aborted ? (err.cancelled ? "cancelled" : "paused") : "error",
      message: (err as Error).message,
    });
  }
}

main().catch((err) => {
  port.postMessage({ type: "error", message: (err as Error).message });
});
