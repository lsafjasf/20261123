import type {
  ApiResult,
  QuotaConfig,
  ResourceMetrics,
  ScheduleDecision,
  TaskCheckpoint,
  TaskRecord,
  TaskSpec,
  WaitReason,
} from "../shared/protocol.ts";
import {
  OUTPUT_DIR,
  PER_TASK_LIMITS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  SCHEDULER_TICK_MS,
  STAGING_DIR,
  UPLOAD_DIR,
} from "./config.ts";
import { EventBus, type SchedulerEvents } from "./events.ts";
import { BrowserExecutor } from "./executor/browserExecutor.ts";
import { LocalExecutor } from "./executor/localExecutor.ts";
import type { Executor, RunContext } from "./executor/executor.ts";
import { MetricsMonitor } from "./metrics.ts";
import { PriorityTaskQueue } from "./priorityQueue.ts";
import { StateStore } from "./stateStore.ts";
import {
  createId,
  ensureDir,
  mergeSegments,
  safeRm,
  underRoot,
} from "./util/atomic.ts";
import { dirname, join } from "node:path";

const ACTIVE_STATES = new Set(["starting", "running", "pausing", "cancelling"]);

export class Scheduler {
  readonly events = new EventBus<SchedulerEvents>();
  readonly queue = new PriorityTaskQueue();
  readonly store = new StateStore();
  readonly quota: QuotaConfig;
  readonly monitor: MetricsMonitor;
  private readonly executors: Executor[];
  private readonly local: LocalExecutor;
  readonly browser: BrowserExecutor;
  private tickTimer: NodeJS.Timeout | null = null;
  private residentByTask = new Map<string, number>();

  constructor(quota: QuotaConfig) {
    this.quota = quota;
    this.local = new LocalExecutor(quota.maxConcurrent);
    this.browser = new BrowserExecutor();
    this.executors = [this.local, this.browser];
    this.monitor = new MetricsMonitor(quota, () => this.currentReservations());
  }

  async start(): Promise<void> {
    const recovered = await this.store.load();
    for (const task of recovered) {
      if (task.state === "queued") this.queue.add(task);
    }
    await ensureDir(STAGING_DIR);
    await ensureDir(OUTPUT_DIR);
    await ensureDir(UPLOAD_DIR);
    this.monitor.start();
    this.tickTimer = setInterval(() => {
      this.tick().catch((err) => console.error("scheduler tick failed:", err));
    }, SCHEDULER_TICK_MS);
    this.tickTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.monitor.stop();
    await Promise.all(this.executors.map((executor) => executor.stop()));
    await this.store.flush();
  }

  // ---------- 任务提交 ----------

