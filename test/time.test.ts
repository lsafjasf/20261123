import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ticks,
  convertExact,
  convertRound,
  frameTicksAt,
  frameDuration,
  formatSeconds,
} from "../src/time.ts";

test("整刻度换算无舍入", () => {
  const t = ticks(3600n, 90000); // 25fps 一帧
  const c = convertExact(t, 1000);
  assert.equal(c.ticks, 40n);
  assert.equal(c.rem, 0n);
});

test("非整刻度换算保留余数", () => {
  const t = ticks(1n, 3);
  const c = convertExact(t, 10);
  assert.equal(c.ticks, 3n);
  assert.equal(c.rem, 1n); // 1/3 s = 3.333... ms
});

test("最近舍入并报告误差", () => {
  const r = convertRound(ticks(1n, 44100), 90000);
  assert.equal(r.ticks, 2n);
  assert.equal(r.exact, false);
  const exact = convertRound(ticks(44100n, 44100), 90000);
  assert.equal(exact.ticks, 90000n);
  assert.equal(exact.exact, true);
});

test("29.97fps 六分钟零漂移：第 n 帧由帧号直接计算", () => {
  // 30000/1001 fps @ 90000 刻度 -> 每帧恰好 3003 tick
  const fd = frameDuration(30000, 1001, 90000);
  assert.equal(fd.exact, true);
  assert.equal(fd.num, 3003n);
  assert.equal(fd.den, 1n);
  const frames = 10789n; // 约 6 分钟
  const last = frameTicksAt(frames, fd.num, fd.den);
  assert.equal(last, frames * 3003n); // 乘法直达，无累加误差
  // 对照：浮点累加在 float32 下此处已偏出数十微秒且逐帧抖动
});

test("25fps @ 90000 与音频 44100 长素材对齐", () => {
  const fd = frameDuration(25, 1, 90000);
  const fiveMinFrames = 25n * 300n;
  assert.equal(frameTicksAt(fiveMinFrames, fd.num, fd.den), 90000n * 300n);
  // 音频帧 1024/44100 s：44100*256 恰为 1024 整数倍，256s 处应严格对齐
  const m = 11025n; // = 44100*256/1024
  const aTicks = m * 1024n;
  const r = convertRound(ticks(aTicks, 44100), 90000);
  assert.equal(r.exact, true);
  assert.equal(r.ticks, 90000n * 256n);
});

test("formatSeconds 精确格式化", () => {
  assert.equal(formatSeconds(ticks(90000n, 90000)), "1.000000");
  assert.equal(formatSeconds(ticks(3003n, 90000)), "0.033367");
  assert.equal(formatSeconds(ticks(-45000n, 90000)), "-0.500000");
});
