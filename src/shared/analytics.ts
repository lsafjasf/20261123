/**
 * 测量分析纯函数：把标记时间线汇总为分段统计与轮次报告。
 * 不接触 DOM，可在 Node 测试中直接运行。
 */

import { STAGE_IDS, STAGE_LABELS } from './types.ts';
import type {
  DropEvent,
  MarkerTimeline,
  RoundReport,
  StageId,
  StageStats,
} from './types.ts';

/** 单个标记在某一段上的耗时（毫秒）；端点缺失时为 null。 */
export type StageDurationMap = Record<StageId, number | null>;

export function stageDurations(marker: MarkerTimeline): StageDurationMap {
  return {
    capture: diff(marker.t0Marker, marker.t1Captured),
    process: diff(marker.t1Captured, marker.t2Processed),
    upload: diff(marker.t3Encoded, marker.t6ClientRx),
    decode: diff(marker.t6ClientRx, marker.t7Decoded),
    output: diff(marker.t7Decoded, marker.t8Output),
  };
}

/** 端到端总延迟：T0 闪光/声响 -> T8 声卡输出。 */
export function totalLatency(marker: MarkerTimeline): number | null {
  return diff(marker.t0Marker, marker.t8Output);
}

function diff(a: number | null, b: number | null): number | null {
  if (a === null || b === null) {
    return null;
  }
  return b - a;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) {
    return sorted[low];
  }
  const weight = rank - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const avg = mean(values);
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

/** 抖动：相邻样本一阶差分的标准差，刻画逐标记的耗时波动。 */
export function jitter(values: number[]): number {
  if (values.length < 3) {
    return 0;
  }
  const deltas: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    deltas.push(values[i] - values[i - 1]);
  }
  return stdDev(deltas);
}

export function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    meanMs: mean(values),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    jitterMs: jitter(values),
  };
}

/** 按阶段归类丢样事件数量。 */
export function dropsByStage(events: DropEvent[]): Record<StageId, number> {
  const counts = Object.fromEntries(
    STAGE_IDS.map((id) => [id, 0]),
  ) as Record<StageId, number>;
  for (const event of events) {
    if (event.stage !== 'network' && event.stage in counts) {
      counts[event.stage as StageId] += 1;
    }
  }
  return counts;
}

export interface BuildReportInput {
  roundId: string;
  label: string;
  startedAt: number;
  closedAt: number | null;
  markers: MarkerTimeline[];
  drops: DropEvent[];
  clockOffsetMs: number;
  clockRttMs: number;
}

export function buildRoundReport(input: BuildReportInput): RoundReport {
  const markers = [...input.markers].sort((a, b) => a.seq - b.seq);
  const dropCounts = dropsByStage(input.drops);

  const stages: StageStats[] = STAGE_IDS.map((stage) => {
    const values: number[] = [];
    let dropped = dropCounts[stage];
    for (const marker of markers) {
      const duration = stageDurations(marker)[stage];
      if (duration === null) {
        dropped += 1;
      } else {
        values.push(duration);
      }
    }
    const summary = summarize(values);
    return {
      stage,
      label: STAGE_LABELS[stage],
      ...summary,
      droppedSamples: dropped,
    };
  });

  const totals = markers
    .map(totalLatency)
    .filter((v): v is number => v !== null);
  const totalSummary = summarize(totals);

  let slowestStage: StageId | null = null;
  let slowestMean = -1;
  for (const stats of stages) {
    if (stats.samples > 0 && stats.meanMs > slowestMean) {
      slowestMean = stats.meanMs;
      slowestStage = stats.stage;
    }
  }

  return {
    roundId: input.roundId,
    label: input.label,
    startedAt: input.startedAt,
    closedAt: input.closedAt,
    markerCount: markers.length,
    matchedMarkers: totals.length,
    totalLatency: totalSummary,
    stages,
    slowestStage,
    droppedTotal: input.drops.length,
    clock: {
      offsetMs: input.clockOffsetMs,
      rttMs: input.clockRttMs,
    },
  };
}

/** 从一序列标记中检测序号缺口，生成丢样事件。 */
export function detectSeqGaps(
  roundId: string,
  receivedSeqs: number[],
  stage: StageId | 'network',
  now: number,
): DropEvent[] {
  if (receivedSeqs.length < 2) {
    return [];
  }
  const sorted = [...new Set(receivedSeqs)].sort((a, b) => a - b);
  const events: DropEvent[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i] - sorted[i - 1] - 1;
    for (let missing = 0; missing < gap; missing += 1) {
      events.push({
        roundId,
        at: now,
        stage,
        detail: `序号 ${sorted[i - 1] + missing + 1} 缺失`,
        expectedSeq: sorted[i - 1] + missing + 1,
      });
    }
  }
  return events;
}
