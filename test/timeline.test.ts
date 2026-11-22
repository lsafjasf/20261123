import assert from "node:assert/strict";
import test from "node:test";
import type { Sample, VideoTrack } from "../src/mp4.ts";
import { buildFrameTimeline, formatTimecode } from "../src/timeline.ts";
import { frameTimestampUs } from "../src/video-engine.ts";

function makeTrack(gopSize = 48, gopCount = 3): VideoTrack {
  const samples: Sample[] = [];
  const baseTicks = 3000;
  const frameTicks = 1000;
  for (let gop = 0; gop < gopCount; gop += 1) {
    const displayOrder: number[] = [0];
    for (let offset = 2; offset < gopSize - 1; offset += 2) {
      displayOrder.push(offset, offset - 1);
    }
    displayOrder.push(gopSize - 1);
    for (let decodeIndex = 0; decodeIndex < displayOrder.length; decodeIndex += 1) {
      const displayIndex = displayOrder[decodeIndex];
      const absoluteDisplay = gop * gopSize + displayIndex;
      samples.push({
        decodeIndex: gop * gopSize + decodeIndex,
        offset: 0,
        size: 1,
        dtsTicks: decodeIndex * frameTicks,
        ctsTicks: baseTicks + absoluteDisplay * frameTicks,
        durationTicks: frameTicks,
        isSync: displayIndex === 0
      });
    }
  }
  return {
    kind: "video",
    id: 1,
    trackId: 7,
    timescale: 12000,
    durationTicks: gopSize * gopCount * frameTicks,
    language: "",
    samples,
    sampleCache: new Map(),
    width: 640,
    height: 360,
    codec: "avc1.4d4016",
    description: new Uint8Array()
  };
}

test("B 帧按显示时间排序，并保留解码序与 GOP 映射", () => {
  const timeline = buildFrameTimeline(makeTrack());
  assert.equal(timeline.frames.length, 144);
  assert.equal(timeline.fps, 12);
  assert.equal(timeline.frames[1].decodeIndex, 2);
  assert.equal(timeline.frames[2].decodeIndex, 1);
  assert.equal(timeline.frameForDecodeIndex(1)?.frameNumber, 2);
  assert.equal(timeline.frames[47].gopId, 0);
  assert.equal(timeline.frames[48].gopId, 48);
  assert.equal(timeline.frames[96].isKeyframe, true);
  assert.equal(timeline.gopFrames(48).length, 48);
  assert.equal(timeline.gopFrames(48)[0].gopKeyframeFrame, 48);
});

test("连续十次单帧操作每次都基于目标帧前进一帧", () => {
  const timeline = buildFrameTimeline(makeTrack());
  let target = 3;
  for (let operation = 0; operation < 10; operation += 1) {
    target = timeline.navigationTarget(target, 1);
    assert.equal(target, 4 + operation);
  }
  assert.equal(target, 13);
  assert.equal(timeline.navigationTarget(target, 10), 23);
  assert.equal(timeline.navigationTarget(140, 10), 143);
  assert.equal(timeline.navigationTarget(2, -10), 0);
});

test("时间查询与 SMPTE 时间码使用显示序", () => {
  const timeline = buildFrameTimeline(makeTrack());
  assert.equal(timeline.frameAtTime(0).frameNumber, 0);
  assert.equal(timeline.frameAtTime(0.25 + 0.0001).frameNumber, 3);
  assert.equal(timeline.frameAtTime(99).frameNumber, 143);
  assert.equal(formatTimecode(timeline.frames[25], 12), "00:00:02:01");
});

test("视频 chunk 时间戳以显示序 0 为起点且不回退", () => {
  const timeline = buildFrameTimeline(makeTrack());
  const timestamps = timeline.frames.slice(0, 8).map(frameTimestampUs);
  assert.equal(timestamps[0], 0);
  assert.equal(timestamps[1], 83333);
  assert.equal(timestamps[2], 166667);
  assert.equal(new Set(timestamps).size, timestamps.length);
  for (let index = 1; index < timestamps.length; index += 1) {
    assert.ok(timestamps[index] > timestamps[index - 1]);
  }
});
