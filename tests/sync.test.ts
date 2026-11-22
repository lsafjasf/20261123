import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrameIndex, buildMapping, mapEvents, mapLogToVideo, videoTimeToFrame, eventsToCsv } from '../src/shared/sync.ts';
import { parseLog, detectStartup, detectRuns, matchCombos } from '../src/shared/logparse.ts';
import type { Anchor } from '../src/shared/types.ts';
import { momentView } from '../src/shared/viewmodel.ts';

// 构造 VFR + 暂停 + 掉帧的帧序列
function makeFrames(): number[] {
  const pts: number[] = [];
  let t = 0;
  // 0-30s @60fps
  while (t < 30000) { pts.push(t); t += 1000 / 60; }
  // 录制暂停 3s：PTS 直接跳到 33000
  t = 33000;
  // 30-60s @60fps 但周期性掉帧
  let i = 0;
  while (t < 60000) {
    if (i % 37 !== 0) pts.push(Math.round(t * 100) / 100);
    t += 1000 / 60; i++;
  }
  // 60-90s VFR 20~24fps
  while (t < 90000) { pts.push(Math.round(t * 100) / 100); t += 1000 / (20 + (i++ % 5)); }
  return pts;
}

test('帧索引：VFR/掉帧/暂停识别', () => {
  const idx = buildFrameIndex(makeFrames());
  assert.equal(idx.pauses.length, 1);
  const pause = idx.pauses[0];
  assert.ok(pause.gapMs > 2900 && pause.gapMs < 3100, `gap=${pause.gapMs}`);
  assert.ok(Math.abs(idx.medianFrameMs - 1000 / 60) < 0.5);
  // videoTimeToFrame 在暂停间隙中应落到间隙前的最后一帧
  const gapStart = idx.frames[pause.afterFrame].pts;
  assert.equal(videoTimeToFrame(idx, gapStart + 1500), pause.afterFrame);
});

test('分段映射：单锚点外推 + 双锚点线性', () => {
  const idx = buildFrameIndex(makeFrames());
  const anchors: Anchor[] = [
    { id: 'a1', logT: 41000, videoT: 1000, kind: 'startup', weight: 1 },
    { id: 'a2', logT: 60000, videoT: 20000, kind: 'run', weight: 1 },
  ];
  const m = buildMapping(anchors, idx);
  // 段数 = 外推头 + 1 内插 + 外推尾
  assert.equal(m.segments.length, 3);
  const { videoT } = mapLogToVideo(m, 51000);
  assert.ok(Math.abs(videoT - 11000) < 1);
  // 外推区置信度低
  const head = mapLogToVideo(m, 0);
  assert.ok(head.seg.confidence < 0.5);
  assert.ok(head.seg.flags.includes('extrapolated'));
});

test('暂停两侧锚点修正零点漂移', () => {
  const idx = buildFrameIndex(makeFrames());
  // 录制跳 PTS 而日志连续：暂停后偏移改变，需要分段
  const anchors: Anchor[] = [
    { id: 'a1', logT: 10000, videoT: 1000, kind: 'manual', weight: 2 },
    { id: 'a2', logT: 39000, videoT: 30000, kind: 'manual', weight: 2 }, // 暂停前
    { id: 'a3', logT: 42000, videoT: 33000, kind: 'manual', weight: 2 }, // 暂停后
  ];
  const m = buildMapping(anchors, idx);
  const before = mapLogToVideo(m, 20000);
  assert.ok(Math.abs(before.videoT - 11000) < 1);
  const after = mapLogToVideo(m, 45000);
  assert.ok(Math.abs(after.videoT - 36000) < 1);
});

test('冲突锚点被剔除并记录', () => {
  const anchors: Anchor[] = [
    { id: 'a1', logT: 0, videoT: 0, kind: 'startup', weight: 1 },
    { id: 'bad', logT: 10000, videoT: 20000, kind: 'run', weight: 1 }, // 偏离 10s
    { id: 'a3', logT: 20000, videoT: 20000, kind: 'run', weight: 1 },
  ];
  const m = buildMapping(anchors);
  assert.equal(m.conflicts.length, 1);
  assert.equal(m.conflicts[0].anchorId, 'bad');
  const { videoT } = mapLogToVideo(m, 10000);
  assert.ok(Math.abs(videoT - 10000) < 1);
});

