import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeH264 } from "../src/h264.ts";
import { audioSpecificConfig, silentFrame } from "../src/aac.ts";
import {
  makeFragmentedMp4,
  parseMp4,
  type TrackInit,
  type FragmentInput,
} from "../src/mp4.ts";

function buildTiny(): { bytes: Uint8Array; tracks: TrackInit[] } {
  const h264 = makeH264({ width: 16, height: 16 });
  const aac = { sampleRate: 44100, channels: 1 };
  const tracks: TrackInit[] = [
    {
      id: 1, kind: "video", timescale: 90000,
      width: 16, height: 16, avcC: h264.avcC,
    },
    {
      id: 2, kind: "audio", timescale: 44100,
      audioSpecificConfig: audioSpecificConfig(aac),
      sampleRate: 44100, channels: 1,
    },
  ];
  const silent = silentFrame(aac);
  const fragments: FragmentInput[] = [];
  let vDts = 0n;
  let aDts = 0n;
  for (let f = 0; f < 3; f++) {
    fragments.push({
      sequenceNumber: f + 1,
      tracks: [
        {
          trackId: 1,
          baseDecodeTime: vDts,
          samples: Array.from({ length: 50 }, () => ({
            data: h264.sample, duration: 3600,
          })),
        },
        {
          trackId: 2,
          baseDecodeTime: aDts,
          samples: Array.from({ length: 86 }, () => ({
            data: silent, duration: 1024,
          })),
        },
      ],
    });
    vDts += 50n * 3600n;
    aDts += 86n * 1024n;
  }
  return { bytes: makeFragmentedMp4(tracks, fragments), tracks };
}

test("fMP4 往返：写出的样本表能原样读回", () => {
  const { bytes } = buildTiny();
  const info = parseMp4(bytes);
  assert.equal(info.fragmented, true);
  assert.equal(info.tracks.length, 2);
  const video = info.tracks.find((t) => t.kind === "video")!;
  const audio = info.tracks.find((t) => t.kind === "audio")!;
  assert.equal(video.codec, "avc1");
  assert.equal(audio.codec, "mp4a");
  assert.equal(video.timescale, 90000);
  assert.equal(audio.timescale, 44100);
  assert.equal(video.samples.length, 150);
  assert.equal(audio.samples.length, 258);
  // 视频 DTS 严格等差 3600
  for (let i = 0; i < 150; i++) {
    assert.equal(video.samples[i].dts, BigInt(i) * 3600n);
    assert.equal(video.samples[i].duration, 3600);
    assert.equal(video.samples[i].sync, true);
  }
  for (let i = 0; i < 258; i++) {
    assert.equal(audio.samples[i].dts, BigInt(i) * 1024n);
  }
  // 样本载荷偏移有效：视频样本首字节应为 IDR NAL 头 0x65
  assert.equal(bytes[video.samples[0].dataOffset + 4], 0x65);
});

test("ffmpeg 能解码生成的 fMP4（无错误、帧数正确）", (t) => {
  let hasFfmpeg = true;
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    hasFfmpeg = false;
  }
  if (!hasFfmpeg) {
    t.skip("ffmpeg 不可用，跳过解码验证");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "mp4test-"));
  try {
    const file = join(dir, "tiny.mp4");
    writeFileSync(file, buildTiny().bytes);
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", file, "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const probe = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-count_frames", "-show_entries", "stream=nb_read_frames",
      "-of", "csv=p=0", file,
    ]).toString().trim();
    assert.equal(probe, "150");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
