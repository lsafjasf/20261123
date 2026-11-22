import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import type { QuotaConfig } from "../shared/protocol.ts";

export const DATA_ROOT = join(process.cwd(), "data");
export const STAGING_DIR = join(DATA_ROOT, "staging");
export const OUTPUT_DIR = join(DATA_ROOT, "outputs");
export const UPLOAD_DIR = join(DATA_ROOT, "files");
export const STATE_DIR = join(DATA_ROOT, "state");
export const STATE_FILE = join(STATE_DIR, "tasks.json");
export const DECISIONS_FILE = join(STATE_DIR, "decisions.log");

/**
 * 默认配额按本机资源换算并留出系统余量。
 * 转码机同时跑上传/代理/成片，需要给操作系统与浏览器预留约 30% 内存。
 */
export function defaultQuota(): QuotaConfig {
  const totalMemMB = Math.floor(totalmem() / 1024 / 1024);
  return {
    maxCpuCores: Math.max(1, cpus().length - 2),
    maxMemoryMB: Math.floor(totalMemMB * 0.7),
    maxTmpMB: 4 * 1024,
    maxConcurrent: Math.max(2, cpus().length - 4),
    memoryPressureRatio: 0.9,
    tmpPressureRatio: 0.92,
    cpuPressureRatio: 0.95,
  };
}

export const SCHEDULER_TICK_MS = 500;
export const METRICS_SAMPLE_MS = 1000;
export const METRICS_HISTORY = 180;
export const LEASE_MS = 15_000;
export const LEASE_RENEW_MS = 5_000;
export const DECISION_HISTORY = 200;

/** 单任务允许申请的资源上限，防止一个任务直接吃光配额 */
export const PER_TASK_LIMITS = {
  cpu: 8,
  memoryMB: 4096,
  tmpMB: 2048,
} as const;

export const RETRY_BASE_DELAY_MS = 1000;
export const RETRY_MAX_DELAY_MS = 30_000;
export const PRIORITY_AGING_MS = 4000; // 每等待 4s 等效优先级 +1，防止低优先级饿死
