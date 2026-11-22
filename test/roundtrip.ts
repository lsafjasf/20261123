// Node 端全链路测试：合成 MP4 -> 解封装 -> 剪辑计划 -> 重封装 -> 再解封装校验。
// 运行: node test/roundtrip.ts
import assert from "node:assert/strict";
import { mux, buildAvc1Entry, type MuxSample } from "../src/core/mp4/mux.ts";
import { Writer } from "../src/core/mp4/boxes.ts";
import { demux, sampleData } from "../src/core/mp4/demux.ts";
import { buildPlan, resolveSegment, keepRanges } from "../src/core/edit/plan.ts";
import { buildOutput } from "../src/core/edit/export.ts";

const VTS = 15360; // 视频时间基
const FD = 512; // 30fps
const N = 300; // 10s
const ATS = 44100;
const AD = 1024;

// 展示序 p(i)：模拟 B 帧重排 [0,2,1,4,3,...]
const pOrder = (i: number): number => (i === 0 ? 0 : i % 2 === 1 ? i + 1 : i - 1);

function fakeMp4aEntry(): Uint8Array {
  const w = new Writer();
  w.u32(36).str("mp4a");
  w.u32(0).u16(0).u16(1); // reserved + dref
  w.u32(0).u32(0); // reserved
  w.u16(2).u16(16).u16(0).u16(0);
  w.u32(44100 << 16);
  return w.concat();
}

function makeMovie(): Uint8Array {
  const videoSamples: MuxSample[] = [];
  for (let i = 0; i < N; i++) {
    const data = new Uint8Array(8);
    videoSamples.push({
      data,
      duration: FD,
      ctsOffset: FD * (pOrder(i) - i),
      keyframe: i % 60 === 0,
      desc: 0,
    });
  }
  videoSamples.forEach((s, i) => {
    s.data[0] = i & 0xff;
    s.data[1] = (i >> 8) & 0xff;
  });
  const aCount = Math.ceil((N * FD * ATS) / VTS / AD);
  const audioSamples: MuxSample[] = [];
  for (let i = 0; i < aCount; i++) {
    audioSamples.push({
      data: Uint8Array.of(0xaa, i & 0xff),
      duration: AD,
      ctsOffset: i === 0 ? AD : 0, // 模拟 AAC priming
      keyframe: true,
      desc: 0,
    });
  }
  return mux({
    majorBrand: "isom",
    minorVersion: 512,
    compatBrands: ["isom", "iso2", "avc1", "mp41"],
    movieTimescale: 1000,
    tracks: [
      {
        kind: "video",
        timescale: VTS,
        stsdEntries: [buildAvc1Entry(1920, 1080, Uint8Array.of(1, 100, 0, 31))],
        width: 1920,
        height: 1080,
        samples: videoSamples,
        mediaTimeOffset: 0,
      },
      {
        kind: "audio",
        timescale: ATS,
        stsdEntries: [fakeMp4aEntry()],
        width: 0,
        height: 0,
        samples: audioSamples,
        mediaTimeOffset: AD,
      },
    ],
  });
}

const bytes = makeMovie();
const movie = demux(bytes);

// ---- 解封装校验 ----
assert.equal(movie.tracks.length, 2);
const [vt, at] = movie.tracks;
assert.equal(vt.kind, "video");
assert.equal(vt.timescale, VTS);
assert.equal(vt.samples.length, N);
assert.equal(at.timescale, ATS);
assert.equal(vt.samples[0].keyframe, true);
assert.equal(vt.samples[1].keyframe, false);
assert.equal(vt.samples[60].keyframe, true);
assert.equal(vt.samples[2].cts, FD * 1); // 重排：解码序2 -> 展示1
assert.equal(vt.samples[1].cts, FD * 2);
assert.equal(at.samples[0].cts, AD); // priming 偏移
// 样本数据偏移正确
assert.equal(sampleData(movie, vt.samples[77])[0], 77);
assert.equal(sampleData(movie, at.samples[5])[1], 5);
console.log("ok: demux");

// ---- 删除区间 -> 保留段 ----
assert.deepEqual(keepRanges([{ start: 2, end: 4 }], 10), [
  { start: 0, end: 2 },
  { start: 4, end: 10 },
]);

