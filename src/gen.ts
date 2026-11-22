// 程序化构造四机位婚礼测试素材：
// 真实可解码的 fMP4（手工 H.264 黑帧 + AAC 静音），并注入典型现场故障——
// 换卡空洞、断电截断、tfdt 重复（非单调）、采样抖动、帧率误标漂移。

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { makeH264 } from "./h264.ts";
import { audioSpecificConfig, silentFrame, AAC_FRAME_SAMPLES } from "./aac.ts";
import {
  makeFragmentedMp4,
  type TrackInit,
  type FragmentInput,
} from "./mp4.ts";
import { frameDuration } from "./time.ts";
import {
  VIDEO_TIMESCALE,
  AUDIO_TIMESCALE,
  type CameraSpec,
  type ClipSpec,
  type Manifest,
} from "./model.ts";

const FRAGMENT_VIDEO_FRAMES = 50; // 每碎片 50 帧（25fps 下 2 秒）

interface GenContext {
  tracks: TrackInit[];
  idrSample: Uint8Array;
  silent: Uint8Array;
}

function makeContext(cam: CameraSpec): GenContext {
  const h264 = makeH264({ width: cam.width, height: cam.height });
  const aacCfg = { sampleRate: cam.audioSampleRate, channels: 1 };
  return {
    tracks: [
      {
        id: 1, kind: "video", timescale: VIDEO_TIMESCALE,
        width: cam.width, height: cam.height, avcC: h264.avcC,
      },
      {
        id: 2, kind: "audio", timescale: AUDIO_TIMESCALE,
        audioSpecificConfig: audioSpecificConfig(aacCfg),
        sampleRate: cam.audioSampleRate, channels: 1,
      },
    ],
    idrSample: h264.sample,
    silent: silentFrame(aacCfg),
  };
}

// 单个 clip -> fMP4 字节。故障在此注入。
function buildClip(ctx: GenContext, cam: CameraSpec, clip: ClipSpec): Uint8Array {
  const faults = clip.faults ?? {};
  // 写入时间戳所用的帧率：正常为真实帧率，fpsAssumed 故障时误用别的
  const [fpsN, fpsD] = faults.fpsAssumed ?? [cam.fpsNum, cam.fpsDen];
  const fd = frameDuration(fpsN, fpsD, VIDEO_TIMESCALE);
  if (fd.den !== 1n) throw new Error("测试素材要求帧时长为整数 tick");
  const frameTicks = Number(fd.num);

  const totalFrames = Math.round(
    (clip.durationMs / 1000) * (cam.fpsNum / cam.fpsDen),
  );
  const totalAudioFrames = Math.ceil(
    (clip.durationMs / 1000) * (AUDIO_TIMESCALE / AAC_FRAME_SAMPLES),
  );

  const fragments: FragmentInput[] = [];
  let vDts = 0n;
  let aDts = 0n;
  let vIndex = 0;
  let aIndex = 0;
  let fragIndex = 0;
  let prevVideoTfdt = 0n;
  while (vIndex < totalFrames) {
    const vCount = Math.min(FRAGMENT_VIDEO_FRAMES, totalFrames - vIndex);
    const vStart = vDts;
    // 视频样本时长：jitter 故障时 3600/3601 交替
    const durations: number[] = [];
    for (let i = 0; i < vCount; i++) {
      let d = frameTicks;
      if (faults.jitterDurations && (vIndex + i) % 2 === 1) d += 1;
      durations.push(d);
    }
    // 音频：覆盖本碎片视频时间窗内的 AAC 帧（精确整数换算）
    const vEnd = vStart + BigInt(durations.reduce((a, b) => a + b, 0));
    const aStart = Number(
      (vStart * BigInt(AUDIO_TIMESCALE)) /
        (BigInt(VIDEO_TIMESCALE) * BigInt(AAC_FRAME_SAMPLES)),
    );
    let aEnd = Number(
      (vEnd * BigInt(AUDIO_TIMESCALE)) /
        (BigInt(VIDEO_TIMESCALE) * BigInt(AAC_FRAME_SAMPLES)),
    );
    if (vIndex + vCount >= totalFrames) aEnd = totalAudioFrames;
    const aCount = Math.max(0, Math.min(aEnd, totalAudioFrames) - aIndex);

    // dupFragmentTfdt 故障：本碎片视频 tfdt 重复上一碎片
    const dup = (faults.dupFragmentTfdt ?? []).includes(fragIndex);
    const videoTfdt = dup ? prevVideoTfdt : vStart;

    fragments.push({
      sequenceNumber: fragIndex + 1,
      tracks: [
        {
          trackId: 1,
          baseDecodeTime: videoTfdt,
          samples: durations.map((d) => ({ data: ctx.idrSample, duration: d })),
        },
        {
          trackId: 2,
          baseDecodeTime: aDts,
          samples: Array.from({ length: aCount }, () => ({
            data: ctx.silent,
            duration: AAC_FRAME_SAMPLES,
          })),
        },
      ],
    });
    prevVideoTfdt = vStart;
    for (const d of durations) vDts += BigInt(d);
    aDts += BigInt(aCount) * BigInt(AAC_FRAME_SAMPLES);
    vIndex += vCount;
    aIndex += aCount;
    fragIndex += 1;
  }

  // 断电故障：丢掉末尾碎片
  if (faults.truncateLastFragment && fragments.length > 1) {
    fragments.pop();
  }
  return makeFragmentedMp4(ctx.tracks, fragments);
}

