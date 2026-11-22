type Listener<T> = (payload: T) => void;

/** 极简类型安全事件总线，调度器 -> HTTP/SSE 层 */
export class EventBus<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => set!.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.listeners.get(event)?.forEach((listener) => {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (err) {
        console.error("event listener error:", err);
      }
    });
  }
}

export interface SchedulerEvents {
  task: { taskId: string };
  metrics: { timestamp: number };
  decision: { at: number };
}
