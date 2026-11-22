import type { TaskCheckpoint, TaskRecord } from "../../shared/protocol.ts";
import { LEASE_MS } from "../config.ts";
import type { Executor, RunContext } from "./executor.ts";

interface BrowserWorker {
  workerId: string;
  connectedAt: number;
  lastSeen: number;
  taskId: string | null;
}

interface Lease {
  workerId: string;
  taskId: string;
  expiresAt: number;
  runContext: RunContext;
}

/**
 * 浏览器执行器：不直接跑任务，只管理 WebCodecs Worker 的租约。
 * Worker 通过长轮询 /api/claim 领取任务、/api/progress 续租并上报检查点。
 * 租约超时（页面崩溃/断网）后任务自动回到暂停态，检查点不丢。
 */
export class BrowserExecutor implements Executor {
  readonly kind = "transcode";
  private workers = new Map<string, BrowserWorker>();
  private leases = new Map<string, Lease>(); // taskId -> lease
  private timers = new Map<string, NodeJS.Timeout>();
  private signals = new Map<string, "pause" | "cancel">();

  supports(task: TaskRecord): boolean {
    return task.kind === "transcode";
  }

  has(taskId: string): boolean {
    return this.leases.has(taskId);
  }

  registerWorker(workerId: string): void {
    this.workers.set(workerId, {
      workerId,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      taskId: null,
    });
  }

  unregisterWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    this.workers.delete(workerId);
    if (worker?.taskId) {
      const lease = this.leases.get(worker.taskId);
      if (lease) this.expireLease(worker.taskId, "浏览器 Worker 断开连接");
    }
  }

  availableSlots(): number {
    let idle = 0;
    for (const worker of this.workers.values()) {
      if (worker.taskId === null) idle += 1;
    }
    return idle;
  }

  idleWorkerExists(): boolean {
    return [...this.workers.values()].some((worker) => worker.taskId === null);
  }

  /** 调度器调用：把任务租给一个空闲浏览器 Worker */
  leaseTask(context: RunContext): string | null {
    const worker = [...this.workers.values()].find((item) => item.taskId === null);
    if (!worker) return null;
    worker.taskId = context.task.id;
    const lease: Lease = {
      workerId: worker.workerId,
      taskId: context.task.id,
      expiresAt: Date.now() + LEASE_MS,
      runContext: context,
    };
    this.leases.set(context.task.id, lease);
    this.armTimer(context.task.id);
    return worker.workerId;
  }

  reportProgress(
    taskId: string,
    workerId: string,
    checkpoint: TaskCheckpoint,
    progress: number,
    residentMB: number,
  ): boolean {
    const lease = this.leases.get(taskId);
    if (!lease || lease.workerId !== workerId) return false;
    lease.expiresAt = Date.now() + LEASE_MS;
    lease.runContext.onCheckpoint(checkpoint, progress, residentMB);
    this.armTimer(taskId);
    return true;
  }

  finishTask(taskId: string, workerId: string, checkpoint: TaskCheckpoint): boolean {
    const lease = this.leases.get(taskId);
    if (!lease || lease.workerId !== workerId) return false;
    this.clearTimer(taskId);
    this.leases.delete(taskId);
    this.signals.delete(taskId);
    const worker = this.workers.get(workerId);
    if (worker) worker.taskId = null;
    lease.runContext.onCheckpoint(checkpoint, 1, 0);
    return true;
  }

  failTask(taskId: string, workerId: string, message: string): boolean {
    const lease = this.leases.get(taskId);
    if (!lease || lease.workerId !== workerId) return false;
    this.clearTimer(taskId);
    this.leases.delete(taskId);
    this.signals.delete(taskId);
    const worker = this.workers.get(workerId);
    if (worker) worker.taskId = null;
    lease.runContext.onFailed(message);
    return true;
  }

  requestPause(taskId: string): void {
    this.signals.set(taskId, "pause");
  }

  requestCancel(taskId: string): void {
    this.signals.set(taskId, "cancel");
  }

  /** 浏览器 Worker 每次续租时轮询信号；取走后清除（一次性） */
  pollSignal(taskId: string): "pause" | "cancel" | null {
    const signal = this.signals.get(taskId) ?? null;
    if (signal) this.signals.delete(taskId);
    return signal;
  }

  /** 租约回收：Worker 失联时把任务安全退回暂停态 */
  private expireLease(taskId: string, detail: string): void {
    const lease = this.leases.get(taskId);
    if (!lease) return;
    this.clearTimer(taskId);
    this.leases.delete(taskId);
    this.signals.delete(taskId);
    const worker = this.workers.get(lease.workerId);
    if (worker) worker.taskId = null;
    lease.runContext.onLeaseLost?.(detail);
  }

  private armTimer(taskId: string): void {
    this.clearTimer(taskId);
    const lease = this.leases.get(taskId);
    if (!lease) return;
    const delay = Math.max(500, lease.expiresAt - Date.now());
    const timer = setTimeout(() => {
      this.expireLease(taskId, "租约超时，Worker 可能已崩溃");
    }, delay);
    timer.unref();
    this.timers.set(taskId, timer);
  }

  private clearTimer(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.leases.clear();
    this.workers.clear();
  }
}
