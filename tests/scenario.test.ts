import test from "node:test";
import assert from "node:assert/strict";
import { LOOP_MS, exchangeAt, focusAt, sceneAt, syntheticChannels } from "../src/scenario.ts";

test("scenario loops deterministically and keeps the ball in the arena", () => {
  for (const t of [0, 500, 2_400, 5_999, 18_000, 35_999, 36_001, 72_500]) {
    const scene = sceneAt(t);
    assert.ok(scene.ball.x >= -2.3 && scene.ball.x <= 2.3);
    assert.ok(scene.ball.y >= 0 && scene.ball.y <= 1.6);
    assert.ok(scene.ball.z >= -0.7 && scene.ball.z <= 0.7);
    assert.equal(scene.exchange, exchangeAt(t));
    assert.ok(scene.loopT >= 0 && scene.loopT < LOOP_MS);
  }
});

test("each exchange has one clearly dominant audio channel", () => {
  for (let exchange = 0; exchange < 6; exchange += 1) {
    const t = exchange * 6_000 + 2_500;
    const channels = syntheticChannels(t);
    const ranked = [...channels].sort((a, b) => b.energyDb - a.energyDb);
    assert.equal(ranked[0]?.camera, focusAt(t));
    assert.ok((ranked[0]?.energyDb ?? -100) - (ranked[1]?.energyDb ?? -100) > 5);
  }
});

test("ball hit transients reach the focused channel first", () => {
  const t = 4_040;
  const channels = syntheticChannels(t);
  const focus = focusAt(t);
  const focused = channels.find((channel) => channel.camera === focus);
  const others = channels.filter((channel) => channel.camera !== focus);
  assert.ok((focused?.onset ?? 0) > Math.max(...others.map((channel) => channel.onset)));
});