test('逐事件映射与 CSV 导出', () => {
  const idx = buildFrameIndex(makeFrames());
  const anchors: Anchor[] = [{ id: 'a1', logT: 40000, videoT: 0, kind: 'startup', weight: 1 }];
  const m = buildMapping(anchors, idx);
  const log = parseLog('{"t":41000,"btn":"A","state":"down"}\n{"t":41080,"btn":"A","state":"up"}\n');
  const mapped = mapEvents(log.events, m, idx);
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].frame, videoTimeToFrame(idx, 1000));
  assert.ok(mapped[0].videoT === 1000);
  const csv = eventsToCsv(mapped);
  assert.ok(csv.startsWith('event,log_ms,button,state,video_ms,frame'));
  assert.ok(csv.includes('41000,A,down,1000'));
});

test('候选锚点检测：启动动作与连续输入', () => {
  const lines: string[] = [];
  // 启动簇：3 次 A
  for (let i = 0; i < 3; i++) lines.push(`{"t":${5000 + i * 200},"btn":"A","state":"down"}`);
  // 连续输入：8 次 B，每 180ms
  for (let i = 0; i < 8; i++) lines.push(`{"t":${20000 + i * 180},"btn":"B","state":"down"}`);
  const log = parseLog(lines.join('\n'));
  const startup = detectStartup(log.events);
  assert.ok(startup && startup.kind === 'startup' && startup.logT === 5000 && startup.count === 3);
  const runs = detectRuns(log.events);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].logT, 20000);
  assert.ok(Math.abs(runs[0].periodMs - 180) < 1);
});

test('连招窗口匹配', () => {
  const log = parseLog([
    '{"t":1000,"btn":"DOWN","state":"down"}',
    '{"t":1080,"btn":"FWD","state":"down"}',
    '{"t":1150,"btn":"P","state":"down"}',
    '{"t":5000,"btn":"P","state":"down"}',
  ].join('\n'));
  const combos = [{ id: 'hadouken', name: '波动拳', steps: [
    { btn: 'DOWN', withinMs: 0 }, { btn: 'FWD', withinMs: 200 }, { btn: 'P', withinMs: 200 },
  ] }];
  const matches = matchCombos(log.events, combos);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].startLogT, 1000);
  assert.equal(matches[0].endLogT, 1150);
});

test('暂停感知切分：跨暂停段在暂停处折断为斜率1两侧', () => {
  const idx = buildFrameIndex(makeFrames()); // 暂停在视频 30s→33s
  const anchors: Anchor[] = [
    { id: 'a1', logT: 41000, videoT: 1000, kind: 'startup', weight: 1 },
    { id: 'a2', logT: 60000, videoT: 20000, kind: 'run', weight: 1 },
    // 暂停后人工锚点：日志时钟在暂停期间继续走 3s
    { id: 'fix', logT: 80000, videoT: 37000, kind: 'manual', weight: 2 },
  ];
  const m = buildMapping(anchors, idx);
  // 跨暂停的中间锚点不得被误判为冲突
  assert.equal(m.conflicts.length, 0);
  const splitSegs = m.segments.filter((s) => s.flags.includes('pause-split'));
  assert.equal(splitSegs.length, 2);
  assert.ok(splitSegs.every((s) => s.a === 1 && s.confidence >= 0.8));
  // 暂停后事件应精确映射（真值: video = log - 43000）
  assert.ok(Math.abs(mapLogToVideo(m, 88000).videoT - 45000) < 1);
  assert.ok(Math.abs(mapLogToVideo(m, 130000).videoT - 87000) < 1);
});

test('视图模型：按键按住与置信度传播', () => {
  const idx = buildFrameIndex(makeFrames());
  const anchors: Anchor[] = [{ id: 'a1', logT: 40000, videoT: 0, kind: 'startup', weight: 1 }];
  const m = buildMapping(anchors, idx);
  const log = parseLog('{"t":41000,"btn":"A","state":"down"}\n{"t":41500,"btn":"A","state":"up"}\n');
  const mapped = mapEvents(log.events, m, idx);
  const during = momentView(mapped, [], 1200, 0.95, []);
  assert.equal(during.pressed.length, 1);
  assert.equal(during.pressed[0].btn, 'A');
  assert.ok(Math.abs(during.pressed[0].heldMs - 200) < 1);
  const after = momentView(mapped, [], 1600, 0.95, []);
  assert.equal(after.pressed.length, 0);
});
