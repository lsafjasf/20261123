import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { TaskCheckpoint, TaskRecord } from "../../shared/protocol.ts";
import { STAGING_DIR } from "../config.ts";
import { ensureDir, safeRm } from "../util/atomic.ts";
import type { Executor, RunContext } from "./executor.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface ActiveJob {
  worker: Worker;
  resolve: (checkpoint: TaskCheckpoint) => void;
  reject: (err: Error) => void;
}

/**
 * 本地 worker_threads 执行器：每个任务一个线程，
 * 信号通过 postMessage 下发，检查点通过 message 上报。
 */
export class LocalExecutor implements Executor {
  readonly kind = "any";
  private active = new Map<string, ActiveJob>();

  private readonly maxSlots: number;

  constructor(maxSlots: number) {
    this.maxSlots = maxSlots;
  }

  availableSlots(): number {
    return Math.max(0, this.maxSlots - this.active.size);
  }

  supports(task: TaskRecord): boolean {
    return task.kind === "upload" || task.kind === "proxy" || task.kind === "output";
  }

  has(taskId: string): boolean {
    return this.active.has(taskId);
  }

  async run(context: RunContext): Promise<TaskCheckpoint> {
    const { task } = context;
    const taskStaging = join(STAGING_DIR, task.id);
    await ensureDir(taskStaging);
    const worker = new Worker(join(here, "jobWorker.ts"), {
      execArgv: ["--no-warnings"],
    });

    return await new Promise<TaskCheckpoint>((resolve, reject) => {
      const job: ActiveJob = { worker, resolve, reject };
      this.active.set(task.id, job);

      worker.on("message", (message: {
        type: string;
        checkpoint?: TaskCheckpoint;
        progress?: number;
        residentMB?: number;
        message?: string;
      }) => {
        if (message.type === "checkpoint" && message.checkpoint) {
          context.onCheckpoint(
            message.checkpoint,
            message.progress ?? 0,
            message.residentMB ?? 0,
          );
        } else if (message.type === "done" && message.checkpoint) {
          this.active.delete(task.id);
          worker.terminate().catch(() => undefined);
          resolve(message.checkpoint);
        } else if (message.type === "paused" || message.type === "cancelled") {
          this.active.delete(task.id);
          worker.terminate().catch(() => undefined);
          if (message.type === "paused") {
            context.onPaused(context.task.checkpoint ?? null);
          } else {
            context.onCancelled();
          }
          resolve(context.task.checkpoint ?? { chunk: 0, segments: [], savedAt: Date.now() });
        } else if (message.type === "error") {
          this.active.delete(task.id);
          worker.terminate().catch(() => undefined);
          reject(new Error(message.message ?? "worker 执行失败"));
        }
      });

      worker.on("error", (err) => {
        this.active.delete(task.id);
        reject(err);
      });

      worker.postMessage({
        type: "start",
        task: context.task,
        stagingDir: taskStaging,
        dataRoot: join(process.cwd(), "data"),
      });
    });
  }

  requestPause(taskId: string): void {
    this.active.get(taskId)?.worker.postMessage({ type: "pause" });
  }

  requestCancel(taskId: string): void {
    this.active.get(taskId)?.worker.postMessage({ type: "cancel" });
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.active.values()].map((job) =>
        job.worker.terminate().catch(() => undefined),
      ),
    );
    this.active.clear();
  }

  /** 任务终结（完成/失败/取消）后清理该任务的 staging 目录 */
  async cleanupStaging(taskId: string): Promise<void> {
    if (this.active.has(taskId)) return;
    await safeRm(join(STAGING_DIR, taskId));
  }
}
