import assert from "node:assert/strict";
import test from "node:test";
import { Rational, rational } from "../src/time/rational.ts";

test("rational values are normalized and never rely on floats", () => {
  const value = Rational.of(60000n, 2002n);
  assert.equal(value.n, 30000n);
  assert.equal(value.d, 1001n);
  assert.equal(value.toString(), "30000/1001");
  assert.deepEqual(value.toJSON(), { n: "30000", d: "1001" });
});

test("standard NTSC rates stay exact through arithmetic", () => {
  const sourceFps = rational("30000/1001");
  const frameTime = Rational.integer(3000n).div(sourceFps);
  assert.equal(frameTime.toString(), "1001/10");
  assert.equal(frameTime.toDecimal(6), "100.100000");
  assert.equal(frameTime.mul(sourceFps).toString(), "3000");
});

test("rounding modes are explicit, including negative ties", () => {
  assert.equal(rational("7/2").round("half-even"), 4n);
  assert.equal(rational("5/2").round("half-even"), 2n);
  assert.equal(rational("-5/2").round("half-even"), -2n);
  assert.equal(rational("-5/2").round("half-up"), -2n);
  assert.equal(rational("-7/2").round("half-up"), -3n);
  assert.equal(rational("-7/2").floor(), -4n);
  assert.equal(rational("-7/2").ceil(), -3n);
});

test("decimal strings are parsed exactly and floats are rejected", () => {
  assert.equal(Rational.fromDecimal("29.97").toString(), "2997/100");
  assert.equal(Rational.fromDecimal("-0.125").toString(), "-1/8");
  assert.throws(() => Rational.parse("23.976"), /not an exact rational/);
  assert.throws(() => Rational.of(1.5), /safe integer/);
});

test("big integers keep multi-hour timestamps unbiased", () => {
  const frames = 1_000_000_000n;
  const fps = rational("24000/1001");
  const microseconds = Rational.integer(frames)
    .div(fps)
    .mul(Rational.of(1_000_000n))
    .round("half-even");
  const back = Rational.integer(microseconds)
    .mul(fps)
    .div(Rational.of(1_000_000n))
    .round("half-even");
  assert.equal(back, frames);
});
