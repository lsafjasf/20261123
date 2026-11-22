import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoundReport,
  detectSeqGaps,
  jitter,
  percentile,
  stageDurations,
  totalLatency,
} from '../src/shared/analytics.ts';
import type { DropEvent, MarkerTimeline } from '../src/shared/types.ts';

function marker(partial: Partial<MarkerTimeline>): MarkerTimeline {
  return {
    roundId: 'r1',
    seq: 0,
    t0Marker: 0,
    t1Captured: null,
    t2Processed: null,
    t3Encoded: null,
    t4ServerRx: null,
    t5ServerTx: null,
    t6ClientRx: null,
    t7Decoded: null,
    t8Output: null,
    ...partial,
  };
}

test('分段耗时与总延迟按时间点差值计算', () => {
  const m = marker({
    t0Marker: 0,
    t1Captured: 10,
    t2Processed: 14,
    t3Encoded: 20,
    t6ClientRx: 55,
    t7Decoded: 70,
    t8Output: 95,
  });
  const d = stageDurations(m);
  assert.equal(d.capture, 10);
  assert.equal(d.process, 4);
  assert.equal(d.upload, 35);
  assert.equal(d.decode, 15);
  assert.equal(d.output, 25);
  assert.equal(totalLatency(m), 95);
});

test('缺失端点返回 null', () => {
  const d = stageDurations(marker({ t0Marker: 0 }));
  assert.equal(d.capture, null);
  assert.equal(totalLatency(marker({ t0Marker: 0 })), null);
});

test('百分位与抖动', () => {
  const values = [10, 12, 11, 14, 9, 13];
  const sorted = [...values].sort((a, b) => a - b);
  assert.equal(percentile(sorted, 50), 11.5);
  assert.equal(percentile(sorted, 0), 9);
  assert.equal(percentile(sorted, 100), 14);
  const stable = jitter([5, 5, 5, 5]);
  assert.equal(stable, 0);
  assert.ok(jitter(values) > 0);
});

test('轮次报告指出最慢环节并统计丢样', () => {
  const markers: MarkerTimeline[] = [
    marker({
      seq: 0,
      t0Marker: 0,
      t1Captured: 5,
      t2Processed: 8,
      t3Encoded: 12,
      t6ClientRx: 40,
      t7Decoded: 45,
      t8Output: 50,
    }),
    marker({
      seq: 1,
      t0Marker: 100,
      t1Captured: 106,
      t2Processed: 109,
      t3Encoded: 113,
      t6ClientRx: 160,
      t7Decoded: null,
      t8Output: null,
    }),
  ];
  const drops: DropEvent[] = [
    {
      roundId: 'r1',
      at: 200,
      stage: 'decode',
      detail: '解码失败',
      expectedSeq: 1,
    },
  ];
  const report = buildRoundReport({
    roundId: 'r1',
    label: '第一轮',
    startedAt: 0,
    closedAt: 300,
    markers,
    drops,
    clockOffsetMs: 0.2,
    clockRttMs: 1.1,
  });
  assert.equal(report.markerCount, 2);
  assert.equal(report.matchedMarkers, 1);
  assert.equal(report.slowestStage, 'upload');
  const decode = report.stages.find((s) => s.stage === 'decode');
  assert.equal(decode?.droppedSamples, 2);
  assert.equal(report.droppedTotal, 1);
  assert.equal(report.totalLatency.meanMs, 50);
});

test('序号缺口检测生成丢样事件', () => {
  const events = detectSeqGaps('r1', [0, 1, 4, 5], 'network', 500);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.expectedSeq),
    [2, 3],
  );
});
