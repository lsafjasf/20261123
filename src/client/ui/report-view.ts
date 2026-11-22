/**
 * 报告 DOM 渲染。所有渲染函数只处理传入的单个轮次数据，
 * 从结构上保证不同轮次的报告不会互相覆盖或混合。
 */

import { STAGE_IDS, STAGE_LABELS } from '../../shared/types.ts';
import type {
  DropEvent,
  MarkerTimeline,
  RoundReport,
  StageId,
} from '../../shared/types.ts';
import { stageDurations, totalLatency } from '../../shared/analytics.ts';
import { drawStageBars } from './charts.ts';

export function renderSummary(
  container: HTMLElement,
  report: RoundReport,
): void {
  const slowest = report.slowestStage
    ? STAGE_LABELS[report.slowestStage]
    : '数据不足';
  container.innerHTML = `
    <div class="metric-grid">
      ${metric('标记总数', String(report.markerCount))}
      ${metric('完整匹配', String(report.matchedMarkers))}
      ${metric('平均总延迟', `${report.totalLatency.meanMs.toFixed(1)} ms`)}
      ${metric('P95 总延迟', `${report.totalLatency.p95Ms.toFixed(1)} ms`)}
      ${metric('总抖动', `${report.totalLatency.jitterMs.toFixed(2)} ms`)}
      ${metric('丢样总数', String(report.droppedTotal))}
      ${metric('时钟 RTT', `${report.clock.rttMs.toFixed(2)} ms`)}
      ${metric('时钟偏移', `${report.clock.offsetMs.toFixed(2)} ms`)}
    </div>
    <p>最慢环节：<span class="pill">${slowest}</span>
    （按各分段平均耗时判定）</p>
  `;
}

function metric(label: string, value: string): string {
  return `<div class="metric"><div class="value">${value}</div>
    <div class="label">${label}</div></div>`;
}

export function renderMarkerTable(
  table: HTMLTableElement,
  markers: MarkerTimeline[],
  slowestStage: StageId | null,
): void {
  const body = table.querySelector('tbody');
  if (!body) {
    return;
  }
  body.innerHTML = '';
  for (const marker of markers) {
    const durations = stageDurations(marker);
    const total = totalLatency(marker);
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${marker.seq}</td>
      <td>${total === null ? '—' : total.toFixed(1)}</td>
      ${STAGE_IDS.map((stage) => {
        const value = durations[stage];
        const highlight = slowestStage === stage ? 'font-weight:700;color:#b91c1c' : '';
        return `<td style="${highlight}">${
          value === null ? '—' : value.toFixed(1)
        }</td>`;
      }).join('')}
    `;
    body.appendChild(row);
  }
}

export function renderDropList(
  list: HTMLElement,
  drops: DropEvent[],
): void {
  list.innerHTML = '';
  if (drops.length === 0) {
    list.innerHTML = '<li>未观测到丢样</li>';
    return;
  }
  for (const event of drops) {
    const item = document.createElement('li');
    item.textContent = `[${event.stage}] ${event.detail}（t=${event.at.toFixed(1)}）`;
    list.appendChild(item);
  }
}

export function renderReport(
  report: RoundReport,
  markers: MarkerTimeline[],
  drops: DropEvent[],
  elements: {
    roundId: HTMLElement;
    summary: HTMLElement;
    bars: HTMLCanvasElement;
    table: HTMLTableElement;
    dropList: HTMLElement;
  },
): void {
  elements.roundId.textContent = report.roundId;
  renderSummary(elements.summary, report);
  drawStageBars(elements.bars, report);
  renderMarkerTable(elements.table, markers, report.slowestStage);
  renderDropList(elements.dropList, drops);
}

export function downloadJson(report: RoundReport, markers: MarkerTimeline[]): void {
  const payload = { report, markers };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `latency-report-${report.roundId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
