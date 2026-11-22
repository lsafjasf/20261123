import assert from "node:assert/strict";
import test from "node:test";
import { probeMp4File } from "../src/server/media-probe.ts";

test("MP4 probe reads duration, dimensions, codecs and audio parameters", async () => {
  const result = await probeMp4File("sample/old-drive/Footage/IMG_4821.MOV");
  assert.ok(result);
  assert.equal(result.duration, 5);
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  assert.equal(result.fps, 30);
  assert.equal(result.videoCodec, "avc1");
  assert.equal(result.audioCodec, "mp4a");
  assert.equal(result.audioChannels, 2);
  assert.equal(result.sampleRate, 48000);
});