  submit(input: Omit<TaskSpec, "id" | "createdAt">): ApiResult {
    const validation = this.validate(input);
    if (validation) return { ok: false, error: validation };
    const now = Date.now();
    const task: TaskRecord = {
      ...input,
      id: createId(input.kind),
      createdAt: now,
      state: "queued",
      waitReason: "cpu-quota",
      reasonDetail: "等待调度",
      attempts: 0,
      progress: 0,
      checkpoint: null,
      pauseSource: null,
      lastError: null,
      leasedBy: null,
      leaseExpiresAt: null,
      notBefore: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.store.upsert(task);
    this.queue.add(task);
    this.events.emit("task", { taskId: task.id });
    return { ok: true, task };
  }

  private validate(input: Omit<TaskSpec, "id" | "createdAt">): string | null {
    if (input.cpu <= 0 || input.memoryMB <= 0 || input.tmpMB <= 0) {
      return "资源配额必须为正数";
    }
    if (input.cpu > PER_TASK_LIMITS.cpu) return `单任务 CPU 不能超过 ${PER_TASK_LIMITS.cpu} 核`;
    if (input.memoryMB > PER_TASK_LIMITS.memoryMB) {
      return `单任务内存不能超过 ${PER_TASK_LIMITS.memoryMB}MB`;
    }
    if (input.tmpMB > PER_TASK_LIMITS.tmpMB) return `单任务临时磁盘不能超过 ${PER_TASK_LIMITS.tmpMB}MB`;
    if (input.cpu > this.quota.maxCpuCores) return "申请 CPU 超过整机调度配额";
    if (input.memoryMB > this.quota.maxMemoryMB) return "申请内存超过整机调度配额";
    if (input.tmpMB > this.quota.maxTmpMB) return "申请临时磁盘超过整机调度配额";
    const output = input.payload.outputPath;
    if (output && !underRoot(join(process.cwd(), "data"), join(process.cwd(), "data", output))) {
      return "outputPath 必须位于 data 目录内";
    }
    return null;
  }

  // ---------- 控制信号 ----------

  pause(taskId: string): ApiResult {
    const task = this.store.get(taskId);
    if (!task) return { ok: false, error: "任务不存在" };
    if (task.state === "queued") {
      this.update(task, {
        state: "paused",
        waitReason: "none",
        reasonDetail: "手动暂停（排队中）",
        pauseSource: "manual",
      });
      return { ok: true, task: this.store.get(taskId)! };
    }
    if (task.state === "running" || task.state === "starting") {
      this.update(task, {
        state: "pausing",
        reasonDetail: "等待执行器到达检查点后暂停",
        pauseSource: "manual",
      });
      this.pickExecutor(task)?.requestPause(taskId);
      return { ok: true, task: this.store.get(taskId)! };
    }
    return { ok: false, error: `当前状态 ${task.state} 不可暂停` };
  }

  resume(taskId: string): ApiResult {
    const task = this.store.get(taskId);
    if (!task) return { ok: false, error: "任务不存在" };
    if (task.state !== "paused") return { ok: false, error: `当前状态 ${task.state} 不可恢复` };
    const reset: Partial<TaskRecord> = {
      state: "queued",
      waitReason: "cpu-quota",
      reasonDetail: "已恢复，等待重新调度",
      notBefore: Date.now(),
      leasedBy: null,
      leaseExpiresAt: null,
      pauseSource: null,
    };
    this.update(task, reset);
    this.queue.add(this.store.get(taskId)!);
    return { ok: true, task: this.store.get(taskId)! };
  }

  cancel(taskId: string): ApiResult {
    const task = this.store.get(taskId);
    if (!task) return { ok: false, error: "任务不存在" };
    if (["completed", "failed", "cancelled"].includes(task.state)) {
      return { ok: false, error: `任务已终结（${task.state}）` };
    }
    if (task.state === "queued" || task.state === "paused") {
      this.queue.remove(taskId);
      this.finalizeCancelled(task);
      return { ok: true, task: this.store.get(taskId)! };
    }
    this.update(task, { state: "cancelling", reasonDetail: "等待执行器在检查点清理临时文件" });
    this.pickExecutor(task)?.requestCancel(taskId);
    return { ok: true, task: this.store.get(taskId)! };
  }

  listTasks(): TaskRecord[] {
    return this.store.list();
  }

  getTask(taskId: string): TaskRecord | null {
    return this.store.get(taskId);
  }

  metricsHistory(): ResourceMetrics[] {
    return this.monitor.history;
  }

  decisions(): ScheduleDecision[] {
    return this.store.listDecisions();
  }

  // ---------- 调度主循环 ----------

  private async tick(): Promise<void> {
    const now = Date.now();
    const metrics = this.monitor.latest() ?? (await this.monitor.sample());
    this.handlePressure(metrics);
    this.reclaimExpiredLocalJobs(now);
    this.autoResumeAfterPressure(metrics);

    const ordered = this.queue.ordered(now);
    for (const task of ordered) {
      const fresh = this.store.get(task.id);
      if (!fresh || fresh.state !== "queued") {
        this.queue.remove(task.id);
        continue;
      }
      if (fresh.notBefore > now) {
        this.markWaiting(fresh, "retry-backoff", `退避中，${Math.ceil((fresh.notBefore - now) / 1000)}s 后重试`);
        continue;
      }
      const blocker = this.admissionBlocker(fresh, metrics);
      if (blocker) {
        this.markWaiting(fresh, blocker.reason, blocker.detail);
        continue;
      }
      await this.admit(fresh);
    }
    this.events.emit("metrics", { timestamp: now });
  }

  /** 压力暂停的任务在资源缓解后自动回到队列；手动暂停不受影响 */
  private autoResumeAfterPressure(metrics: ResourceMetrics): void {
    if (metrics.pressure !== "none") return;
    for (const task of this.store.list()) {
      if (task.state !== "paused" || task.pauseSource !== "pressure") continue;
      this.update(task, {
        state: "queued",
        waitReason: "cpu-quota",
        reasonDetail: "资源压力缓解，自动重新排队",
        pauseSource: null,
        notBefore: Date.now(),
      });
      this.queue.add(this.store.get(task.id)!);
      this.decide(task.id, "resume", "none", "压力缓解，自动恢复");
    }
  }

  /** 资源挤占时的安全暂停：按“内存性价比”挑一个运行任务在检查点暂停 */
  private handlePressure(metrics: ResourceMetrics): void {
    if (metrics.pressure === "none") return;
    const victims = this.store
      .list()
      .filter((task) => task.state === "running" || task.state === "starting");
    if (victims.length === 0) return;
    // 优先暂停内存申请最大的任务，快速释放压力；同值取进度低的（损失最小）
    victims.sort((a, b) => b.memoryMB - a.memoryMB || a.progress - b.progress);
    const victim = victims[0]!;
    if (victim.state === "pausing" || victim.state === "cancelling") return;
    this.update(victim, {
      state: "pausing",
      reasonDetail: `资源压力（${metrics.pressure}）触发安全暂停，等待检查点`,
      pauseSource: "pressure",
    });
    this.pickExecutor(victim)?.requestPause(victim.id);
    this.decide(victim.id, "pause", "resource-pressure", `整机 ${metrics.pressure} 压力超阈值`);
  }

  private reclaimExpiredLocalJobs(now: number): void {
    for (const task of this.store.list()) {
      if (!task.leaseExpiresAt || !task.leasedBy) continue;
      if (task.leaseExpiresAt <= now && ACTIVE_STATES.has(task.state)) {
        this.decide(task.id, "lease-reclaim", "lease-lost", "执行租约过期，回收任务");
        this.requeueFromLease(task, "租约过期，从检查点恢复");
      }
    }
  }

  private admissionBlocker(
    task: TaskRecord,
    metrics: ResourceMetrics,
  ): { reason: WaitReason; detail: string } | null {
    const reserved = this.currentReservations();
    if (reserved.cpu + task.cpu > this.quota.maxCpuCores) {
      return {
        reason: "cpu-quota",
        detail: `CPU 预留 ${reserved.cpu.toFixed(1)}/${this.quota.maxCpuCores} 核，本任务需 ${task.cpu} 核`,
      };
    }
    if (reserved.memoryMB + task.memoryMB > this.quota.maxMemoryMB) {
      return {
        reason: "memory-quota",
        detail: `内存预留 ${reserved.memoryMB}/${this.quota.maxMemoryMB}MB，本任务需 ${task.memoryMB}MB`,
      };
    }
    if (reserved.tmpMB + task.tmpMB > this.quota.maxTmpMB) {
      return {
        reason: "tmp-disk-quota",
        detail: `临时盘预留 ${reserved.tmpMB}/${this.quota.maxTmpMB}MB，本任务需 ${task.tmpMB}MB`,
      };
    }
    const executor = this.executors.find((item) => item.supports(task));
    if (!executor) return { reason: "waiting-worker", detail: "没有可执行该类型任务的执行器" };
    if (executor.availableSlots() <= 0) {
      return task.kind === "transcode"
        ? { reason: "waiting-worker", detail: "没有空闲的浏览器 WebCodecs Worker" }
        : { reason: "max-concurrency", detail: `本地并发上限 ${this.quota.maxConcurrent} 已满` };
    }
    if (metrics.pressure !== "none") {
      const pressureBlocker = this.pressureBlocker(task, metrics.pressure, reserved);
      if (pressureBlocker) return pressureBlocker;
    }
    return null;
  }

  /** 压力态下优先返回真正耗尽的资源维度，让页面等待原因更准确 */
  private pressureBlocker(
    task: TaskRecord,
    pressure: ResourceMetrics["pressure"],
    reserved: { cpu: number; memoryMB: number; tmpMB: number },
  ): { reason: WaitReason; detail: string } | null {
    if (pressure === "memory" && reserved.memoryMB + task.memoryMB > this.quota.maxMemoryMB) {
      return { reason: "memory-quota", detail: "整机内存压力且配额已满，等待内存释放" };
    }
    if (pressure === "tmp" && reserved.tmpMB + task.tmpMB > this.quota.maxTmpMB) {
      return { reason: "tmp-disk-quota", detail: "临时盘压力且配额已满，等待磁盘释放" };
    }
    if (pressure === "cpu" && reserved.cpu + task.cpu > this.quota.maxCpuCores) {
      return { reason: "cpu-quota", detail: "CPU 压力且配额已满，等待核数释放" };
    }
    return { reason: "resource-pressure", detail: `整机处于 ${pressure} 压力，暂停准入新任务` };
  }

  private async admit(task: TaskRecord): Promise<void> {
    const executor = this.executors.find((item) => item.supports(task))!;
    const workerId = createId("w");
    this.update(task, {
      state: "starting",
      waitReason: "none",
      reasonDetail: "资源已满足，启动执行器",
      attempts: task.attempts + 1,
      leasedBy: workerId,
      leaseExpiresAt: Date.now() + 60_000,
      startedAt: task.startedAt ?? Date.now(),
    });
    this.queue.remove(task.id);
    this.decide(task.id, "admit", "none", `准入执行（第 ${task.attempts + 1} 次尝试）`);

    const context: RunContext = {
      task: this.store.get(task.id)!,
      workerId,
      onCheckpoint: (checkpoint, progress) => this.handleCheckpoint(task.id, checkpoint, progress),
      onPaused: (checkpoint) => this.handlePaused(task.id, checkpoint),
      onCancelled: () => {
        const current = this.store.get(task.id);
        if (current) this.finalizeCancelled(current);
      },
      onFailed: (message) => this.handleFailure(task.id, new Error(message)),
      onLeaseLost: (detail) => {
        const current = this.store.get(task.id);
        if (current && ACTIVE_STATES.has(current.state)) {
          this.requeueFromLease(current, detail);
        }
      },
    };

    try {
      const finalCheckpoint = await executor.run(context);
      const after = this.store.get(task.id);
      if (after && (after.state === "paused" || after.state === "cancelled")) return;
      await this.handleSuccess(task.id, finalCheckpoint);
    } catch (err) {
      this.handleFailure(task.id, err as Error);
    }
  }

  // ---------- 执行结果处理 ----------

  private handleCheckpoint(
    taskId: string,
    checkpoint: TaskCheckpoint,
    progress: number,
    residentMB?: number,
  ): void {
    const task = this.store.get(taskId);
    if (!task) return;
    if (residentMB !== undefined) this.residentByTask.set(taskId, residentMB);
    if (task.state === "cancelling") return; // 取消中只等终结，不刷新进度
    const leaseRenewed =
      task.leasedBy !== null && task.state !== "paused"
        ? { leaseExpiresAt: Date.now() + 60_000 }
        : {};
    this.update(task, {
      checkpoint,
      progress: Math.max(task.progress, progress),
      state: task.state === "pausing" ? "pausing" : "running",
      reasonDetail:
        task.state === "pausing"
          ? "检查点已落盘，等待当前 chunk 结束后暂停"
          : `处理到第 ${checkpoint.chunk} 块`,
      ...leaseRenewed,
    });
    this.events.emit("task", { taskId });
  }

  /** 执行器在检查点安全停下（暂停信号） */
  handlePaused(taskId: string, checkpoint: TaskCheckpoint | null): void {
    const task = this.store.get(taskId);
    if (!task) return;
    if (task.state === "cancelling") {
      this.finalizeCancelled(task);
      return;
    }
    this.update(task, {
      state: "paused",
      checkpoint: checkpoint ?? task.checkpoint,
      leasedBy: null,
      leaseExpiresAt: null,
      waitReason: "none",
      reasonDetail: "已在检查点安全暂停，临时分段完整保留",
    });
    this.decide(taskId, "pause", "resource-pressure", "执行器在检查点暂停完成");
  }

  private async handleSuccess(taskId: string, checkpoint: TaskCheckpoint): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    if (task.state === "cancelling") {
      this.finalizeCancelled(task);
      return;
    }
    try {
      await this.materializeOutput(task, checkpoint);
      await this.local.cleanupStaging(taskId);
      this.residentByTask.delete(taskId);
      this.update(task, {
        state: "completed",
        progress: 1,
        checkpoint,
        leasedBy: null,
        leaseExpiresAt: null,
        waitReason: "none",
        reasonDetail: "成片已原子落盘",
        finishedAt: Date.now(),
        pauseSource: null,
      });
      this.decide(taskId, "admit", "none", "任务完成并合并产物");
    } catch (err) {
      this.handleFailure(taskId, err as Error);
    }
  }

