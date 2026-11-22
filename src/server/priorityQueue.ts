import type { TaskRecord } from "../shared/protocol.ts";
import { PRIORITY_AGING_MS } from "./config.ts";

/**
 * 带老化的优先级队列。
 * 等效优先级 = 显式优先级 + 等待时长 / PRIORITY_AGING_MS，
 * 因此小任务即使优先级低，等久了也会排到大任务前面。
 */
export class PriorityTaskQueue {
  private items: TaskRecord[] = [];

  size(): number {
    return this.items.length;
  }

  has(taskId: string): boolean {
    return this.items.some((task) => task.id === taskId);
  }

  add(task: TaskRecord): void {
    if (this.has(task.id)) return;
    this.items.push(task);
  }

  remove(taskId: string): TaskRecord | null {
    const index = this.items.findIndex((task) => task.id === taskId);
    if (index < 0) return null;
    const [removed] = this.items.splice(index, 1);
    return removed ?? null;
  }

  static effectivePriority(task: TaskRecord, now: number): number {
    const ageBonus = Math.max(0, now - task.createdAt) / PRIORITY_AGING_MS;
    return task.priority + ageBonus;
  }

  /** 返回按等效优先级排序的快照（不修改原队列） */
  ordered(now: number): TaskRecord[] {
    return [...this.items].sort(
      (a, b) =>
        PriorityTaskQueue.effectivePriority(b, now) -
          PriorityTaskQueue.effectivePriority(a, now) ||
        a.createdAt - b.createdAt,
    );
  }

  peek(now: number): TaskRecord | null {
    return this.ordered(now)[0] ?? null;
  }

  all(): TaskRecord[] {
    return [...this.items];
  }
}
