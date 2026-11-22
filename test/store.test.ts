import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScanStore } from '../src/server/store.ts';
import { analyzeFromStore } from '../src/server/pipeline.ts';
import { ENGINE_VERSION } from '../src/shared/config.ts';
import type { BatchUpload, FrameMetric } from '../src/shared/types.ts';

let dir: string;
let store: ScanStore;

function frame(index: number): FrameMetric {
  return {
    index,
    pts: index / 30,
    meanLuma: 100,
    blackRatio: 0,
    diff: 6,
    motion: 1.5,
    motionDisorder: 0.1,
    audioRms: 0.04,
  };
}

function batch(
  sha: string,
  batchIndex: number,
  frames: FrameMetric[],
): BatchUpload {
  return {
    sha256: sha,
    fileName: 'a.mp4',
    size: 1024,
    engineVersion: ENGINE_VERSION,
    batchIndex,
    sampleEvery: 1,
    videoMeta: {
      width: 320,
      height: 180,
      frameRate: 30,
      frameCount: 60,
      durationSec: 2,
      hasAudio: false,
    },
    frames,
  };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'scan-store-'));
  store = new ScanStore(dir);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('断点续扫：批次落盘后检查点可查询，可从下一帧继续', () => {
  const sha = 'a'.repeat(64);
  const ack1 = store.uploadBatch(batch(sha, 0, [frame(0), frame(1)]));
  assert.equal(ack1.nextBatchIndex, 1);
  assert.equal(ack1.lastFrameIndex, 1);
  const ack2 = store.uploadBatch(batch(sha, 1, [frame(2), frame(3)]));
  assert.equal(ack2.nextBatchIndex, 2);
  const state = store.getState(sha);
  assert.equal(state?.status, 'scanning');
  assert.equal(state?.lastFrameIndex, 3);
});

test('幂等：重复上传同一批次不重复写入，检查点不变', () => {
  const sha = 'a'.repeat(64);
  const before = store.getState(sha)?.nextBatchIndex;
  const ack = store.uploadBatch(batch(sha, 0, [frame(0), frame(1)]));
  assert.equal(ack.nextBatchIndex, before);
  const bundle = store.loadBundle(sha);
  assert.equal(bundle.frames.length, 4);
});

test('连续性保护：跳号批次与断帧都被拒绝', () => {
  const sha = 'b'.repeat(64);
  store.uploadBatch(batch(sha, 0, [frame(0)]));
  assert.throws(() => store.uploadBatch(batch(sha, 2, [frame(1)])));
  assert.throws(() => store.uploadBatch(batch(sha, 1, [frame(5)])));
});

test('版本保护：引擎版本不一致拒绝续扫', () => {
  const sha = 'c'.repeat(64);
  const bad = batch(sha, 0, [frame(0)]);
  bad.engineVersion = '0.0.1';
  assert.throws(() => store.uploadBatch(bad));
});

test('收尾与分析：complete 校验帧数，分析结果与导出清单生成', () => {
  const sha = 'd'.repeat(64);
  for (let start = 0; start < 60; start += 10) {
    store.uploadBatch(batch(sha, start / 10, Array.from({ length: 10 }, (_, i) => frame(start + i))));
  }
  assert.throws(() => store.complete(sha, 59));
  const state = store.complete(sha, 60);
  assert.equal(state.status, 'done');
  const output = analyzeFromStore(store, sha);
  assert.equal(output.result.sha256, sha);
  assert.ok(output.files.some((path) => path.endsWith('shots.csv')));
  assert.ok(store.getResult(sha) !== null);
});

test('重建确定性：loadBundle 按批次文件名排序，帧序号严格连续', () => {
  const sha = 'd'.repeat(64);
  const bundle = store.loadBundle(sha);
  bundle.frames.forEach((frameMetric, index) => {
    assert.equal(frameMetric.index, index);
  });
});

test('采样模式：sampleEvery=2 时按步长 2 校验并正确收尾', () => {
  const sha = 'e'.repeat(64);
  const sampled = (indices: number[]): FrameMetric[] => indices.map((index) => frame(index));
  const make = (batchIndex: number, indices: number[]): BatchUpload => ({
    sha256: sha,
    fileName: 'sampled.mp4',
    size: 512,
    engineVersion: ENGINE_VERSION,
    batchIndex,
    sampleEvery: 2,
    videoMeta: {
      width: 320,
      height: 180,
      frameRate: 30,
      frameCount: 10,
      durationSec: 10 / 30,
      hasAudio: false,
    },
    frames: sampled(indices),
  });
  store.uploadBatch(make(0, [0, 2, 4]));
  store.uploadBatch(make(1, [6, 8]));
  assert.throws(() => store.uploadBatch(make(2, [11, 13])));
  const state = store.complete(sha, 10);
  assert.equal(state.status, 'done');
  const bundle = store.loadBundle(sha);
  assert.deepEqual(bundle.frames.map((item) => item.index), [0, 2, 4, 6, 8]);
});
