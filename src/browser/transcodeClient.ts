import type { TaskCheckpoint, TaskRecord } from "../shared/protocol.ts";

/**
 * 主线程侧 WebCodecs Worker 管理器：
 * 长轮询 /api/claim 领取 transcode 任务，把控制信号转给 Worker，
 * Worker 产出的 webm 分段经 fetch 上传到 staging，检查点通过 /api/progress 续租。
 */
export function startTranscodeWorker(options: {
  onStatus: (online: boolean) => void;
}): void {
  if (typeof Worker === "undefined" || typeof VideoEncoder === "undefined") {
    options.onStatus(false);
    return;
  }
  const workerId = `bw_${Math.random().toString(36).slice(2, 10)}`;
  const worker = new Worker("./transcodeWorker.ts", { type: "module" });
  let current: { taskId: string; checkpoint: TaskCheckpoint | null } | null = null;

  worker.onmessage = async (event: MessageEvent) => {
    const message = event.data;
    if (message.type === "upload") {
      try {
        const response = await fetch(
          `/api/segments/${message.taskId}/${encodeURIComponent(message.name)}`,
          { method: "POST", body: message.bytes },
        );
        const result = await response.json();
        message.port.postMessage(result);
      } catch (err) {
        message.port.postMessage({ ok: false, error: (err as Error).message });
      }
      return;
    }
    if (!current) return;
    if (message.type === "checkpoint") {
      current.checkpoint = message.checkpoint;
      const reply = await postJson("/api/progress", {
        taskId: current.taskId,
        workerId,
        checkpoint: message.checkpoint,
        progress: message.progress,
        residentMB: estimateWorkerMemoryMB(),
      });
      if (reply.signal) worker.postMessage({ type: "control", signal: reply.signal });
    } else if (message.type === "paused") {
      await postJson("/api/paused", {
        taskId: current.taskId,
        workerId,
        checkpoint: message.checkpoint,
      });
      current = null;
      options.onStatus(true);
    } else if (message.type === "done") {
      await postJson("/api/finish", {
        taskId: current.taskId,
        workerId,
        checkpoint: message.checkpoint,
      });
      current = null;
      options.onStatus(true);
    } else if (message.type === "cancelled" || message.type === "error") {
      await postJson("/api/fail", {
        taskId: current.taskId,
        workerId,
        checkpoint: current.checkpoint,
        error: message.type === "cancelled" ? "浏览器端取消" : message.message,
      });
      current = null;
    }
  };

  async function claimLoop(): Promise<void> {
    options.onStatus(true);
    while (true) {
      try {
        if (!current) {
          const result = (await postJson("/api/claim", { workerId, kind: "transcode" })) as {
            ok: boolean;
            task: TaskRecord | null;
          };
          if (result.task) {
            current = { taskId: result.task.id, checkpoint: result.task.checkpoint };
            worker.postMessage({ type: "run", task: result.task });
          }
        }
      } catch {
        options.onStatus(false);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
    }
  }

  window.addEventListener("beforeunload", () => {
    void postJson("/api/worker/leave", { workerId, kind: "transcode" }).catch(() => undefined);
  });

  void claimLoop();
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

function estimateWorkerMemoryMB(): number {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return nav.deviceMemory ? nav.deviceMemory * 64 : 96;
}