  /**
   * 产物落地：分段在 staging 拼接为 .partial，关闭后原子 rename。
   * upload 任务的单个 .part 直接 rename；其余按 segments 顺序合并。
   */
  private async materializeOutput(task: TaskRecord, checkpoint: TaskCheckpoint): Promise<void> {
    const outputName = task.payload.outputPath;
    if (!outputName) return;
    const finalPath = join(process.cwd(), "data", outputName);
    const staging = join(STAGING_DIR, task.id);
    if (task.kind === "upload" && checkpoint.segments.length === 1) {
      const { rename } = await import("node:fs/promises");
      await ensureDir(dirname(finalPath));
      await rename(join(staging, checkpoint.segments[0]!), finalPath);
      return;
    }
    const segmentPaths = checkpoint.segments.map((name) => join(staging, name));
    await mergeSegments(segmentPaths, finalPath);
  }

  private handleFailure(taskId: string, err: Error): void {
    const task = this.store.get(taskId);
    if (!task) return;
    if (task.state === "cancelling") {
      this.finalizeCancelled(task);
      return;
    }
    this.residentByTask.delete(taskId);
    if (task.attempts <= task.maxRetries) {
      const delay = Math.min(
        RETRY_MAX_DELAY_MS,
        RETRY_BASE_DELAY_MS * 2 ** (task.attempts - 1),
      );
      this.update(task, {
        state: "queued",
        waitReason: "retry-backoff",
        reasonDetail: `第 ${task.attempts} 次尝试失败：${err.message}；${delay / 1000}s 后重试`,
        lastError: err.message,
        leasedBy: null,
        leaseExpiresAt: null,
        notBefore: Date.now() + delay,
      });
      this.queue.add(this.store.get(taskId)!);
      this.decide(taskId, "retry-later", "retry-backoff", `${err.message}，退避 ${delay}ms`);
    } else {
      this.update(task, {
        state: "failed",
        waitReason: "none",
        reasonDetail: `重试 ${task.maxRetries} 次后仍失败`,
        lastError: err.message,
        leasedBy: null,
        leaseExpiresAt: null,
        finishedAt: Date.now(),
        pauseSource: null,
      });
      this.decide(taskId, "reject", "none", `重试耗尽：${err.message}`);
      this.local.cleanupStaging(taskId).catch(() => undefined);
    }
  }

