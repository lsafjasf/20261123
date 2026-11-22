import type { TaskCheckpoint, TaskRecord } from "../../shared/protocol.ts";

/**
 * 执行器统一抽象。本地任务（upload/proxy/output）走 worker_threads，
 * transcode 走浏览器 Worker（WebCodecs）。
 * 信号语义：
 * - pause：执行器必须在下一个检查点安全停下，先 fsync 已完成分段；
 * - cancel：执行器在检查点清理全部临时文件后退出；
 * - resume：仅通过重新 run() 并传入上次检查点实现。
 */
export interface RunContext {
  task: TaskRecord;
  workerId: string;
  onCheckpoint: (checkpoint: TaskCheckpoint, progress: number, residentMB: number) => void;
  /** 执行器确认已在检查点安全暂停 */
  onPaused: (checkpoint: TaskCheckpoint | null) => void;
  /** 执行器确认已清理临时文件并完成取消 */
  onCancelled: () => void;
  /** 执行器运行失败（抛出错误），交给调度器走重试逻辑 */
  onFailed: (message: string) => void;
  /** 浏览器 Worker 租约丢失（断连/超时），调度器据此安全回收 */
  onLeaseLost?: (detail: string) => void;
}

export interface Executor {
  readonly kind: TaskRecord["kind"] | "any";
  availableSlots(): number;
  supports(task: TaskRecord): boolean;
  run(context: RunContext): Promise<TaskCheckpoint>;
  requestPause(taskId: string): void;
  requestCancel(taskId: string): void;
  has(taskId: string): boolean;
  stop(): Promise<void>;
}

export class TaskAbortedError extends Error {
  readonly cancelled: boolean;

  constructor(
    message: string,
    cancelled: boolean,
  ) {
    super(message);
    this.name = "TaskAbortedError";
    this.cancelled = cancelled;
  }
}
