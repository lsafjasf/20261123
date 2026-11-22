import type { QuotaConfig, ResourceMetrics } from "../shared/protocol.ts";

/**
 * 纯 Canvas 资源曲线：CPU/内存/临时盘各画“实际用量”实线与“调度预留”虚线，
 * 数值按各自配额归一化到 0..1，压力区间用红色背景标出。
 */
export function drawChart(
  canvas: HTMLCanvasElement,
  history: ResourceMetrics[],
  quota: QuotaConfig,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);

  const padding = { left: 46, right: 12, top: 14, bottom: 26 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  context.strokeStyle = "#283350";
  context.lineWidth = 1;
  context.fillStyle = "#8b97ad";
  context.font = "11px sans-serif";
  for (let ratio = 0; ratio <= 4; ratio++) {
    const y = padding.top + (plotHeight * ratio) / 4;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillText(`${100 - ratio * 25}%`, 8, y + 4);
  }

  if (history.length === 0) {
    context.fillStyle = "#8b97ad";
    context.fillText("等待采样数据…", padding.left + 12, padding.top + 24);
    return;
  }

  for (const metrics of history) {
    if (metrics.pressure === "none") continue;
    const x = pointX(history.indexOf(metrics), history.length, plotWidth, padding.left);
    context.fillStyle = "rgba(239,100,100,0.12)";
    context.fillRect(x, padding.top, plotWidth / Math.max(1, history.length - 1) + 1, plotHeight);
  }

  const series: Array<{
    color: string;
    used: (metrics: ResourceMetrics) => number;
    reserved: (metrics: ResourceMetrics) => number;
    limit: number;
  }> = [
    {
      color: "#4f8cff",
      used: (metrics) => metrics.cpuUsed,
      reserved: (metrics) => metrics.cpuReserved,
      limit: metricsCpuLimit(quota),
    },
    {
      color: "#35c48d",
      used: (metrics) => metrics.memoryUsedMB,
      reserved: (metrics) => metrics.memoryReservedMB,
      limit: quota.maxMemoryMB,
    },
    {
      color: "#f0b450",
      used: (metrics) => metrics.tmpUsedMB,
      reserved: (metrics) => metrics.tmpReservedMB,
      limit: quota.maxTmpMB,
    },
  ];

  for (const item of series) {
    drawLine(
      context,
      history,
      plotWidth,
      plotHeight,
      padding,
      (metrics) => clamp01(item.used(metrics) / item.limit),
      item.color,
      false,
    );
    drawLine(
      context,
      history,
      plotWidth,
      plotHeight,
      padding,
      (metrics) => clamp01(item.reserved(metrics) / item.limit),
      item.color,
      true,
    );
  }

  const latest = history[history.length - 1]!;
  const labels = [
    `CPU ${latest.cpuUsed.toFixed(1)}/${quota.maxCpuCores} 核`,
    `内存 ${Math.round(latest.memoryUsedMB)}/${quota.maxMemoryMB} MB`,
    `临时盘 ${Math.round(latest.tmpUsedMB)}/${quota.maxTmpMB} MB`,
  ];
  context.fillStyle = "#e6ebf5";
  labels.forEach((label, index) => {
    context.fillStyle = series[index]!.color;
    context.fillText(label, padding.left + index * 240, height - 8);
  });
}

function metricsCpuLimit(quota: QuotaConfig): number {
  return quota.maxCpuCores;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function pointX(index: number, length: number, plotWidth: number, left: number): number {
  if (length <= 1) return left;
  return left + (plotWidth * index) / (length - 1);
}

function drawLine(
  context: CanvasRenderingContext2D,
  history: ResourceMetrics[],
  plotWidth: number,
  plotHeight: number,
  padding: { left: number; top: number },
  valueOf: (metrics: ResourceMetrics) => number,
  color: string,
  dashed: boolean,
): void {
  context.save();
  context.strokeStyle = color;
  context.lineWidth = dashed ? 1.2 : 2;
  context.setLineDash(dashed ? [5, 4] : []);
  context.globalAlpha = dashed ? 0.65 : 1;
  context.beginPath();
  history.forEach((metrics, index) => {
    const x = pointX(index, history.length, plotWidth, padding.left);
    const y = padding.top + plotHeight * (1 - clamp01(valueOf(metrics)));
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
  context.restore();
}
