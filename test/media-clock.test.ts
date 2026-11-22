import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, entriesOf, eventNames, startPlaying } from './helpers.ts';

test('起播经历 initial 缓冲，解冻后媒体时间随外部时钟推进', () => {
  const h = createHarness();
  h.media.start();
  assert.equal(h.media.getState(), 'buffering');

  h.clock.advance(10);
  h.media.updateBufferedRange(0, 50_000, 50_000);
  const result = h.media.notifyDataAvailable();
  assert.equal(result?.resumed, true);
  assert.equal(h.media.getState(), 'playing');

  h.clock.advance(1000);
  assert.equal(Math.round(h.media.getMediaMs()), 1000);

  const starts = entriesOf(h, 'bufferStart', 'applied');
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.detail.reason, 'initial');
});

test('欠载触发缓冲：画面与声音在同一媒体位置冻结，恢复后从该位置继续', () => {
  const h = createHarness();
  startPlaying(h);
  h.clock.advance(2000);
  assert.equal(Math.round(h.media.getMediaMs()), 2000);

  // 数据只到 2000ms，播放位置追平缓冲边缘 => underrun
  const report = h.media.updateBufferedRange(0, 2000, 2000);
  assert.equal(report.underrun, true);
  h.media.beginBuffering('underrun');
  assert.equal(h.media.getState(), 'buffering');

  h.clock.advance(5000);
  assert.equal(Math.round(h.media.getMediaMs()), 2000, '冻结期间媒体时间不推进');

  h.media.updateBufferedRange(0, 20_000, 20_000);
  h.media.notifyDataAvailable();
  assert.equal(h.media.getState(), 'playing');
  assert.equal(Math.round(h.media.getMediaMs()), 2000, '从冻结位置恢复');

  h.clock.advance(1000);
  assert.equal(Math.round(h.media.getMediaMs()), 3000);

  const end = entriesOf(h, 'bufferEnd', 'applied').at(-1);
  assert.equal(end?.detail.reason, 'underrun');
  assert.equal(end?.detail.frozenMs, 5000);
});

test('暂停与恢复：媒体时间冻结，恢复锚点保持同一位置', () => {
  const h = createHarness();
  startPlaying(h);
  h.clock.advance(1500);
  h.media.pause();
  assert.equal(h.media.getState(), 'paused');

  h.clock.advance(4000);
  assert.equal(Math.round(h.media.getMediaMs()), 1500);

  h.media.resume();
  h.clock.advance(500);
  assert.equal(Math.round(h.media.getMediaMs()), 2000);

  const applied = entriesOf(h, 'pause', 'applied');
  assert.equal(applied.length, 1);
});

test('已缓冲的用户拖动立即重锚，日志记录跳转误差', () => {
  const h = createHarness();
  startPlaying(h);
  h.clock.advance(1000);
  h.media.userSeek(8000);

  assert.equal(Math.round(h.media.getMediaMs()), 8000);
  const seek = entriesOf(h, 'userSeek', 'applied')[0];
  assert.equal(seek?.errorMs, 7000);
  assert.equal(seek?.detail.targetMediaMs, 8000);
});

test('未缓冲的拖动进入 seek 缓冲，数据就绪后在目标位置解冻', () => {
  const h = createHarness();
  startPlaying(h, 10_000);
  h.clock.advance(1000);
  h.media.userSeek(30_000);
  assert.equal(h.media.getState(), 'buffering');
  assert.equal(entriesOf(h, 'userSeek', 'queued').length, 1);

  h.clock.advance(200);
  // 目标位置仍未缓冲，不能解冻
  h.media.updateBufferedRange(0, 12_000, 12_000);
  assert.equal(h.media.notifyDataAvailable(), null);
  assert.equal(h.media.getState(), 'buffering');

  h.clock.advance(300);
  h.media.updateBufferedRange(0, 32_000, 32_000);
  h.media.notifyDataAvailable();
  assert.equal(h.media.getState(), 'playing');
  assert.equal(Math.round(h.media.getMediaMs()), 30_000);
});

test('冲突仲裁：缓冲期用户拖动抢占式取消排队的自动追直播', () => {
  const h = createHarness();
  startPlaying(h, 10_000);
  h.clock.advance(1000);

  h.media.beginBuffering('underrun');
  h.media.catchUp(9000);
  h.media.userSeek(5000);
  assert.deepEqual(
    h.media.pendingCommands().map((command) => command.kind),
    ['userSeek'],
  );
  const rejected = entriesOf(h, 'catchUp', 'rejected');
  assert.equal(rejected[0]?.detail.reason, 'preemptedByUser');
});

test('冲突仲裁：播放态用户拖动后到达的 catchUp 被拒绝（用户意图优先）', () => {
  const h = createHarness();
  startPlaying(h, 10_000);
  h.clock.advance(1000);
  h.media.userSeek(4000);
  h.media.pause();
  h.media.catchUp(9000);
  assert.equal(entriesOf(h, 'catchUp', 'rejected')[0]?.detail.reason, 'userIntentWins');
  assert.equal(h.media.getState(), 'paused');
  assert.equal(Math.round(h.media.getMediaMs()), 4000);
});