// ---- 计划：非关键帧切点 -> pending；吸附；片尾不足一帧 ----
const plan = buildPlan(movie, [{ start: 1.01, end: 2.0 }]);
assert.equal(plan.segments.length, 2);
const [s1, s2] = plan.segments;
assert.ok(s1.notes.some((n) => n.includes("片尾不足一帧")), "尾段残帧提示");
assert.equal(s2.mode, "pending", "2.0s 非关键帧，应待决策");
assert.ok(plan.pendingCount === 1 && !plan.fullyLossless);
assert.ok(s2.snapOptions && s2.snapOptions.prev !== null);
const prevKf = s2.snapOptions!.prev!;
assert.ok(Math.abs(prevKf - (59 * FD) / VTS) < 1e-9, `prev 关键帧=${prevKf}`);
resolveSegment(movie, plan, 1, "snap-prev");
assert.equal(plan.segments[1].mode, "lossless");
assert.equal(plan.pendingCount, 0);
assert.equal(plan.fullyLossless, true);
assert.ok(plan.avDriftMaxSec <= 0.5 * (AD / ATS) + 1e-9, "音画累计偏差 < 半帧音频");
console.log("ok: plan (snap, tail, drift)", plan.finalDuration.toFixed(4), "s");

// ---- 导出（全无损）----
const out1 = await buildOutput(movie, plan);
assert.equal(out1.fullyLossless, true);
const m2 = demux(out1.data);
const v2 = m2.tracks.find((t) => t.kind === "video")!;
const a2 = m2.tracks.find((t) => t.kind === "audio")!;
const expectV = (s1.videoTo - s1.videoFrom) + (s2.videoTo - s2.videoFrom);
assert.equal(v2.samples.length, expectV);
assert.equal(v2.samples[0].keyframe, true);
assert.equal(a2.samples.length, (s1.audioTo - s1.audioFrom) + (s2.audioTo - s2.audioFrom));
// 数据逐字节一致（无损）
for (let i = 0; i < s1.videoTo - s1.videoFrom; i++) {
  assert.equal(sampleData(m2, v2.samples[i])[0], sampleData(movie, vt.samples[s1.videoFrom + i])[0]);
}
// 时长：视频轨 stts 合计 == 计划时长
const vDur = v2.samples.reduce((a, s) => a + s.duration, 0) / VTS;
assert.ok(Math.abs(vDur - plan.finalDuration) < 1e-9);
console.log("ok: export lossless, duration", vDur.toFixed(4), "s");

// ---- 转码段混合封装 ----
const plan2 = buildPlan(movie, [{ start: 1.0, end: 2.0 }]);
resolveSegment(movie, plan2, 1, "transcode");
assert.equal(plan2.fullyLossless, false);
const out2 = await buildOutput(movie, plan2, async () => ({
  stsdEntry: buildAvc1Entry(1920, 1080, Uint8Array.of(9, 9, 9, 9)),
  samples: Array.from({ length: 30 }, (_, i) => ({
    data: Uint8Array.of(0xee, i),
    duration: FD,
    ctsOffset: 0,
    keyframe: i === 0,
    desc: 0,
  })),
}));
const m3 = demux(out2.data);
const v3 = m3.tracks.find((t) => t.kind === "video")!;
assert.equal(v3.samples.length, (plan2.segments[0].videoTo - plan2.segments[0].videoFrom) + 30);
// 转码段的第二个 stsd 条目（avcC = 09 09 09 09）应写入文件
const hasSecondEntry = out2.data.some(
  (b, i) => b === 9 && out2.data[i + 1] === 9 && out2.data[i + 2] === 9 && out2.data[i + 3] === 9,
);
assert.ok(hasSecondEntry, "转码段 stsd 生效");
assert.equal(sampleData(m3, v3.samples[v3.samples.length - 1])[0], 0xee, "转码样本数据完整");
assert.equal(out2.fullyLossless, false);
console.log("ok: export mixed (lossless + transcode)");

// ---- 未确认决策禁止导出 ----
const plan3 = buildPlan(movie, [{ start: 1.0, end: 2.0 }]);
await assert.rejects(() => buildOutput(movie, plan3), /未确认/);
console.log("ok: pending decision blocks export");

console.log("ALL PASS");
