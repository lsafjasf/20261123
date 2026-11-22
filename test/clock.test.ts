import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateFromPoints,
  toLocalTime,
  toServerTime,
} from '../src/shared/clock.ts';

test('零偏移与对称 RTT', () => {
  const est = estimateFromPoints([
    { t0: 1000, tServer: 1005, t2: 1010 },
    { t0: 2000, tServer: 2005, t2: 2010 },
  ]);
  assert.equal(est.rttMs, 10);
  assert.equal(est.offsetMs, 0);
  assert.equal(est.samples, 2);
});

test('取最小 RTT 样本估计偏移', () => {
  const est = estimateFromPoints([
    { t0: 1000, tServer: 1030, t2: 1010 },
    { t0: 2000, tServer: 2024, t2: 2008 },
  ]);
  assert.equal(est.rttMs, 8);
  assert.equal(est.offsetMs, 20);
});

test('时钟换算互逆', () => {
  const est = { offsetMs: 25, rttMs: 8, samples: 1 };
  assert.equal(toServerTime(100, est), 125);
  assert.equal(toLocalTime(125, est), 100);
});
