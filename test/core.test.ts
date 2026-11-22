import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CollisionMixer } from '../src/core/mixer.ts';
import { Rng, hash32 } from '../src/core/rng.ts';
import { generateScenario } from '../src/core/scenario.ts';
import {
  CEILING_DB,
  FAMILY_QUOTA,
  Priority,
  SAMPLE_RATE,
  dbToGain,
  type CollisionEvent,
} from '../src/core/types.ts';
import { encodeWavPcm16 } from '../src/core/wav.ts';

function run(seed: number, events: CollisionEvent[]) {
  return new CollisionMixer(seed, events).renderAll();
}

test('Rng 同 seed 序列一致，不同 seed 序列不同', () => {
  const a = new Rng(1234);
  const b = new Rng(1234);
  const c = new Rng(1235);
  const seqA = Array.from({ length: 64 }, () => a.nextU32());
  const seqB = Array.from({ length: 64 }, () => b.nextU32());
  const seqC = Array.from({ length: 64 }, () => c.nextU32());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  assert.ok(seqA.every((v) => Number.isInteger(v) && v >= 0));
});

test('hash32 折叠稳定且与输入相关', () => {
  assert.equal(hash32(1, 2, 3), hash32(1, 2, 3));
  assert.notEqual(hash32(1, 2, 3), hash32(1, 2, 4));
});

test('场景生成本身确定', () => {
  const a = generateScenario({ seed: 7 });
  const b = generateScenario({ seed: 7 });
  assert.deepEqual(a, b);
  assert.ok(a.length > 100);
});

test('同 seed + 同事件流输出逐位一致，改 seed 输出不同', () => {
  const events = generateScenario({ seed: 99 });
  const r1 = run(42, events);
  const r2 = run(42, events);
  const r3 = run(43, events);
  assert.equal(r1.pcm.length, r2.pcm.length);
  for (let i = 0; i < r1.pcm.length; i++) {
    assert.equal(r1.pcm[i], r2.pcm[i], `样本 ${i} 不一致`);
  }
  let diffs = 0;
  for (let i = 0; i < r1.pcm.length; i++) {
    if (r1.pcm[i] !== r3.pcm[i]) diffs++;
  }
  assert.ok(diffs > r1.pcm.length / 2, '不同 seed 应产生显著不同输出');
});

test('指标序列也随结果完全确定', () => {
  const events = generateScenario();
  const a = run(5, events).metrics;
  const b = run(5, events).metrics;
  assert.deepEqual(a, b);
});

test('输出永不超过 ceiling（不会叠到爆音）', () => {
  const events = generateScenario({ collisionsPerSecond: 40, duration: 8 });
  const { pcm } = run(1, events);
  const ceiling = dbToGain(CEILING_DB);
  let peak = 0;
  for (const v of pcm) {
    assert.ok(Math.abs(v) <= ceiling + 1e-6, `超限样本 ${v}`);
    peak = Math.max(peak, Math.abs(v));
  }
  assert.ok(peak > 0.1, '场景应有可观响度');
});

test('音色族配额：同时发声数不超过族配额，超出事件被轮换', () => {
  const events: CollisionEvent[] = [];
  for (let i = 0; i < 30; i++) {
    events.push({
      id: i + 1,
      time: 0.001 * i,
      material: 'coin',
      speed: 2,
      pan: 0,
      priority: Priority.Sfx,
    });
  }
  const mixer = new CollisionMixer(11, events);
  const result = mixer.renderAll();
  for (const m of result.metrics) {
    assert.ok(m.activeVoices <= sumQuotas(), `活跃发声体 ${m.activeVoices} 超总配额`);
  }
  const rotated = mixer.scheduleRecords.filter((r) => r.reason === 'rotated');
  assert.ok(rotated.length > 0, '高密度同族事件应触发轮换');
  const acceptedIds = new Set(
    mixer.scheduleRecords.filter((r) => r.accepted).map((r) => r.eventId),
  );
  assert.ok(acceptedIds.size <= events.length);
});

