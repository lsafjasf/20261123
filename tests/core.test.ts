import test from "node:test";
import assert from "node:assert/strict";
import { buildTestProject, projectDuration } from "../src/content.ts";
import {
  cropAtCut,
  projectSafeUnion,
  resolveCrop,
  shotIndexAt,
} from "../src/crop.ts";
import { buildVtt, formatTimestamp, wrapCaption } from "../src/subtitles.ts";
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from "../src/types.ts";
import { muxWebM, sizeVint } from "../src/webm.ts";
import { crc32, createZip } from "../src/zip.ts";
import { buildManifest } from "../src/manifest.ts";

test("generated interview contains six timed shots", () => {
  const project = buildTestProject();
  assert.equal(project.shots.length, 6);
  assert.ok(projectDuration(project) > 24);
  assert.equal(shotIndexAt(project, 0), 0);
  assert.equal(shotIndexAt(project, project.shots[3].start + 0.2), 3);
});

test("subject and gesture safety union stays in the portrait crop", () => {
  const project = buildTestProject();
  for (const shot of project.shots) {
    const crop = cropAtCut(project, shot);
    const union = projectSafeUnion(shot)!;
    assert.ok(union.x >= crop.left - 0.01);
    assert.ok(union.x + union.w <= crop.left + crop.width + 0.01);
    assert.ok(crop.drawH <= OUTPUT_HEIGHT + 0.01);
    assert.ok(crop.drawW === OUTPUT_WIDTH);
  }
});

test("all crops keep portrait aspect geometry", () => {
  const project = buildTestProject();
  const frames = [];
  for (let t = 0.7; t < projectDuration(project); t += 0.25) {
    frames.push(resolveCrop(project, t).frame);
  }
  assert.equal(frames.length > 90, true);
  for (const frame of frames) {
    assert.ok(frame.left >= -0.01);
    assert.ok(frame.width > 0);
    assert.ok(frame.left + frame.width <= 1920.01);
  }
});

test("every active key gesture remains inside the animated crop", () => {
  const project = buildTestProject();
  for (const shot of project.shots) {
    for (let t = shot.gesture.start; t <= shot.gesture.end; t += 0.1) {
      const frame = resolveCrop(project, t).frame;
      const gesture = shot.gesture.rect;
      assert.ok(
        gesture.x >= frame.left - 1,
        `${shot.id} gesture left crosses crop at ${t.toFixed(2)}s`,
      );
      assert.ok(
        gesture.x + gesture.w <= frame.left + frame.width + 1,
        `${shot.id} gesture right crosses crop at ${t.toFixed(2)}s`,
      );
    }
  }
});

test("pre-roll pans arrive at the next shot without a framing jump", () => {
  const project = buildTestProject();
  for (let index = 0; index < project.shots.length - 1; index += 1) {
    const boundary = project.shots[index].end;
    const before = resolveCrop(project, boundary - 0.0001).frame;
    const after = resolveCrop(project, boundary + 0.0001).frame;
    assert.ok(Math.abs(before.left - after.left) < 0.5);
    assert.ok(Math.abs(before.width - after.width) < 0.5);
  }
});

test("subtitle export is valid WebVTT and wraps long Chinese text", () => {
  const project = buildTestProject();
  const vtt = buildVtt(project);
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /00:00:00\.600 --> 00:00:04\.800/);
  assert.equal(vtt.trim().split("\n\n").length, 7);
  assert.equal(formatTimestamp(3661.234), "01:01:01.234");
  assert.equal(wrapCaption("这是一句需要自动换行的测试字幕", 8).length, 2);
});

test("WebM muxer emits both video and audio track descriptors", () => {
  const video = [{
    data: new Uint8Array([1, 2, 3, 4]),
    timestamp: 0,
    duration: 33333,
    key: true,
  }];
  const audio = [{
    data: new Uint8Array([5, 6, 7]),
    timestamp: 0,
    duration: 20000,
  }];
  const bytes = muxWebM(video, {
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    fps: 30,
    duration: 1,
    audioChunks: audio,
  });
  const text = new TextEncoder().encode(new TextDecoder("latin1").decode(bytes));
  const ascii = new TextDecoder("latin1").decode(text);
  assert.deepEqual([...bytes.slice(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  assert.match(ascii, /webm/);
  assert.match(ascii, /V_VP8/);
  assert.match(ascii, /A_OPUS/);
  assert.ok(bytes.length > 100);
  assert.deepEqual([...sizeVint(0)], [0x80]);
  assert.deepEqual([...sizeVint(127)], [0x40, 0x7f]);
});

test("delivery zip uses standard local headers and CRC32", () => {
  const payload = new TextEncoder().encode("123456789");
  assert.equal(crc32(payload), 0xcbf43926);
  const zip = createZip([{ name: "edit-parameters.json", data: payload }]);
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.match(new TextDecoder().decode(zip), /edit-parameters\.json/);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
});

test("edit manifest carries every shot's crop and safety parameters", () => {
  const project = buildTestProject();
  const json = JSON.parse(buildManifest(project, {
    includeAudio: true,
    burnCaptions: true,
    videoCodec: "V_VP8",
    audioCodec: "A_OPUS",
  }));
  assert.equal(json.shots.length, 6);
  for (const shot of json.shots) {
    assert.equal(typeof shot.cropWindow.x, "number");
    assert.equal(typeof shot.subjectBox.x, "number");
    assert.equal(typeof shot.keyGesture.box.x, "number");
    assert.equal(typeof shot.motionTarget.x, "number");
    assert.equal(typeof shot.framing.easing, "string");
  }
});
