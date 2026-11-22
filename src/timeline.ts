// 时间线核查：把各机位片段按真实开机时刻排到全局线上，
// 标出重叠、空洞、非单调时间与累计漂移。全程整数 tick 运算。

import {
  ticks,
  convertRound,
  frameDuration,
  frameTicksAt,
  formatSeconds,
  type Ticks,
} from "./time.ts";
import { parseMp4, type TrackSamples } from "./mp4.ts";
import {
  GLOBAL_TIMESCALE,
  type Manifest,
  type CameraSpec,
  type ClipSpec,
} from "./model.ts";

export interface NonMonotonicHit {
  sampleIndex: number;
  prevDts: bigint;
  dts: bigint;
}

export interface ClipAnalysis {
  camera: string;
  file: string;
  wallStart: Ticks; // 全局线
  wallEnd: Ticks; // wallStart + 理想内容时长
  contentEnd: Ticks; // wallStart + 文件实际时长（断电截断时 < wallEnd）
  sampleCount: number;
  declaredFps: string;
  idealFrameTicks: { num: bigint; den: bigint };
  measuredAvgDelta: string; // 有理数 "num/den"
  nonMonotonic: NonMonotonicHit[];
  driftTicks: bigint; // 实际总跨度 - 理想总跨度（视频轨刻度）
  faults: string[]; // NON_MONOTONIC / DRIFT / TRUNCATED / GAP_BEFORE / OVERLAP_BEFORE
  video: TrackSamples;
  audio: TrackSamples | undefined;
}

export interface LineEvent {
  kind: "GAP" | "OVERLAP";
  camera: string;
  afterClip: string;
  beforeClip: string;
  duration: Ticks; // 全局线
}

export interface CameraLine {
  camera: string;
  clips: ClipAnalysis[];
  events: LineEvent[];
}

export interface Timeline {
  globalTimescale: number;
  cameras: CameraLine[];
}

function analyzeClip(
  cam: CameraSpec,
  clip: ClipSpec,
  fileBytes: Uint8Array,
): ClipAnalysis {
  const info = parseMp4(fileBytes);
  const video = info.tracks.find((t) => t.kind === "video");
  if (!video) throw new Error(`${clip.file}: 缺少视频轨`);
  const audio = info.tracks.find((t) => t.kind === "audio");

  const samples = video.samples;
  const nonMonotonic: NonMonotonicHit[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].dts <= samples[i - 1].dts) {
      nonMonotonic.push({
        sampleIndex: i,
        prevDts: samples[i - 1].dts,
        dts: samples[i].dts,
      });
    }
  }

  const fd = frameDuration(cam.fpsNum, cam.fpsDen, video.timescale);
  const n = BigInt(samples.length);
  const idealLast = frameTicksAt(n - 1n, fd.num, fd.den);
  const idealSpan =
    n > 0n ? idealLast + frameTicksAt(1n, fd.num, fd.den) : 0n;
  const actualSpan = samples.length
    ? samples[samples.length - 1].dts - samples[0].dts +
      BigInt(samples[samples.length - 1].duration)
    : 0n;
  const drift = actualSpan - idealSpan;

  let measuredAvg = "0/1";
  if (samples.length > 1) {
    const total = samples[samples.length - 1].dts - samples[0].dts;
    const den = BigInt(samples.length - 1);
    measuredAvg = `${total}/${den}`;
  }

  const wallStart = ticks(BigInt(clip.wallStartMs) * 90n, GLOBAL_TIMESCALE);
  // 声明内容时长（来自清单/场记），用于识别断电截断
  const declaredDurGlobal = BigInt(clip.durationMs) * 90n;
  const actualDurGlobal = convertRound(
    ticks(actualSpan, video.timescale),
    GLOBAL_TIMESCALE,
  ).ticks;

  const faults: string[] = [];
  if (nonMonotonic.length > 0) faults.push("NON_MONOTONIC");
  const driftAbs = drift < 0n ? -drift : drift;
  const oneMs = BigInt(video.timescale) / 1000n;
  if (driftAbs > oneMs || (n > 0n && driftAbs * 2n > n)) faults.push("DRIFT");
  if (clip.faults?.gapBeforeMs) faults.push("GAP_BEFORE");
  if (clip.faults?.overlapBeforeMs) faults.push("OVERLAP_BEFORE");
  // 实际内容明显短于声明时长（>0.5s）视为截断；小差额由 DRIFT 解释
  if (declaredDurGlobal - actualDurGlobal > 45_000n) faults.push("TRUNCATED");

  return {
    camera: cam.id,
    file: clip.file,
    wallStart,
    wallEnd: {
      ticks: wallStart.ticks + declaredDurGlobal,
      timescale: GLOBAL_TIMESCALE,
    },
    contentEnd: {
      ticks: wallStart.ticks + actualDurGlobal,
      timescale: GLOBAL_TIMESCALE,
    },
    sampleCount: samples.length,
    declaredFps: `${cam.fpsNum}/${cam.fpsDen}`,
    idealFrameTicks: { num: fd.num, den: fd.den },
    measuredAvgDelta: measuredAvg,
    nonMonotonic,
    driftTicks: drift,
    faults,
    video,
    audio,
  };
}

