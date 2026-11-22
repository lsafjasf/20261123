import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CachingRangeReader,
  MemoryRangeReader,
  demuxMp4,
  readSampleData
} from "../src/mp4.ts";
import { buildFrameTimeline } from "../src/timeline.ts";

test("解析长 GOP、双音轨 MP4 的 sample table", async () => {
  const bytes = await readFile(new URL("../public/media/demo-video.mp4", import.meta.url));
  const media = await demuxMp4(new MemoryRangeReader(bytes));
  assert.equal(media.videoTracks.length, 1);
  assert.equal(media.audioTracks.length, 2);
  const video = media.videoTracks[0];
  assert.equal(video.codec, "avc1.4d4016");
  assert.equal(video.samples.length, 144);
  assert.equal(video.samples.filter((sample) => sample.isSync).length, 3);
  assert.equal(video.description.length, 40);
  assert.equal(media.audioTracks[0].codec, "mp4a.40.2");
  assert.equal(media.audioTracks[0].samples.length, 564);
  assert.equal(media.audioTracks[0].description.length, 5);

  const timeline = buildFrameTimeline(video);
  assert.equal(timeline.frames.length, 144);
  assert.equal(timeline.fps, 12);
  assert.equal(timeline.frames[0].ctsSeconds, 0);
  assert.equal(timeline.frames[0].isKeyframe, true);
  assert.equal(timeline.frames[48].isKeyframe, true);
  assert.equal(timeline.frames[96].isKeyframe, true);
  assert.equal(timeline.frames[3].decodeIndex, 4);
});

test("按字节范围读取样本并通过缓存读取器保持一致", async () => {
  const bytes = await readFile(new URL("../public/media/demo-video.mp4", import.meta.url));
  const memory = new MemoryRangeReader(bytes);
  const media = await demuxMp4(memory);
  const sample = media.videoTracks[0].samples[0];
  const direct = await readSampleData(memory, media.videoTracks[0], sample);
  assert.equal(direct.length, sample.size);
  assert.equal(direct[0], 0);
  assert.equal(direct[1], 0);
  const firstNalLength = new DataView(direct.buffer, direct.byteOffset, 4).getUint32(0);
  assert.ok(firstNalLength > 0 && firstNalLength < direct.length);

  const cached = new CachingRangeReader(memory, 1024, 4);
  const remuxed = await demuxMp4(cached);
  const viaCache = await readSampleData(cached, remuxed.videoTracks[0], remuxed.videoTracks[0].samples[0]);
  assert.deepEqual(Array.from(viaCache), Array.from(direct));
});
