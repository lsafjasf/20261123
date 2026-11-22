import type {
  QuotaConfig,
  ResourceMetrics,
  ScheduleDecision,
  SseEvent,
  TaskRecord,
  TaskSpec,
} from "../shared/protocol.ts";
import { drawChart } from "./chart.ts";
import { startTranscodeWorker } from "./transcodeClient.ts";
import { initMsePreview } from "./msePreview.ts";

const state = {
  tasks: new Map<string, TaskRecord>(),
  metrics: [] as ResourceMetrics[],
  decisions: [] as ScheduleDecision[],
  quota: null as QuotaConfig | null,
};

const tbody = document.querySelector("#task-tbody") as HTMLTableSectionElement;
const decisionList = document.querySelector("#decision-list") as HTMLUListElement;
const chart = document.querySelector("#resource-chart") as HTMLCanvasElement;
const legend = document.querySelector("#chart-legend") as HTMLDivElement;
const workerStatus = document.querySelector("#worker-status") as HTMLDivElement;

const WAIT_REASON_TEXT: Record<string, string> = {
  none: "—",
  "cpu-quota": "等待 CPU 配额",
  "memory-quota": "等待内存配额",
  "tmp-disk-quota": "等待临时磁盘配额",
  "max-concurrency": "等待并发槽位",
  "priority-wait": "高优先级任务先行",
  "resource-pressure": "整机资源压力，安全让路",
  "retry-backoff": "失败重试退避中",
  "waiting-worker": "等待 WebCodecs Worker",
  "lease-lost": "执行租约失效，重新排队",
};

const STATE_TEXT: Record<string, string> = {
  queued: "排队中",
  starting: "启动中",
  running: "运行中",
  pausing: "暂停中",
  paused: "已暂停",
  cancelling: "取消中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function connectSse(): void {
  const source = new EventSource("/api/events");
  source.onmessage = (message) => {
    const event = JSON.parse(message.data) as SseEvent;
    handleEvent(event);
  };
  source.onerror = () => {
    workerStatus.textContent = "SSE 连接中断，自动重连中…";
    workerStatus.className = "worker-status";
  };
}

function handleEvent(event: SseEvent): void {
  if (event.type === "snapshot") {
    state.tasks = new Map(event.tasks.map((task) => [task.id, task]));
    state.metrics = event.metrics ? [event.metrics] : [];
    state.decisions = event.decisions;
    state.quota = event.quota;
    renderAll();
  } else if (event.type === "task-upsert") {
    state.tasks.set(event.task.id, event.task);
    renderTasks();
  } else if (event.type === "metrics") {
    state.metrics.push(event.metrics);
    if (state.metrics.length > 120) state.metrics.shift();
    renderChart();
  } else if (event.type === "decision") {
    state.decisions.push(event.decision);
    if (state.decisions.length > 80) state.decisions.shift();
    renderDecisions();
  }
}

function renderAll(): void {
  renderTasks();
  renderDecisions();
  renderChart();
  legend.innerHTML =
    '<span class="l-cpu">CPU 已用/预留</span><span class="l-mem">内存已用/预留</span><span class="l-tmp">临时盘已用/预留</span>';
}

function renderChart(): void {
  if (state.quota) drawChart(chart, state.metrics, state.quota);
}

function renderDecisions(): void {
  decisionList.innerHTML = "";
  for (const decision of [...state.decisions].reverse().slice(0, 40)) {
    const item = document.createElement("li");
    const time = new Date(decision.at).toLocaleTimeString("zh-CN");
    const task = decision.taskId ? state.tasks.get(decision.taskId)?.name ?? decision.taskId : "调度器";
    item.innerHTML =
      `${time} <b>${task}</b> <span class="action">${decision.action}</span>` +
      `<span class="reason">${WAIT_REASON_TEXT[decision.reason] ?? decision.reason}</span>${decision.detail}`;
    decisionList.append(item);
  }
}

function renderTasks(): void {
  const tasks = [...state.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  tbody.innerHTML = "";
  for (const task of tasks) {
    const row = document.createElement("tr");
    const percent = Math.round(task.progress * 100);
    const canPause = task.state === "queued" || task.state === "running" || task.state === "starting";
    const canResume = task.state === "paused";
    const canCancel = !["completed", "failed", "cancelled"].includes(task.state);
    row.innerHTML = `
      <td>${task.name}<div class="reason-detail">${task.id}</div></td>
      <td><span class="kind-tag">${task.kind}</span></td>
      <td>${task.priority}</td>
      <td><span class="badge state-${task.state}">${STATE_TEXT[task.state] ?? task.state}</span></td>
      <td class="progress-cell">${percent}%
        <div class="progress-track"><div class="progress-fill ${percent === 100 ? "done" : ""}" style="width:${percent}%"></div></div>
      </td>
      <td>
        <div class="wait-reason ${task.waitReason === "none" ? "none" : ""}">${WAIT_REASON_TEXT[task.waitReason] ?? task.waitReason}</div>
        <div class="reason-detail">${task.reasonDetail}</div>
        ${task.lastError ? `<div class="reason-detail" style="color:var(--red)">${task.lastError}</div>` : ""}
      </td>
      <td>${task.attempts}/${task.maxRetries + 1}</td>
      <td class="actions">
        <button class="ghost" data-action="pause" ${canPause ? "" : "disabled"}>暂停</button>
        <button class="ghost" data-action="resume" ${canResume ? "" : "disabled"}>恢复</button>
        <button class="danger" data-action="cancel" ${canCancel ? "" : "disabled"}>取消</button>
      </td>`;
    row.querySelector("[data-action=pause]")?.addEventListener("click", () => control(task.id, "pause"));
    row.querySelector("[data-action=resume]")?.addEventListener("click", () => control(task.id, "resume"));
    row.querySelector("[data-action=cancel]")?.addEventListener("click", () => control(task.id, "cancel"));
    tbody.append(row);
  }
}

async function control(taskId: string, action: string): Promise<void> {
  await fetch(`/api/tasks/${taskId}/${action}`, { method: "POST" });
}

async function submitTask(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const baseName = String(data.get("name")).replace(/[^\w.-]/g, "_");
  const kind = String(data.get("kind"));
  const spec = {
    name: String(data.get("name")),
    kind,
    priority: Number(data.get("priority")),
    cpu: Number(data.get("cpu")),
    memoryMB: Number(data.get("memoryMB")),
    tmpMB: Number(data.get("tmpMB")),
    maxRetries: Number(data.get("maxRetries")),
    payload: {
      chunks: Number(data.get("chunks")),
      chunkWorkMs: Number(data.get("chunkWorkMs")),
      outputPath: `outputs/${baseName}.${kind === "transcode" ? "webm" : "dat"}`,
      width: 320,
      height: 180,
      fps: 15,
      durationSec: 6,
    },
  } as Omit<TaskSpec, "id" | "createdAt">;
  const response = await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
  });
  const result = await response.json();
  if (!result.ok) alert(`提交被拒绝: ${result.error}`);
}

document.querySelector("#submit-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitTask(event.currentTarget as HTMLFormElement);
});

connectSse();
startTranscodeWorker({
  onStatus: (online: boolean) => {
    workerStatus.textContent = online
      ? "WebCodecs Worker: 在线（可领取 transcode 任务）"
      : "WebCodecs Worker: 未连接";
    workerStatus.className = online ? "worker-status online" : "worker-status";
  },
});

initMsePreview({
  videoId: "mse-preview",
  selectId: "preview-select",
  buttonId: "preview-load",
  statusId: "preview-status",
});
