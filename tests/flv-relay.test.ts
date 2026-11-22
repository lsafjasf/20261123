import assert from "node:assert/strict";
import test from "node:test";
import { buildFlvHeader, buildFlvTag, FlvParser } from "../src/flv.ts";
import { GopCache, RelayHub, type RelayClient } from "../src/relay.ts";
import type { ClientMetrics, MediaSample } from "../src/media.ts";
import { parseWireFrame, WireKind } from "../src/wire.ts";

const AVC_CONFIG = Buffer.from(
  "0142c01effe100196742c01eda0280bfe5c044000003000400000300f23c58ba8001000468ce0fc8",
  "hex",
);

function sample(kind: "video" | "audio", keyframe: boolean, bytes = 16, ptsMs = 0): MediaSample {
  return {
    kind,
    keyframe,
    ptsMs,
    durationMs: kind === "video" ? 33.3 : 21.3,
    data: Buffer.alloc(bytes, kind === "video" ? 0x11 : 0x22),
  };
}

class FakeClient implements RelayClient {
  readonly id: number;
  readonly remote = "fake";
  readonly connectedAt = Date.now();
  readonly texts: string[] = [];
  readonly frames: Buffer[] = [];
  readonly throwsOnBinary: boolean;
  closed = "";

  constructor(id: number, throwsOnBinary = false) {
    this.id = id;
    this.throwsOnBinary = throwsOnBinary;
  }

  push(frame: Buffer): void {
    if (this.throwsOnBinary) throw new Error("simulated write failure");
    this.frames.push(frame);
  }

  pushText(text: string): void {
    this.texts.push(text);
  }

  close(reason: string): void {
    this.closed = reason;
  }

  metrics(): ClientMetrics {
    return {
      id: this.id,
      remote: this.remote,
      connectedAt: this.connectedAt,
      state: "live",
      queuedBytes: 0,
      droppedBytes: 0,
      skippedFrames: 0,
      sentBytes: 0,
      lastAckAt: 0,
      reportedQueueMs: 0,
    };
  }
}

test("FLV parser handles fragmented AVC/AAC tags", () => {
  const header = buildFlvHeader();
  const videoConfig = buildFlvTag(9, 0, Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0]), AVC_CONFIG]));
  const videoFrame = buildFlvTag(9, 100, Buffer.from([0x17, 1, 0, 0, 0, 0, 0, 0, 1, 0x65, 1, 2]));
  const audioConfig = buildFlvTag(8, 0, Buffer.from([0xaf, 0, 0x12, 0x10]));
  const audioFrame = buildFlvTag(8, 120, Buffer.from([0xaf, 1, 3, 4]));
  const all = Buffer.concat([header, videoConfig, videoFrame, audioConfig, audioFrame]);
  let videoCodec = "";
  let audioCodec = "";
  const samples: MediaSample[] = [];
  const parser = new FlvParser({
    onVideoConfig: (track) => {
      videoCodec = track.codec;
    },
    onAudioConfig: (track) => {
      audioCodec = track.codec;
    },
    onSample: (parsed) => samples.push(parsed),
    onError: (error) => {
      throw error;
    },
  });
  for (let offset = 0; offset < all.length; offset += 7) parser.feed(all.subarray(offset, offset + 7));
  assert.equal(videoCodec, "avc1.42c01e");
  assert.equal(audioCodec, "mp4a.40.2");
  assert.equal(samples.length, 2);
  assert.equal(samples[0].kind, "video");
  assert.equal(samples[0].keyframe, true);
  assert.equal(samples[0].ptsMs, 100);
  assert.equal(samples[1].kind, "audio");
});

test("GOP cache stays under its byte bound", () => {
  const cache = new GopCache(50, 3);
  cache.add(sample("video", true, 30, 0));
  cache.add(sample("video", false, 30, 33));
  const stats = cache.stats();
  assert.equal(stats.bytes, 0);
  assert.equal(stats.gops, 0);
  assert.equal(stats.oversizeDrops, 1);
  assert.equal(cache.snapshot(), null);
});

test("new viewer receives config followed by the latest keyframe", () => {
  const hub = new RelayHub({ gopCacheBytes: 1024 * 1024 });
  hub.beginSource("test", () => undefined);
  hub.setVideoConfig({ codec: "avc1.42c01e", width: 640, height: 360, description: AVC_CONFIG });
  hub.setAudioConfig({ codec: "mp4a.40.2", sampleRate: 44100, channels: 2, description: Buffer.from([0x12, 0x10]) });
  hub.ingest(sample("video", true, 32, 1000));
  hub.ingest(sample("video", false, 32, 1033));
  hub.ingest(sample("audio", true, 32, 1010));
  const client = new FakeClient(1);
  hub.attachClient(client);
  const packets = client.frames.map((frame) => parseWireFrame(frame));
  assert.equal(packets[0]?.kind, WireKind.VideoConfig);
  assert.equal(packets[1]?.kind, WireKind.AudioConfig);
  assert.equal(packets[2]?.kind, WireKind.VideoSample);
  assert.equal(packets[2]?.flags, 3);
  assert.equal(packets.length, 5);
});

test("one throwing client is isolated from the rest", () => {
  const hub = new RelayHub();
  hub.beginSource("test", () => undefined);
  hub.setVideoConfig({ codec: "avc1.42c01e", width: 640, height: 360, description: AVC_CONFIG });
  const bad = new FakeClient(1, true);
  const good = new FakeClient(2);
  hub.attachClient(bad);
  hub.attachClient(good);
  hub.ingest(sample("video", true, 16, 0));
  assert.equal(bad.closed, "write-error");
  assert.equal(good.frames.length > 0, true);
  assert.equal(hub.stats().clients.length, 1);
});

test("source generation advances on reconnect", () => {
  const hub = new RelayHub();
  const first = hub.beginSource("flv-tcp", () => undefined);
  const second = hub.beginSource("rtmp", () => undefined);
  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(hub.isCurrentSource(first), false);
  assert.equal(hub.isCurrentSource(second), true);
  assert.equal(hub.getSource().reconnectCount, 1);
});
