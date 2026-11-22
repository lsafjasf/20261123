import assert from "node:assert/strict";
import test from "node:test";
import { RtmpSession } from "../src/rtmp.ts";

const AVC_CONFIG = Buffer.from(
  "0142c01effe100196742c01eda0280bfe5c044000003000400000300f23c58ba8001000468ce0fc8",
  "hex",
);

function chunk(fmt: number, csid: number, timestamp: number, type: number, body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  let first = true;
  while (first || offset < body.length) {
    const payload = body.subarray(offset, offset + 128);
    offset += payload.length;
    if (first) {
      const header = Buffer.alloc(fmt === 0 ? 12 : 8);
      header[0] = (fmt << 6) | csid;
      header.writeUIntBE(timestamp, 1, 3);
      header.writeUIntBE(body.length, 4, 3);
      header[7] = type;
      if (fmt === 0) header.writeUInt32LE(1, 8);
      parts.push(header, payload);
      first = false;
    } else {
      parts.push(Buffer.from([0xc0 | csid]), payload);
    }
  }
  return Buffer.concat(parts);
}

function handshake(): Buffer {
  const c1 = Buffer.alloc(1536);
  c1.writeUInt32BE(0, 0);
  c1.writeUInt32BE(0, 4);
  return Buffer.concat([Buffer.from([3]), c1, Buffer.alloc(1536)]);
}

function rtmpFixture(): Buffer {
  const tags: Buffer[] = [
    chunk(0, 6, 0, 9, Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0]), AVC_CONFIG])),
    chunk(0, 4, 0, 8, Buffer.from([0xaf, 0, 0x12, 0x10])),
  ];
  for (let i = 1; i <= 20; i++) {
    const body = Buffer.alloc(305, i);
    body.set([0x27, 1, 0, 0, 0], 0);
    tags.push(chunk(1, 6, 33, 9, body));
  }
  for (let i = 1; i <= 30; i++) {
    const body = Buffer.alloc(105, i);
    body.set([0xaf, 1], 0);
    tags.push(chunk(1, 4, 23, 8, body));
  }
  return Buffer.concat([handshake(), ...tags]);
}

test("RTMP timestamps do not drift when TCP chunks split messages", () => {
  const stream = rtmpFixture();
  for (const feedSize of [1, 7, 31, 128, 1536, stream.length]) {
    let videoPts = 0;
    let audioPts = 0;
    let videos = 0;
    let audios = 0;
    const session = new RtmpSession(
      { write: () => true, destroyed: false } as never,
      {
        onVideoConfig: () => undefined,
        onAudioConfig: () => undefined,
        onSample: (sample) => {
          if (sample.kind === "video") {
            videos++;
            videoPts = sample.ptsMs;
          } else {
            audios++;
            audioPts = sample.ptsMs;
          }
        },
        onError: (error) => {
          throw error;
        },
      },
    );
    for (let offset = 0; offset < stream.length; offset += feedSize) {
      session.feed(stream.subarray(offset, offset + feedSize));
    }
    assert.equal(videos, 20, `video count at feed size ${feedSize}`);
    assert.equal(audios, 30, `audio count at feed size ${feedSize}`);
    assert.equal(videoPts, 660, `video timestamp at feed size ${feedSize}`);
    assert.equal(audioPts, 690, `audio timestamp at feed size ${feedSize}`);
  }
});
