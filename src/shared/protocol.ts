/**
 * 浏览器与 Node 端共享的协议与类型定义。
 * 本文件只包含 interface/type 与字面量常量，可被 Node 原生 TS 剥离直接加载。
 */

export type TaskKind = "upload" | "proxy" | "output" | "transcode";

export type TaskState =
  | "queued" // 排队中，等待资源
  | "starting" // 已准入，执行器启动中
  | "running" // 正在执行
  | "pausing" // 收到暂停信号，等待执行器到达检查点
  | "paused" // 已安全暂停，现场已落盘
  | "cancelling" // 收到取消信号，等待执行器清理
  | "completed" // 成功完成
  | "failed" // 重试耗尽后的最终失败
  | "cancelled"; // 已取消，临时文件已清理

/** 排队/暂停等待原因，直接展示在页面上 */
export type WaitReason =
  | "none"
  | "cpu-quota"
  | "memory-quota"
  | "tmp-disk-quota"
  | "max-concurrency"
  | "priority-wait"
  | "resource-pressure"
  | "retry-backoff"
  | "waiting-worker"
  | "lease-lost";

/** 任务声明的资源需求（峰值配额）与执行参数 */
export interface TaskSpec {
  id: string;
  name: string;
  kind: TaskKind;
  priority: number; // 数字越大优先级越高
  cpu: number; // 需要的 CPU 核数（可为小数）
  memoryMB: number; // 峰值内存配额
  tmpMB: number; // 临时磁盘配额（含目标文件）
  maxRetries: number;
  payload: TaskPayload;
  createdAt: number;
}

export interface TaskPayload {
  /** upload: 源文件路径（data 目录相对路径或绝对路径） */
  sourcePath?: string;
  /** output/proxy/transcode 产物路径（data 目录相对路径） */
  outputPath?: string;
  /** 模拟工作量：处理的分块数量 */
  chunks?: number;
  /** 每块模拟 CPU 忙碌毫秒数 */
  chunkWorkMs?: number;
  /** transcode 专属：画面宽度 */
  width?: number;
  /** transcode 专属：画面高度 */
  height?: number;
  /** transcode 专属：帧率 */
  fps?: number;
  /** transcode 专属：时长秒数 */
  durationSec?: number;
}

/** 任务的持久化运行态（断点恢复就靠它） */
export interface TaskRecord extends TaskSpec {
  state: TaskState;
  waitReason: WaitReason;
  reasonDetail: string;
  attempts: number;
  progress: number; // 0..1
  checkpoint: TaskCheckpoint | null;
  /** 暂停来源：手动暂停保持暂停态；压力暂停在资源缓解后自动重新排队 */
  pauseSource: "manual" | "pressure" | null;
  lastError: string | null;
  leasedBy: string | null; // 当前持有执行租约的 worker id
  leaseExpiresAt: number | null;
  notBefore: number; // 重试退避 / 重新调度最早时间戳
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** 检查点：执行器在安全点写入，保证恢复后不产生半个文件 */
export interface TaskCheckpoint {
  chunk: number; // 已完成的 chunk 序号（下一个从该值开始）
  /** 已安全落盘的分段文件（相对 staging 目录），恢复后继续追加 */
  segments: string[];
  extra?: Record<string, unknown>;
  savedAt: number;
}

export interface ResourceMetrics {
  timestamp: number;
  cpuCores: number;
  cpuUsed: number; // 整机已用核数（瞬时）
  cpuReserved: number; // 调度器给运行任务预留的核数
  memoryTotalMB: number;
  memoryUsedMB: number; // 整机进程级内存占用估算
  memoryReservedMB: number; // 任务预留内存之和
  tmpTotalMB: number;
  tmpUsedMB: number; // data/staging 实际占用
  tmpReservedMB: number;
  pressure: "none" | "memory" | "tmp" | "cpu";
}

export interface QuotaConfig {
  maxCpuCores: number;
  maxMemoryMB: number;
  maxTmpMB: number;
  maxConcurrent: number;
  /** 内存实际占用达到配额的该比例时触发安全暂停 */
  memoryPressureRatio: number;
  /** 临时磁盘实际占用达到配额的该比例时触发安全暂停 */
  tmpPressureRatio: number;
  /** CPU 使用率达到该比例时触发安全暂停 */
  cpuPressureRatio: number;
}

/** 调度器每个周期产生的决策，用于页面展示“为什么还在等” */
export interface ScheduleDecision {
  at: number;
  taskId: string | null;
  action: "admit" | "pause" | "resume" | "reject" | "wait" | "retry-later" | "lease-reclaim";
  reason: WaitReason;
  detail: string;
}

export type SseEvent =
  | { type: "snapshot"; tasks: TaskRecord[]; metrics: ResourceMetrics; quota: QuotaConfig; decisions: ScheduleDecision[] }
  | { type: "task-upsert"; task: TaskRecord }
  | { type: "metrics"; metrics: ResourceMetrics }
  | { type: "decision"; decision: ScheduleDecision };

/** 浏览器 Worker 拉取/回报任务用的 HTTP 请求体 */
export interface ClaimRequest {
  workerId: string;
  kind: TaskKind;
}

export interface ClaimResponse {
  task: TaskRecord | null;
}

export interface ProgressReport {
  taskId: string;
  workerId: string;
  checkpoint: TaskCheckpoint;
  progress: number;
  /** 该 worker 自测的实际内存占用 MB，用于压力判断 */
  residentMB: number;
}

export interface FinishReport {
  taskId: string;
  workerId: string;
  checkpoint: TaskCheckpoint;
  error?: string;
}

export interface ApiResult {
  ok: boolean;
  error?: string;
  task?: TaskRecord;
}
