import type { ScheduleDecision, TaskRecord } from "../shared/protocol.ts";
import { DECISIONS_FILE, DECISION_HISTORY, STATE_FILE, STATE_DIR } from "./config.ts";
import { ensureDir, safeRm, writeFileAtomic } from "./util/atomic.ts";

interface PersistedState {
  version: 1;
  savedAt: number;
  tasks: TaskRecord[];
}

/**
 * 任务状态持久化：
 * - 内存 Map 为权威态，每次变更后防抖落盘（原子 rename）；
 * - 进程崩溃最多丢失最近 200ms 的状态，检查点在执行器侧单独 fsync，
 *   因此恢复时从最后一个检查点继续，不会产生半个文件；
 * - 崩溃时处于 starting/running/pausing 的任务恢复为 queued/paused，
   其租约一律作废。
 */
export class StateStore {
  private tasks = new Map<string, TaskRecord>();
  private decisions: ScheduleDecision[] = [];
  private saveTimer: NodeJS.Timeout | null = null;

  async load(): Promise<TaskRecord[]> {
    await ensureDir(STATE_DIR);
    try {
      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(STATE_FILE, "utf8"),
      );
      const parsed = JSON.parse(raw) as PersistedState;
      const recovered: TaskRecord[] = [];
      for (const task of parsed.tasks) {
        const restored = this.recoverAfterCrash(task);
        this.tasks.set(restored.id, restored);
        recovered.push(restored);
      }
      return recovered;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return [];
    }
  }

  private recoverAfterCrash(task: TaskRecord): TaskRecord {
    if (
      task.state === "running" ||
      task.state === "starting" ||
      task.state === "pausing" ||
      task.state === "cancelling"
    ) {
      const hasCheckpoint = task.checkpoint !== null;
      return {
        ...task,
        state: hasCheckpoint ? "paused" : "queued",
        waitReason: hasCheckpoint ? "none" : "cpu-quota",
        reasonDetail: "进程重启，从最后检查点恢复",
        leasedBy: null,
        leaseExpiresAt: null,
        pauseSource: task.pauseSource ?? null,
      };
    }
    return task;
  }

  upsert(task: TaskRecord): void {
    this.tasks.set(task.id, { ...task, updatedAt: Date.now() });
    this.scheduleSave();
  }

  get(taskId: string): TaskRecord | null {
    return this.tasks.get(taskId) ?? null;
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  delete(taskId: string): void {
    this.tasks.delete(taskId);
    this.scheduleSave();
  }

  addDecision(decision: ScheduleDecision): void {
    this.decisions.push(decision);
    if (this.decisions.length > DECISION_HISTORY) this.decisions.shift();
  }

 listDecisions(): ScheduleDecision[] {
    return [...this.decisions];
  }

  async appendDecisionLog(decision: ScheduleDecision): Promise<void> {
    await ensureDir(STATE_DIR);
    const fs = await import("node:fs/promises");
    await fs.appendFile(DECISIONS_FILE, `${JSON.stringify(decision)}\n`);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const state: PersistedState = {
      version: 1,
      savedAt: Date.now(),
      tasks: this.list(),
    };
    await writeFileAtomic(STATE_FILE, JSON.stringify(state));
  }

  async reset(): Promise<void> {
    this.tasks.clear();
    this.decisions = [];
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await safeRm(STATE_FILE);
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch((err) => console.error("state flush failed:", err));
    }, 200);
    this.saveTimer.unref();
  }
}
