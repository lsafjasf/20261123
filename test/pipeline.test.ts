import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebmMuxer } from '../src/client/mux/webm-muxer.ts';
import {
  decodeMediaHeader,
  encodeMediaFrame,
  HEADER_LEN,
} from '../src/shared/protocol.ts';
import { stageDurations } from '../src/shared/analytics.ts';
import type { MarkerTimeline } from '../src/shared/types.ts';

/**
 * 浏览器无法在 CI 中启动，这里对“编码器输出之后”的纯数据管线做
 * Node 侧验证：Opus 包（用占位字节模拟）-> WebM 复用 -> 媒体帧封装
 * -> 头部解码，保证字节布局与各组件契约一致。
 */
test('Opus 包经 WebM 复用后可封装进媒体帧并完整还原', () => {
  const muxer = new WebmMuxer({ sampleRate: 48000, channels: 1 });
  const init = muxer.initializationSegment();
  const opusPackets = [
    { data: new Uint8Array(64).fill(0x10), timestampMs: 0, keyframe: true },
    { data: new Uint8Array(60).fill(0x20), timestampMs: 20, keyframe: false },
    { data: new Uint8Array(60).fill(0x30), timestampMs: 40, keyframe: false },
  ];
  const chunks: Uint8Array[] = [init];
  for (const packet of opusPackets) {
    chunks.push(muxer.appendPacket(packet));
  }

  opusPackets.forEach((packet, index) => {
    const payload = index === 0 ? chunks[0] : chunks[index + 1];
    const frame = encodeMediaFrame({
      roundId: 'pipeline-round',
      seq: index,
      timestampUs: packet.timestampMs * 1000,
      durationUs: 20000,
      tSendMs: 100 + index,
      tServerRxMs: 0,
      tServerTxMs: 0,
      keyframe: packet.keyframe,
      payload,
    });
    assert.equal(frame.length, HEADER_LEN + payload.length);
    const decoded = decodeMediaHeader(frame).frame;
    assert.equal(decoded.roundId, 'pipeline-round');
    assert.equal(decoded.seq, index);
    assert.equal(decoded.timestampUs, packet.timestampMs * 1000);
    assert.deepEqual(decoded.payload, payload);
  });
});

test('完整标记时间线的五段耗时按定义正确计算', () => {
  const marker: MarkerTimeline = {
    roundId: 'r',
    seq: 0,
    t0Marker: 1000,
    t1Captured: 1012,
    t2Processed: 1018,
    t3Encoded: 1025,
    t4ServerRx: 1040,
    t5ServerTx: 1041,
    t6ClientRx: 1055,
    t7Decoded: 1068,
    t8Output: 1090,
  };
  const durations = stageDurations(marker);
  const sum = (Object.values(durations) as (number | null)[]).reduce(
    (total, value) => total + (value ?? 0),
    0,
  );
  assert.equal(sum, 12 + 6 + 30 + 13 + 22);
  assert.equal(marker.t8Output - marker.t0Marker, 90);
  assert.equal(durations.upload, 1055 - 1025);
  assert.equal(durations.output, 1090 - 1068);
});
