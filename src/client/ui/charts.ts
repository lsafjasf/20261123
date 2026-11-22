/**
 * Canvas 图表：分段耗时折线图与分段平均耗时柱状图。
 * 纯 2D Canvas 绘制，无第三方依赖。
 */

import { STAGE_IDS, STAGE_LABELS } from '../../shared/types.ts';
import type { MarkerTimeline, RoundReport, StageId } from '../../shared/types.ts';
import { stageDurations } from '../../shared/analytics.ts';

const STAGE_COLORS: Readonly<Record<StageId, string>> = {
  capture: '#4e79a7',
  process: '#59a14f',
  upload: '#e15759',
  decode: '#f28e2b',
  output: '#b07aa1',
};

export function drawStageLines(
  canvas: HTMLCanvasElement,
  markers: MarkerTimeline[],
): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  const padding = { left: 48, right: 16, top: 28, bottom: 36 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  let maxDuration = 1;
  for (const marker of markers) {
    const durations = stageDurations(marker);
    for (const stage of STAGE_IDS) {
      const value = durations[stage];
      if (value !== null && value > maxDuration) {
        maxDuration = value;
      }
    }
  }
  drawGrid(context, width, height, padding, maxDuration);
  if (markers.length < 2) {
    context.fillStyle = '#888';
    context.fillText('至少需要 2 个标记才能绘制趋势', padding.left, height / 2);
    return;
  }
  const xFor = (index: number): number =>
    padding.left + (plotWidth * index) / (markers.length - 1);
  const yFor = (value: number): number =>
    padding.top + plotHeight * (1 - value / maxDuration);

  for (const stage of STAGE_IDS) {
    context.strokeStyle = STAGE_COLORS[stage];
    context.lineWidth = 2;
    context.beginPath();
    let started = false;
    markers.forEach((marker, index) => {
      const value = stageDurations(marker)[stage];
      if (value === null) {
        return;
      }
      const x = xFor(index);
      const y = yFor(value);
      if (!started) {
        context.moveTo(x, y);
        started = true;
      } else {
        context.lineTo(x, y);
      }
    });
    context.stroke();
  }
  drawLegend(context, padding.left, 14);
  context.fillStyle = '#333';
  context.fillText('标记序号 →', width / 2 - 30, height - 10);
}

export function drawStageBars(
  canvas: HTMLCanvasElement,
  report: RoundReport,
): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  const padding = { left: 48, right: 16, top: 20, bottom: 42 };
  const plotHeight = height - padding.top - padding.bottom;
  const max = Math.max(
    1,
    ...report.stages.map((stage) => stage.meanMs),
  );
  const slot = (width - padding.left - padding.right) / report.stages.length;
  const barWidth = slot * 0.6;
  context.strokeStyle = '#ddd';
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotHeight * i) / 4;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillStyle = '#666';
    context.fillText(
      ((max * (4 - i)) / 4).toFixed(0),
      8,
      y + 4,
    );
  }
  report.stages.forEach((stats, index) => {
    const x = padding.left + slot * index + (slot - barWidth) / 2;
    const barHeight = (stats.meanMs / max) * plotHeight;
    const y = padding.top + plotHeight - barHeight;
    context.fillStyle =
      report.slowestStage === stats.stage ? '#d62728' : STAGE_COLORS[stats.stage];
    context.fillRect(x, y, barWidth, barHeight);
    context.fillStyle = '#333';
    context.textAlign = 'center';
    context.fillText(
      `${STAGE_LABELS[stats.stage]}`,
      x + barWidth / 2,
      height - 22,
    );
    context.fillText(
      `${stats.meanMs.toFixed(1)}ms`,
      x + barWidth / 2,
      y - 6,
    );
    context.textAlign = 'start';
  });
}

function drawGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  padding: { left: number; right: number; top: number; bottom: number },
  maxDuration: number,
): void {
  context.strokeStyle = '#e5e5e5';
  context.fillStyle = '#666';
  const plotHeight = height - padding.top - padding.bottom;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotHeight * i) / 4;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillText(
      (maxDuration * (4 - i) / 4).toFixed(0),
      8,
      y + 4,
    );
  }
}

function drawLegend(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
): void {
  let offset = x;
  for (const stage of STAGE_IDS) {
    context.fillStyle = STAGE_COLORS[stage];
    context.fillRect(offset, y, 10, 10);
    context.fillStyle = '#333';
    context.fillText(STAGE_LABELS[stage], offset + 14, y + 9);
    offset += context.measureText(STAGE_LABELS[stage]).width + 46;
  }
}
