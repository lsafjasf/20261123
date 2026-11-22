import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import type { ResourceMetrics } from "../shared/protocol.ts";
import { METRICS_HISTORY, METRICS_SAMPLE_MS, STAGING_DIR } from "./config.ts";
import { dirSizeBytes, ensureDir } from "./util/atomic.ts";

interface ProcStat {
  idle: number;
  total: number;
}

async function readProcStat(): Promise<ProcStat> {
  const content = await readFile("/proc/stat", "utf8");
  const line = content.split("\n")[0]!;
  const parts = line.split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
  const total = parts.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  return { idle, total };
}

async function readMemInfoMB(): Promise<{ total: number; available: number }> {
  const content = await readFile("/proc/meminfo", "utf8");
  const map = new Map<string, number>();
  for (const line of content.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s+kB/.exec(line);
    if (match) map.set(match[1], Number(match[2]));
  }
  const total = (map.get("MemTotal") ?? 0) / 1024;
  const available = (map.get("MemAvailable") ?? 0) / 1024;
  return { total, available };
}

async function readTmpUsedMB(): Promise<number> {
  await ensureDir(STAGING_DIR);
  const bytes = await dirSizeBytes(STAGING_DIR);
  return bytes / 1024 / 1024;
}

/**
 * 资源采样器：每秒一次，保留最近 METRICS_HISTORY 条，
 * 供调度器压力判断与页面资源曲线使用。
 */
export class MetricsMonitor {
  readonly history: ResourceMetrics[] = [];
  private previous: ProcStat | null = null;
  private timer: NodeJS.Timeout | null = null;

  private readonly limits: {
    maxCpuCores: number;
    maxMemoryMB: number;
    maxTmpMB: number;
    memoryPressureRatio: number;
    tmpPressureRatio: number;
    cpuPressureRatio: number;
  };
  private readonly reservationProvider: () => {
    cpu: number;
    memoryMB: number;
    tmpMB: number;
    residentMB: number;
  };

  constructor(
    limits: {
      maxCpuCores: number;
      maxMemoryMB: number;
      maxTmpMB: number;
      memoryPressureRatio: number;
      tmpPressureRatio: number;
      cpuPressureRatio: number;
    },
    reservationProvider: () => {
      cpu: number;
      memoryMB: number;
      tmpMB: number;
      residentMB: number;
    },
  ) {
    this.limits = limits;
    this.reservationProvider = reservationProvider;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sample().catch((err) => console.error("metrics sample failed:", err));
    }, METRICS_SAMPLE_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sample(): Promise<ResourceMetrics> {
    const now = Date.now();
    const stat = await readProcStat();
    let cpuRatio = 0;
    if (this.previous) {
      const totalDelta = stat.total - this.previous.total;
      const idleDelta = stat.idle - this.previous.idle;
      cpuRatio = totalDelta > 0 ? 1 - idleDelta / totalDelta : 0;
    }
    this.previous = stat;

    const memInfo = await readMemInfoMB();
    const reservation = this.reservationProvider();
    const tmpUsed = await readTmpUsedMB();
    const memoryUsed = memInfo.total - memInfo.available;

    let pressure: ResourceMetrics["pressure"] = "none";
    // 压力判断与调度配额同口径：本调度器管辖的预留量逼近配额即触发；
    // 整机物理内存仅作展示，避免同机其他进程误伤本调度器的任务。
    const reservedMemory = reservation.memoryMB + reservation.residentMB;
    if (reservedMemory >= this.limits.maxMemoryMB * this.limits.memoryPressureRatio) {
      pressure = "memory";
    } else if (
      reservation.tmpMB >= this.limits.maxTmpMB * this.limits.tmpPressureRatio ||
      tmpUsed >= this.limits.maxTmpMB * this.limits.tmpPressureRatio
    ) {
      pressure = "tmp";
    } else if (cpuRatio >= this.limits.cpuPressureRatio) {
      pressure = "cpu";
    }

    const metrics: ResourceMetrics = {
      timestamp: now,
      cpuCores: cpus().length,
      cpuUsed: Math.max(0, cpuRatio * cpus().length),
      cpuReserved: reservation.cpu,
      memoryTotalMB: memInfo.total,
      memoryUsedMB: memoryUsed,
      memoryReservedMB: Math.max(reservation.memoryMB, reservation.residentMB),
      tmpTotalMB: this.limits.maxTmpMB,
      tmpUsedMB: tmpUsed,
      tmpReservedMB: reservation.tmpMB,
      pressure,
    };
    this.history.push(metrics);
    if (this.history.length > METRICS_HISTORY) this.history.shift();
    return metrics;
  }

  latest(): ResourceMetrics | null {
    return this.history[this.history.length - 1] ?? null;
  }
}
