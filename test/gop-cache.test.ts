import assert from "node:assert/strict";
import test from "node:test";
import { GopFrameCache, type ClosableFrame } from "../src/gop-cache.ts";

class FakeFrame implements ClosableFrame {
  closed = false;
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  close(): void {
    this.closed = true;
  }
}

test("GOP 数超过上限时按最旧且非固定 GOP 淘汰", () => {
  const cache = new GopFrameCache<FakeFrame>(3, 10_000);
  const pinned = new FakeFrame("pinned");
  cache.put(0, 0, pinned, 10);
  cache.pin(0, 0);
  const frames = [1, 2, 3].map((gop) => {
    const frame = new FakeFrame(`gop-${gop}`);
    cache.put(gop, gop, frame, 10);
    return frame;
  });
  assert.equal(cache.stats.gops, 3);
  assert.equal(frames[0].closed, true);
  assert.equal(cache.get(0, 0), pinned);
  assert.equal(pinned.closed, false);
});

test("字节预算只淘汰未固定帧，并正确关闭重复输出", () => {
  const cache = new GopFrameCache<FakeFrame>(4, 10);
  const pinned = new FakeFrame("current");
  cache.put(0, 0, pinned, 4);
  cache.pin(0, 0);
  const second = new FakeFrame("second");
  cache.put(0, 1, second, 4);
  const third = new FakeFrame("third");
  cache.put(1, 0, third, 4);
  assert.equal(second.closed, true);
  assert.equal(pinned.closed, false);
  assert.equal(cache.stats.bytes <= 10, true);

  const duplicate = new FakeFrame("duplicate");
  cache.put(0, 0, duplicate, 4);
  assert.equal(duplicate.closed, true);
  assert.equal(cache.get(0, 0), pinned);
});
