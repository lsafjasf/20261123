import assert from 'node:assert/strict';
import test from 'node:test';
import { DecoderLifecycle, type StateChange } from '../src/lifecycle.ts';
import { SimulatedBackend } from '../src/backends/simulated.ts';
import { DecoderError, type CodecConfig, type DecoderState, type EncodedPacket } from '../src/types.ts';

const config: CodecConfig = { codec: 'h265', width: 640, height: 360 };

function packet(timestamp: number, isKeyframe = false): EncodedPacket {
  return { data: new Uint8Array([1, 2, 3]), timestamp, duration: 33_000, isKeyframe };
}

function tracked(backend: SimulatedBackend) {
  const lifecycle = new DecoderLifecycle(backend);
  const history: DecoderState[] = [];
  lifecycle.onStateChange((c: StateChange) => history.push(c.to));
  return { lifecycle, history };
}

test('unified happy path: probe -> open -> decode -> pause -> resume -> reset -> release', async () => {
  const backend = new SimulatedBackend('hardware');
  const { lifecycle, history } = tracked(backend);

  await lifecycle.probe(config);
  await lifecycle.open(config);
  await lifecycle.decode(packet(0, true));
  await lifecycle.pause();
  await lifecycle.resume();
  await lifecycle.decode(packet(33_000));
  await lifecycle.reset();
  await lifecycle.release();

  assert.deepEqual(history, [
    'probing', 'opening', 'ready',
    'decoding', 'paused', 'decoding',
    'resetting', 'ready',
    'releasing', 'released',
  ]);
  assert.deepEqual(backend.calls, [
    'probe', 'open', 'decode', 'pause', 'resume', 'decode', 'reset', 'release',
  ]);
  assert.equal(lifecycle.state, 'released');
});

test('software backend follows the exact same state sequence', async () => {
  const backend = new SimulatedBackend('software');
  const { lifecycle, history } = tracked(backend);
  await lifecycle.probe(config);
  await lifecycle.open(config);
  await lifecycle.decode(packet(0, true));
  await lifecycle.release();
  assert.deepEqual(history, ['probing', 'opening', 'ready', 'decoding', 'releasing', 'released']);
});

test('illegal transitions are rejected as fatal, non-fallbackable errors', async () => {
  const { lifecycle } = tracked(new SimulatedBackend('hardware'));
  await assert.rejects(lifecycle.decode(packet(0)), (err: DecoderError) => {
    assert.equal(err.fatal, true);
    return true;
  });
  await assert.rejects(lifecycle.pause());
  await lifecycle.open(config); // probe may be skipped
  await assert.rejects(lifecycle.resume()); // not paused
  await lifecycle.release();
});

test('release is idempotent and reachable from failed state', async () => {
  const backend = new SimulatedBackend('hardware', { openError: new Error('nope') });
  const { lifecycle } = tracked(backend);
  await assert.rejects(lifecycle.open(config));
  assert.equal(lifecycle.state, 'failed');
  await lifecycle.release();
  await lifecycle.release();
  assert.equal(lifecycle.state, 'released');
  assert.deepEqual(backend.calls, ['open', 'release']);
});

test('first decode failure is classified as first-frame, later ones as mid-stream', async () => {
  const first = new DecoderLifecycle(new SimulatedBackend('hardware', { failDecodeAfter: 0 }));
  await first.open(config);
  const err1 = await first.decode(packet(0, true)).catch((e) => e);
  assert.equal(err1.phase, 'first-frame');

  const mid = new DecoderLifecycle(new SimulatedBackend('hardware', { failDecodeAfter: 2 }));
  await mid.open(config);
  await mid.decode(packet(0, true));
  await mid.decode(packet(33_000));
  const err2 = await mid.decode(packet(66_000)).catch((e) => e);
  assert.equal(err2.phase, 'mid-stream');
  assert.equal(mid.state, 'failed');
});

test('probe that reports unsupported moves to failed with the given reason', async () => {
  const backend = new SimulatedBackend('hardware', {
    probeResult: { supported: false, reason: 'no h265 hardware' },
  });
  const { lifecycle } = tracked(backend);
  const err = await lifecycle.probe(config).catch((e) => e);
  assert.equal(err.phase, 'probe');
  assert.match(err.message, /no h265 hardware/);
  assert.equal(lifecycle.state, 'failed');
});
