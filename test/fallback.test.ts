import assert from 'node:assert/strict';
import test from 'node:test';
import { PlayerDecoder, type FallbackEvent } from '../src/player.ts';
import {
  declaresSupportButCannotOpen,
  midStreamFailure,
  SimulatedBackend,
} from '../src/backends/simulated.ts';
import type { CodecConfig, DecodedFrame, EncodedPacket } from '../src/types.ts';

const config: CodecConfig = { codec: 'h265', width: 640, height: 360, preferHardware: true };

function packet(timestamp: number, isKeyframe = false): EncodedPacket {
  return { data: new Uint8Array([timestamp & 0xff]), timestamp, duration: 33_000, isKeyframe };
}

function collector() {
  const frames: DecodedFrame[] = [];
  const fallbacks: FallbackEvent[] = [];
  return {
    frames,
    fallbacks,
    onFrame: (f: DecodedFrame) => frames.push(f),
    onFallback: (e: FallbackEvent) => fallbacks.push(e),
  };
}

test('declares support but cannot open: falls back to software during open', async () => {
  const hw = declaresSupportButCannotOpen();
  const c = collector();
  const player = new PlayerDecoder({
    hardwareFactory: () => hw,
    onFrame: c.onFrame,
    onFallback: c.onFallback,
  });

  await player.open(config);
  assert.equal(player.activeBackend, 'software');
  assert.equal(player.state, 'ready');
  assert.equal(player.fallbacks, 1);
  assert.deepEqual(hw.calls, ['probe', 'open', 'release']); // broken hw fully released

  const frame = await player.decode(packet(0, true));
  assert.equal(frame.source, 'software');
  assert.equal(c.fallbacks.length, 1);
  assert.equal(c.fallbacks[0].phase, 'open');
  await player.release();
  assert.equal(player.state, 'idle');
});

test('mid-stream hardware error: falls back and replays from last keyframe', async () => {
  const hw = midStreamFailure(3); // keyframe + 2 deltas, then dies
  const c = collector();
  const player = new PlayerDecoder({
    hardwareFactory: () => hw,
    onFrame: c.onFrame,
    onFallback: c.onFallback,
  });
  await player.open(config);

  await player.decode(packet(0, true));
  await player.decode(packet(33_000));
  await player.decode(packet(66_000));
  // This packet kills the hardware decoder; player must recover transparently.
  const recovered = await player.decode(packet(99_000));

  assert.equal(player.activeBackend, 'software');
  assert.equal(recovered.source, 'software');
  assert.equal(recovered.timestamp, 99_000);
  assert.equal(c.fallbacks.length, 1);
  assert.equal(c.fallbacks[0].phase, 'mid-stream');
  assert.deepEqual(hw.calls.at(-1), 'release');

  // Every timestamp decoded exactly once across both backends, in order.
  assert.deepEqual(
    c.frames.map((f) => f.timestamp),
    [0, 33_000, 66_000, 0, 33_000, 66_000, 99_000],
  );
  assert.deepEqual(
    c.frames.slice(3).map((f) => f.source),
    ['software', 'software', 'software', 'software'],
  );

  // Stream continues on software without further drama.
  const next = await player.decode(packet(132_000));
  assert.equal(next.source, 'software');
  await player.release();
});

test('first-frame failure: open succeeds, first decode dies, fallback kicks in', async () => {
  const hw = midStreamFailure(0);
  const c = collector();
  const player = new PlayerDecoder({
    hardwareFactory: () => hw,
    onFrame: c.onFrame,
    onFallback: c.onFallback,
  });
  await player.open(config);
  const frame = await player.decode(packet(0, true));
  assert.equal(frame.source, 'software');
  assert.equal(c.fallbacks[0].phase, 'first-frame');
  assert.equal(player.activeBackend, 'software');
  await player.release();
});

test('fallback budget exhausted: player fails instead of looping forever', async () => {
  const hw = midStreamFailure(0);
  const sw = new SimulatedBackend('software', { failDecodeAfter: 0 });
  const player = new PlayerDecoder({
    hardwareFactory: () => hw,
    softwareFactory: () => sw,
    maxFallbacks: 1,
  });
  await player.open(config);
  await assert.rejects(player.decode(packet(0, true)), /decode failed/);
  assert.equal(player.state, 'failed');
  // Release still works from the failed state.
  await player.release();
  assert.equal(player.state, 'idle');
});

test('probe says unsupported (no h265 hardware): software used without burning fallback budget', async () => {
  const hw = new SimulatedBackend('hardware', {
    probeResult: { supported: false, reason: 'no h265 decoder' },
  });
  const player = new PlayerDecoder({ hardwareFactory: () => hw });
  await player.open(config);
  assert.equal(player.activeBackend, 'software');
  const frame = await player.decode(packet(0, true));
  assert.equal(frame.source, 'software');
  await player.release();
});

test('pause, reset and release delegate to whichever backend is active', async () => {
  const hw = midStreamFailure(1);
  const sw = new SimulatedBackend('software');
  const player = new PlayerDecoder({
    hardwareFactory: () => hw,
    softwareFactory: () => sw,
  });
  await player.open(config);
  await player.decode(packet(0, true));
  await player.decode(packet(33_000)); // hw dies, fallback to sw
  assert.equal(player.activeBackend, 'software');

  await player.pause();
  await player.resume();
  await player.reset();
  assert.deepEqual(sw.calls.slice(-3), ['pause', 'resume', 'reset']);
  await player.release();
  assert.equal(sw.calls.at(-1), 'release');
});
