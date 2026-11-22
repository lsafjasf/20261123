import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rational,
  parseRational,
  fromNumber,
  add,
  mul,
  div,
  roundToInt,
  toNumber,
  cmp,
} from "../src/core/rational.ts";
import { msToGrid, videoGrid, audioGrid, defaultTolerance } from "../src/core/time.ts";

test("parseRational handles fractions and decimals", () => {
  assert.deepEqual(parseRational("30000/1001"), rational(30000n, 1001n));
  assert.deepEqual(parseRational("29.97"), rational(2997n, 100n));
  assert.deepEqual(parseRational("-1.5"), rational(-3n, 2n));
  assert.deepEqual(parseRational("25"), rational(25n));
});

test("fromNumber uses shortest decimal form", () => {
  assert.deepEqual(fromNumber(2.5), rational(5n, 2n));
  assert.deepEqual(fromNumber(0.1), rational(1n, 10n));
});

test("arithmetic stays exact", () => {
  const third = rational(1n, 3n);
  const sum = add(third, add(third, third));
  assert.equal(cmp(sum, rational(1n)), 0);
  assert.equal(toNumber(mul(rational(30000n, 1001n), rational(1001n, 30000n))), 1);
  assert.deepEqual(div(rational(1n, 2n), rational(1n, 4n)), rational(2n));
});

test("roundToInt rounds to nearest with exact error", () => {
  const r = roundToInt(rational(7n, 2n));
  assert.equal(r.value, 4n);
  assert.equal(r.exact, false);
  assert.equal(toNumber(r.error), -0.5);
  const e = roundToInt(rational(30n));
  assert.equal(e.exact, true);
});

test("msToGrid: exact and inexact positions at 30000/1001", () => {
  const grid = videoGrid(rational(30000n, 1001n));
  const exact = msToGrid(1001, grid);
  assert.equal(exact.exact, true);
  assert.equal(exact.ticks, 30n);
  const off = msToGrid(1, grid);
  assert.equal(off.exact, false);
  assert.equal(off.ticks, 0n);
  assert.ok(Math.abs(off.errorMs - 1) < 1e-9);
});

test("msToGrid: audio samples at 48000Hz", () => {
  const grid = audioGrid(48000);
  const c = msToGrid(1000, grid);
  assert.equal(c.exact, true);
  assert.equal(c.ticks, 48000n);
  const half = msToGrid(1, grid);
  assert.equal(half.exact, true);
  assert.equal(half.ticks, 48n);
});

test("default tolerance is half frame plus half sample", () => {
  const t = defaultTolerance(videoGrid(rational(25n)), audioGrid(48000));
  const expected = 1000 / 25 / 2 + 1000 / 48000 / 2;
  assert.ok(Math.abs(t.maxDurationDriftMs - expected) < 1e-12);
  assert.equal(t.requireExactCuts, false);
});