export function generate(manifest: Manifest, outDir: string): void {
  for (const cam of manifest.cameras) {
    const ctx = makeContext(cam);
    for (const clip of cam.clips) {
      const bytes = buildClip(ctx, cam, clip);
      const path = join(outDir, clip.file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
  }
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

// 婚礼现场四机位场景。时间线为仪式开始后的毫秒数。
export function weddingScenario(): Manifest {
  return {
    kind: "wedding-multicam-manifest",
    version: 1,
    generatedAt: new Date().toISOString(),
    globalTimescale: 90000,
    cameras: [
      {
        id: "cam1-main",
        fpsNum: 25, fpsDen: 1,
        width: 16, height: 16,
        audioSampleRate: 44100,
        clips: [
          { file: "cam1-main/clip001.mp4", wallStartMs: 0, durationMs: 150_000 },
          {
            file: "cam1-main/clip002.mp4",
            wallStartMs: 162_000, // 换卡空洞 12s
            durationMs: 120_000,
            faults: { gapBeforeMs: 12_000 },
          },
        ],
      },
      {
        id: "cam2-roam",
        fpsNum: 25, fpsDen: 1,
        width: 16, height: 16,
        audioSampleRate: 44100,
        clips: [
          { file: "cam2-roam/clip001.mp4", wallStartMs: 2_000, durationMs: 90_000 },
          {
            file: "cam2-roam/clip002.mp4",
            wallStartMs: 95_000, // 换卡空洞 3s
            durationMs: 60_000,
            faults: { gapBeforeMs: 3_000, dupFragmentTfdt: [2] },
          },
          {
            file: "cam2-roam/clip003.mp4",
            wallStartMs: 153_800, // 与上一段重叠 1.2s（尾段重复录制）
            durationMs: 45_000,
            faults: { overlapBeforeMs: 1_200 },
          },
        ],
      },
      {
        id: "cam3-fixed",
        fpsNum: 25, fpsDen: 1,
        width: 16, height: 16,
        audioSampleRate: 44100,
        clips: [
          {
            file: "cam3-fixed/clip001.mp4",
            wallStartMs: 500,
            durationMs: 75_000,
            faults: { truncateLastFragment: true }, // 断电：末尾碎片丢失
          },
          {
            file: "cam3-fixed/clip002.mp4",
            wallStartMs: 115_500, // 断电恢复，空洞 40s
            durationMs: 80_000,
            faults: { gapBeforeMs: 40_000, jitterDurations: true },
          },
        ],
      },
      {
        id: "cam4-backup",
        fpsNum: 30000, fpsDen: 1001, // 真实 29.97
        width: 16, height: 16,
        audioSampleRate: 44100,
        clips: [
          {
            file: "cam4-backup/clip001.mp4",
            wallStartMs: 1_000,
            durationMs: 360_000, // 6 分钟长素材
            // 时间戳误按 30fps 写入 -> 全程累计漂移约 -0.36s
            faults: { fpsAssumed: [30, 1] },
          },
        ],
      },
    ],
  };
}
