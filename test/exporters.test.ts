import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exportAll,
  exportEdl,
  exportLabelsCsv,
  exportSegmentsCsv,
  exportShotsCsv,
} from '../src/shared/exporters.ts';
import { analyzeBundle } from '../src/shared/engine.ts';
import { buildBundle, FIXTURE_SPECS } from '../src/server/fixtures.ts';
import { frameToTimecode, parseTimecode } from '../src/shared/timecode.ts';

const result = analyzeBundle(buildBundle(FIXTURE_SPECS[7]));

test('时间码：帧号往返一致，非丢帧格式 HH:MM:SS:FF', () => {
  const tc = frameToTimecode(3600 * 30 + 62 * 30 + 15, 30);
  assert.equal(tc, '01:01:02:15');
  assert.equal(parseTimecode(tc, 30), 3600 * 30 + 62 * 30 + 15);
  assert.equal(frameToTimecode(0, 29.97), '00:00:00:00');
});

test('labels.csv：表头固定、标签中文映射之外字段齐全', () => {
  const csv = exportLabelsCsv(result);
  const [header, ...rows] = csv.trim().split('\n');
  assert.equal(header, 'file,sha256,label,severity,coverage,occurrences,duration_sec');
  assert.equal(rows.length, result.labels.length);
});

test('segments.csv：按起始帧排序并包含中文类型', () => {
  const csv = exportSegmentsCsv(result);
  assert.ok(csv.includes('黑场'));
  assert.ok(csv.includes('静止'));
  assert.ok(csv.includes('抖动'));
});

test('shots.csv：镜头编号连续且带同事分配', () => {
  const csv = exportShotsCsv(result);
  const rows = csv.trim().split('\n').slice(1);
  rows.forEach((row, index) => {
    assert.ok(row.includes(`${index + 1}`));
  });
  assert.ok(rows.some((row) => row.includes('剪辑-')));
});

test('EDL：CMX 3600 头与事件序号格式合法', () => {
  const edl = exportEdl(result);
  assert.ok(edl.startsWith('TITLE:'));
  assert.ok(edl.includes('FCM: NON-DROP FRAME'));
  assert.ok(edl.includes('001'));
  assert.ok(edl.includes('V     C'));
});

test('导出字节稳定：相同结果两次导出完全一致', () => {
  const a = exportAll(result);
  const b = exportAll(result);
  assert.deepEqual(a, b);
});