  private finalizeCancelled(task: TaskRecord): void {
    this.local.cleanupStaging(task.id).catch(() => undefined);
    this.residentByTask.delete(task.id);
    this.update(task, {
      state: "cancelled",
      waitReason: "none",
      reasonDetail: "已取消，staging 临时文件已清理",
      leasedBy: null,
      leaseExpiresAt: null,
      finishedAt: Date.now(),
      pauseSource: null,
    });
    this.decide(task.id, "reject", "none", "用户取消");
  }

  private requeueFromLease(task: TaskRecord, detail: string): void {
    const next: Partial<TaskRecord> = {
      leasedBy: null,
      leaseExpiresAt: null,
      notBefore: Date.now(),
      reasonDetail: detail,
    };
    if (task.checkpoint) {
      next.state = "paused";
      next.waitReason = "none";
    } else {
      next.state = "queued";
      next.waitReason = "lease-lost";
    }
    this.update(task, next);
    if (next.state === "queued") this.queue.add(this.store.get(task.id)!);
    this.events.emit("task", { taskId: task.id });
  }

  // ---------- 资源记账 ----------

  private currentReservations(): {
    cpu: number;
    memoryMB: number;
    tmpMB: number;
    residentMB: number;
  } {
    let cpu = 0;
    let memoryMB = 0;
    let tmpMB = 0;
    let residentMB = 0;
    for (const task of this.store.list()) {
      if (!ACTIVE_STATES.has(task.state)) continue;
      cpu += task.cpu;
      memoryMB += task.memoryMB;
      tmpMB += task.tmpMB;
      residentMB += this.residentByTask.get(task.id) ?? 0;
    }
    return { cpu, memoryMB, tmpMB, residentMB };
  }