test('蓝牙延迟突变：重锚保持同一媒体位置，延迟量独立记录', () => {
  const h = createHarness();
  startPlaying(h);
  h.clock.advance(2000);
  h.media.latencyChange({
    baseLatencyMs: 25,
    outputLatencyMs: 180,
    perfMs: h.clock.now(),
  });
  assert.equal(Math.round(h.media.getMediaMs()), 2000, '媒体位置不因延迟变化而跳动');
  assert.equal(h.media.getOutputLatencyMs(), 180);

  h.clock.advance(1000);
  assert.equal(Math.round(h.media.getMediaMs()), 3000, '重锚后继续匀速推进');

  const entry = entriesOf(h, 'latencyChange', 'applied')[0];
  assert.equal(entry?.errorMs, 180);
  assert.equal(entry?.detail.baseLatencyMs, 25);
});

test('缓冲冻结期间发生延迟突变：锚点延迟更新，解冻后沿用新延迟', () => {
  const h = createHarness();
  startPlaying(h);
  h.clock.advance(1000);
  h.media.beginBuffering('background');
  h.clock.advance(10);
  h.media.latencyChange({
    baseLatencyMs: 40,
    outputLatencyMs: 220,
    perfMs: h.clock.now(),
  });
  assert.equal(h.media.getAnchor().outputLatencyMs, 220);
  assert.equal(h.media.getAnchor().rate, 0);

  h.media.updateBufferedRange(0, 40_000, 40_000);
  h.media.notifyDataAvailable();
  assert.equal(h.media.getState(), 'playing');
  assert.equal(h.media.getAnchor().outputLatencyMs, 220);
  assert.equal(Math.round(h.media.getMediaMs()), 1000);
});

test('end 立即生效并清空所有排队命令', () => {
  const h = createHarness();
  startPlaying(h, 10_000);
  h.media.beginBuffering('underrun');
  h.media.userSeek(5000);
  h.media.catchUp(8000);
  h.media.end();
  assert.equal(h.media.getState(), 'ended');
  assert.equal(h.media.pendingCommands().length, 0);
  const endEntry = entriesOf(h, 'end', 'applied')[0];
  assert.equal(endEntry?.detail.droppedCommands, 2);
});

test('日志 seq 严格单调递增，完整保留触发顺序与缓冲状态', () => {
  const h = createHarness();
  startPlaying(h);
  h.clock.advance(50);
  h.media.pause();
  h.media.resume();
  h.media.latencyChange({ baseLatencyMs: 10, outputLatencyMs: 90, perfMs: h.clock.now() });

  const entries = h.sink.entries();
  for (let i = 1; i < entries.length; i += 1) {
    assert.ok((entries[i]?.seq ?? 0) > (entries[i - 1]?.seq ?? -1));
  }
  assert.ok(eventNames(h).includes('latencyChange:applied'));
  // 每条日志都带有状态、媒体时间与误差字段
  for (const entry of entries) {
    assert.equal(typeof entry.state, 'string');
    assert.equal(typeof entry.mediaMs, 'number');
    assert.equal(typeof entry.errorMs, 'number');
  }
});

test('追直播计划：滞后超阈值才产生步长化目标，且不越过直播边缘', () => {
  const h = createHarness();
  startPlaying(h, 10_000);
  h.clock.advance(1000); // 媒体位置 1000，直播边缘 10000，滞后 9000
  const policy = { thresholdMs: 3000, stepMs: 2000, withinMs: 250 };
  const plan = h.media.planCatchUp(policy);
  assert.ok(plan);
  assert.equal(plan?.targetMediaMs, 3000);
  assert.equal(plan?.lagMs, 9000);

  h.media.catchUp(plan?.targetMediaMs ?? 0);
  const nearEdge = h.media.planCatchUp({ ...policy, thresholdMs: 100_000 });
  assert.equal(nearEdge, null);
});

test('解冻后排队的未缓冲跳转立即重新进入 seek 缓冲，数据就绪后落到目标位置', () => {
  const h = createHarness();
  startPlaying(h, 10_000);
  h.clock.advance(1000);

  // 欠载缓冲期间排队一个超出当前缓冲窗口的用户拖动
  h.media.beginBuffering('underrun');
  h.media.userSeek(50_000);
  assert.equal(h.media.getState(), 'buffering');

  // 只补齐欠载位置，排队 seek 目标仍未缓冲
  h.clock.advance(200);
  h.media.updateBufferedRange(0, 12_000, 12_000);
  const result = h.media.notifyDataAvailable();
  assert.equal(result?.resumed, true);
  assert.equal(result?.finalState, 'buffering', '恢复后立刻因排队 seek 再缓冲');
  assert.equal(h.media.getState(), 'buffering');
  assert.equal(h.media.pendingCommands().length, 1);

  // 目标数据到位后解冻并落在用户位置
  h.clock.advance(300);
  h.media.updateBufferedRange(0, 60_000, 60_000);
  h.media.notifyDataAvailable();
  assert.equal(h.media.getState(), 'playing');
  assert.equal(Math.round(h.media.getMediaMs()), 50_000);
});