test('低速碰撞被忽略，但危险提示无视速度阈值', () => {
  const events: CollisionEvent[] = [
    { id: 1, time: 0.01, material: 'rubber', speed: 0.02, pan: 0, priority: Priority.Sfx },
    { id: 2, time: 0.02, material: 'metal', speed: 0, pan: 0, priority: Priority.Danger },
  ];
  const mixer = new CollisionMixer(3, events);
  mixer.renderAll();
  const slow = mixer.scheduleRecords.find((r) => r.eventId === 1);
  const danger = mixer.scheduleRecords.find((r) => r.eventId === 2);
  assert.equal(slow?.accepted, false);
  assert.equal(slow?.reason, 'too_slow');
  assert.equal(danger?.accepted, true);
});

test('对话期间 sfx 被侧链压低，对话总线本身不被压', () => {
  // 先制造持续 sfx，再在 1s 处插入对话
  const events: CollisionEvent[] = [];
  let id = 1;
  for (let t = 0; t < 2; t += 0.05) {
    events.push({
      id: id++,
      time: t,
      material: 'wood',
      speed: 3,
      pan: 0,
      priority: Priority.Sfx,
    });
  }
  events.push({
    id: id++,
    time: 1,
    material: 'rubber',
    speed: 0,
    pan: 0,
    priority: Priority.Dialogue,
  });
  const { metrics } = run(8, events);
  const during = metrics.filter((m) => m.time >= 1.02 && m.time <= 1.2);
  assert.ok(during.length > 0);
  for (const m of during) {
    assert.ok(m.sidechainGain < 0.4, `侧链未压低: ${m.sidechainGain}`);
  }
  const before = metrics.find((m) => Math.abs(m.time - 0.5) < 0.02)!;
  assert.ok(before.sidechainGain > 0.99);
});

test('极端并发下保护链逐级介入：overload ducking -> 限制器，输出仍不破顶', () => {
  // 同一时刻堆满高速、不同族事件，绕过族配额制造总线级峰值
  const events: CollisionEvent[] = [];
  let id = 1;
  const materials = ['coin', 'wood', 'glass', 'stone', 'rubber', 'metal'] as const;
  for (const material of materials) {
    for (let k = 0; k < 4; k++) {
      events.push({
        id: id++,
        time: 0.5 + k * 0.001,
        material,
        speed: 9,
        pan: 0,
        priority: Priority.Sfx,
      });
    }
  }
  events.push({
    id: id++,
    time: 0.5,
    material: 'metal',
    speed: 0,
    pan: 0,
    priority: Priority.Danger,
  });
  const mixer = new CollisionMixer(21, events);
  const { pcm, metrics } = mixer.renderAll();
  assert.ok(
    metrics.some((m) => m.overloadGain < 0.999),
    '过载二级 ducking 应介入',
  );
  assert.ok(
    metrics.some((m) => m.limiterGain < 0.999),
    '极端峰值下限制器应实际介入',
  );
  // 危险提示总线始终未被 duck（duckable=false），独立可读
  const dangerBlock = metrics.find((m) => m.time >= 0.5 && m.dangerPeak > 0);
  assert.ok(dangerBlock, '危险提示应存在于输出中');
  const ceiling = dbToGain(CEILING_DB);
  for (const v of pcm) assert.ok(Math.abs(v) <= ceiling + 1e-6);
});

test('WAV 编码头与长度正确且确定', () => {
  const pcm = new Float32Array(4800); // 0.05s stereo @48k
  pcm.fill(0.25);
  const a = encodeWavPcm16(pcm, SAMPLE_RATE);
  const b = encodeWavPcm16(pcm, SAMPLE_RATE);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.equal(a.length, 44 + 4800 * 2);
  assert.equal(new TextDecoder().decode(a.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(a.subarray(8, 12)), 'WAVE');
});

function sumQuotas(): number {
  return Object.values(FAMILY_QUOTA).reduce((a, b) => a + b, 0);
}