  // ---------- 内部工具 ----------

  private pickExecutor(task: TaskRecord): Executor | undefined {
    return this.executors.find((executor) => executor.supports(task));
  }

  private update(task: TaskRecord, patch: Partial<TaskRecord>): void {
    const current = this.store.get(task.id);
    if (!current) return;
    this.store.upsert({ ...current, ...patch, updatedAt: Date.now() });
    this.events.emit("task", { taskId: task.id });
  }

  private markWaiting(task: TaskRecord, reason: WaitReason, detail: string): void {
    if (task.waitReason === reason && task.reasonDetail === detail) return;
    this.update(task, { waitReason: reason, reasonDetail: detail });
  }

  private decide(
    taskId: string | null,
    action: ScheduleDecision["action"],
    reason: WaitReason,
    detail: string,
  ): void {
    const decision: ScheduleDecision = { at: Date.now(), taskId, action, reason, detail };
    this.store.addDecision(decision);
    this.store.appendDecisionLog(decision).catch(() => undefined);
    this.events.emit("decision", { at: decision.at });
  }

  async resetAll(): Promise<void> {
    await this.store.reset();
    await safeRm(STAGING_DIR);
    await safeRm(join(process.cwd(), "data", "outputs"));
    await ensureDir(STAGING_DIR);
    await ensureDir(OUTPUT_DIR);
  }