export function buildTimeline(
  manifest: Manifest,
  readFile: (path: string) => Uint8Array,
): Timeline {
  const cameras: CameraLine[] = [];
  for (const cam of manifest.cameras) {
    const clips: ClipAnalysis[] = [];
    const events: LineEvent[] = [];
    const sorted = [...cam.clips].sort((a, b) => a.wallStartMs - b.wallStartMs);
    for (const clip of sorted) {
      const analysis = analyzeClip(cam, clip, readFile(clip.file));
      const prev = clips[clips.length - 1];
      if (prev) {
        const delta = analysis.wallStart.ticks - prev.contentEnd.ticks;
        if (delta > 0n) {
          events.push({
            kind: "GAP",
            camera: cam.id,
            afterClip: prev.file,
            beforeClip: analysis.file,
            duration: { ticks: delta, timescale: GLOBAL_TIMESCALE },
          });
        } else if (delta < 0n) {
          events.push({
            kind: "OVERLAP",
            camera: cam.id,
            afterClip: prev.file,
            beforeClip: analysis.file,
            duration: { ticks: -delta, timescale: GLOBAL_TIMESCALE },
          });
        }
      }
      clips.push(analysis);
    }
    cameras.push({ camera: cam.id, clips, events });
  }
  return { globalTimescale: manifest.globalTimescale, cameras };
}

// 文本报告：每个机位一条线，片段位置、事件与故障一目了然。
export function formatTimeline(tl: Timeline): string {
  const out: string[] = [];
  for (const cam of tl.cameras) {
    out.push(`机位 ${cam.camera}`);
    for (const clip of cam.clips) {
      const span = `${formatSeconds(clip.wallStart)}s -> ${formatSeconds(clip.contentEnd)}s`;
      const flag = clip.faults.length ? `  [${clip.faults.join(",")}]` : "";
      out.push(
        `  ${clip.file}  ${span}  样本=${clip.sampleCount} 漂移=${clip.driftTicks}tick${flag}`,
      );
      for (const hit of clip.nonMonotonic.slice(0, 5)) {
        out.push(
          `    非单调 @样本${hit.sampleIndex}: ${hit.prevDts} -> ${hit.dts}`,
        );
      }
      if (clip.nonMonotonic.length > 5) {
        out.push(`    …另有 ${clip.nonMonotonic.length - 5} 处非单调`);
      }
    }
    for (const ev of cam.events) {
      const label = ev.kind === "GAP" ? "空洞" : "重叠";
      out.push(
        `  ${label} ${formatSeconds(ev.duration)}s  (${ev.afterClip} ~ ${ev.beforeClip})`,
      );
    }
  }
  return out.join("\n");
}
