import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeControl,
  decodeMediaHeader,
  encodeControl,
  encodeMediaFrame,
  HEADER_LEN,
  stampServerTimes,
} from '../src/shared/protocol.ts';

test('媒体帧编解码往返一致', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const frame = {
    roundId: 'round-abc-123',
    seq: 42,
    timestampUs: 123456.75,
    durationUs: 20000,
    tSendMs: 1000.5,
    tServerRxMs: 0,
    tServerTxMs: 0,
    keyframe: true,
    payload,
  };
  const bytes = encodeMediaFrame(frame);
  assert.equal(bytes.length, HEADER_LEN + payload.length);
  const { frame: decoded } = decodeMediaHeader(bytes);
  assert.equal(decoded.roundId, 'round-abc-123');
  assert.equal(decoded.seq, 42);
  assert.equal(decoded.timestampUs, 123456.75);
  assert.equal(decoded.durationUs, 20000);
  assert.equal(decoded.tSendMs, 1000.5);
  assert.equal(decoded.keyframe, true);
  assert.deepEqual(decoded.payload, payload);
});

test('服务端时间戳回填不破坏其他字段', () => {
  const bytes = encodeMediaFrame({
    roundId: 'r1',
    seq: 7,
    timestampUs: 10,
    durationUs: 20,
    tSendMs: 1,
    tServerRxMs: 0,
    tServerTxMs: 0,
    keyframe: false,
    payload: new Uint8Array([9]),
  });
  const stamped = stampServerTimes(bytes, 100.25, 102.5);
  const { frame } = decodeMediaHeader(stamped);
  assert.equal(frame.tServerRxMs, 100.25);
  assert.equal(frame.tServerTxMs, 102.5);
  assert.equal(frame.seq, 7);
  assert.deepEqual(frame.payload, new Uint8Array([9]));
});

test('非法 magic 抛协议错误', () => {
  const bytes = new Uint8Array(HEADER_LEN);
  assert.throws(() => decodeMediaHeader(bytes), /magic/);
});

test('控制消息 JSON 往返', () => {
  const msg = {
    kind: 'marker',
    roundId: 'r1',
    seq: 3,
    t0: 99.9,
  } as const;
  const decoded = decodeControl(encodeControl(msg));
  assert.deepEqual(decoded, msg);
});