  /** 供浏览器执行器在 Worker 回报暂停时调用 */
  notifyPaused(taskId: string, checkpoint: TaskCheckpoint | null): void {
    this.handlePaused(taskId, checkpoint);
  }

  notifySuccess(taskId: string, checkpoint: TaskCheckpoint): void {
    this.handleSuccess(taskId, checkpoint).catch((err) =>
      this.handleFailure(taskId, err),
    );
  }

  notifyFailure(taskId: string, message: string): void {
    this.handleFailure(taskId, new Error(message));
  }

  /** 浏览器 Worker 拉取可执行的 transcode 任务 */
  claimForBrowser(workerId: string): TaskRecord | null {
    this.browser.registerWorker(workerId);
    const now = Date.now();
    const candidates = this.queue
      .ordered(now)
      .filter((task) => task.kind === "transcode" && task.state === "queued" && task.notBefore <= now);
    for (const candidate of candidates) {
      const blocker = this.admissionBlocker(candidate, this.monitor.latest() ?? {
        pressure: "none",
      } as ResourceMetrics);
      if (blocker) continue;
      const fresh = this.store.get(candidate.id)!;
      const context: RunContext = {
        task: fresh,
        workerId,
        onCheckpoint: (checkpoint, progress, residentMB) =>
          this.handleCheckpoint(fresh.id, checkpoint, progress, residentMB),
        onPaused: (checkpoint) => this.handlePaused(fresh.id, checkpoint),
        onCancelled: () => {
          const current = this.store.get(fresh.id);
          if (current) this.finalizeCancelled(current);
        },
        onFailed: (message) => this.handleFailure(fresh.id, new Error(message)),
        onLeaseLost: (detail) => {
          const current = this.store.get(fresh.id);
          if (current && ACTIVE_STATES.has(current.state)) this.requeueFromLease(current, detail);
        },
      };
      const leased = this.browser.leaseTask(context);
      if (!leased) return null;
      this.queue.remove(fresh.id);
      this.update(fresh, {
        state: "running",
        waitReason: "none",
        reasonDetail: "已租借给浏览器 WebCodecs Worker",
        attempts: fresh.attempts + 1,
        leasedBy: workerId,
        leaseExpiresAt: Date.now() + 15_000,
        startedAt: fresh.startedAt ?? Date.now(),
      });
      this.decide(fresh.id, "admit", "none", "浏览器 Worker 领取任务");
      return this.store.get(fresh.id);
    }
    return null;
  }
}
