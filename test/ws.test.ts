import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptKey,
  encodeFrame,
  OPCODE_BINARY,
  OPCODE_TEXT,
  WsDecoder,
} from '../src/shared/ws.ts';

function maskPayload(payload: Uint8Array): {
  frame: Uint8Array;
  mask: Uint8Array;
} {
  const mask = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
  const plain = encodeFrame(OPCODE_BINARY, payload, true);
  const frame = new Uint8Array(plain.length + 4);
  frame.set(plain.subarray(0, plain.length - payload.length), 0);
  frame[1] |= 0x80;
  const headerLen = plain.length - payload.length;
  frame.set(mask, headerLen);
  const masked = payload.map((b, i) => b ^ mask[i % 4]);
  frame.set(masked, headerLen + 4);
  return { frame, mask };
}

test('Sec-WebSocket-Accept 计算符合 RFC 6455 示例', async () => {
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  assert.equal(
    await acceptKey(key),
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
  );
});

test('解码带掩码的短帧', () => {
  const payload = new TextEncoder().encode('hello');
  const { frame } = maskPayload(payload);
  const decoder = new WsDecoder();
  const frames = decoder.push(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, OPCODE_BINARY);
  assert.deepEqual(frames[0].payload, payload);
});

test('分片推送后重组完整消息', () => {
  const payload = new Uint8Array(300).fill(7);
  const { frame } = maskPayload(payload);
  const decoder = new WsDecoder();
  assert.equal(decoder.push(frame.subarray(0, 50)).length, 0);
  assert.equal(decoder.push(frame.subarray(50, 200)).length, 0);
  const frames = decoder.push(frame.subarray(200));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].payload, payload);
});

test('无掩码帧被拒绝', () => {
  const frame = encodeFrame(OPCODE_TEXT, new TextEncoder().encode('x'));
  const decoder = new WsDecoder();
  assert.throws(() => decoder.push(frame), /掩码/);
});

test('超过 64KiB 的 64 位长度帧可解码', () => {
  const payload = new Uint8Array(70000).fill(0xab);
  const { frame } = maskPayload(payload);
  const decoder = new WsDecoder();
  const frames = decoder.push(frame);
  assert.equal(frames[0].payload.length, 70000);
  assert.equal(frames[0].payload[69999], 0xab);
});
