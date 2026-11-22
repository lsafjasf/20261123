import test from "node:test";
import assert from "node:assert/strict";
import { parseElement, sameId, unsignedVint, walkElements, idBytes, readUint } from "../src/shared/ebml.ts";
import {
  CLUSTER,
  CLUSTER_TIMESTAMP,
  CUE_CLUSTER_POSITION,
  CUE_POINT,
  CUE_TRACK_POSITIONS,
  CUES,
  EBML_ID,
  SEGMENT,
  SIMPLE_BLOCK,
  TRACK_ENTRY,
  TRACK_NUMBER,
  TRACKS,
} from "../src/shared/webm-ids.ts";
import { WebMMuxer, type MuxerFrame } from "../src/shared/webm-muxer.ts";

test("unsigned vint encoding follows EBML marker rules", () => {
  assert.deepEqual(Array.from(unsignedVint(1)), [0x81]);
  assert.deepEqual(Array.from(unsignedVint(0)), [0x80]);
  assert.deepEqual(Array.from(unsignedVint(200)), [0x40, 0xc8]);
  assert.deepEqual(Array.from(unsignedVint(128)), [0x40, 0x80]);
  assert.deepEqual(Array.from(unsignedVint(16383)), [0x7f, 0xff]);
  assert.deepEqual(Array.from(unsignedVint(16384)), [0x20, 0x40, 0x00]);
  assert.equal(unsignedVint(745).byteLength, 2);
});

test("muxed bytes parse into EBML header and segment", () => {
  const muxer = new WebMMuxer([
    {
      kind: "video",
      number: 1,
      codec: "vp9",
      video: { width: 640, height: 360, fps: 30, bitrate: 1_000_000, codec: "vp9" },
    },
    { kind: "audio", number: 2, sampleRate: 48000, channels: 2 },
  ]);

  muxer.addFrame({
    trackNumber: 2,
    timestampMs: 0,
    data: new TextEncoder().encode("OpusHead fake header"),
    keyframe: false,
  });
  muxer.addFrame({
    trackNumber: 2,
    timestampMs: 0,
    data: new TextEncoder().encode("OpusTags fake tags"),
    keyframe: false,
  });

  const frames: MuxerFrame[] = [];
  for (let i = 0; i < 90; i += 1) {
    frames.push({
      trackNumber: 1,
      timestampMs: i * (1000 / 30),
      data: Uint8Array.of(0x99, i & 0xff, 0x01),
      keyframe: i % 30 === 0,
    });
    if (i % 6 === 0) {
      frames.push({
        trackNumber: 2,
        timestampMs: i * 20,
        data: Uint8Array.of(0xf8, i & 0xff),
        keyframe: false,
      });
    }
  }
  frames.sort((a, b) => a.timestampMs - b.timestampMs || a.trackNumber - b.trackNumber);
  for (const frame of frames) {
    muxer.addFrame(frame);
  }

  const bytes = muxer.build();
  const header = parseElement(bytes, 0);
  assert.ok(header && sameId(header.id, idBytes(EBML_ID)));
  const segment = parseElement(bytes, header.dataOffset + header.dataSize);
  assert.ok(segment && sameId(segment.id, idBytes(SEGMENT)));

  let sawTracks = false;
  let sawCues = false;
  let clusterCount = 0;
  let blockCount = 0;
  const actualClusterPositions: number[] = [];
  const cuePositions: number[] = [];
  const trackNumbers: number[] = [];
  for (const child of walkElements(bytes, segment.dataOffset, segment.dataOffset + segment.dataSize)) {
    if (sameId(child.id, idBytes(TRACKS))) {
      sawTracks = true;
      for (const entry of walkElements(bytes, child.dataOffset, child.dataOffset + child.dataSize)) {
        if (sameId(entry.id, idBytes(TRACK_ENTRY))) {
          for (const field of walkElements(bytes, entry.dataOffset, entry.dataOffset + entry.dataSize)) {
            if (sameId(field.id, idBytes(TRACK_NUMBER))) {
              trackNumbers.push(readUint(bytes, field));
            }
          }
        }
      }
    }
    if (sameId(child.id, idBytes(CUES))) {
      sawCues = true;
      for (const point of walkElements(bytes, child.dataOffset, child.dataOffset + child.dataSize)) {
        if (!sameId(point.id, idBytes(CUE_POINT))) {
          continue;
        }
        for (const positions of walkElements(bytes, point.dataOffset, point.dataOffset + point.dataSize)) {
          if (!sameId(positions.id, idBytes(CUE_TRACK_POSITIONS))) {
            continue;
          }
          for (const field of walkElements(bytes, positions.dataOffset, positions.dataOffset + positions.dataSize)) {
            if (sameId(field.id, idBytes(CUE_CLUSTER_POSITION))) {
              cuePositions.push(readUint(bytes, field));
            }
          }
        }
      }
    }
    if (sameId(child.id, idBytes(CLUSTER))) {
      actualClusterPositions.push(child.dataOffset - child.headerSize);
      clusterCount += 1;
      for (const block of walkElements(bytes, child.dataOffset, child.dataOffset + child.dataSize)) {
        if (sameId(block.id, idBytes(CLUSTER_TIMESTAMP))) {
          assert.ok(readUint(bytes, block) >= 0);
        }
        if (sameId(block.id, idBytes(SIMPLE_BLOCK))) {
          blockCount += 1;
        }
      }
    }
  }
  assert.ok(sawTracks);
  assert.ok(sawCues);
  assert.ok(clusterCount >= 2);
  assert.deepEqual(trackNumbers.sort((a, b) => a - b), [1, 2]);
  assert.equal(blockCount, frames.filter((frame) => frame.trackNumber === 1).length + frames.filter((frame) => frame.trackNumber === 2).length);
  assert.ok(cuePositions.length >= 1);
  for (const position of cuePositions) {
    assert.ok(actualClusterPositions.includes(position), `cue points to unknown cluster ${position}`);
  }
});
