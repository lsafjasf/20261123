// 修复引擎：按机位把片段锚定到全局线，逐样本重打整数时间戳——
// 视频第 n 帧 = 锚点 + n×帧时长（乘法直达，绝不累加浮点秒），
// 音频第 m 帧 = 锚点 + m×1024。输出分片 fMP4 与逐样本原值/新值对照表。

import {
  ticks,
  convertRound,
  frameDuration,
  frameTicksAt,
  formatSeconds,
} from "./time.ts";
import {
  parseMp4,
  makeFragmentedMp4,
  type TrackInit,
  type FragmentInput,
  type SampleInfo,
  type TrackSamples,
} from "./mp4.ts";
import { AAC_FRAME_SAMPLES } from "./aac.ts";
import {
  GLOBAL_TIMESCALE,
  type Manifest,
  type CameraSpec,
  type ClipSpec,
} from "./model.ts";

export interface RepairOptions {
  trimOverlapHead?: boolean; // 同机位重叠时裁掉后段头部（默认 true）
  fragmentVideoFrames?: number; // 每 moof 视频帧数（默认 50）
}

export interface MapRow {
  camera: string;
  segment: string;
  track: "video" | "audio";
  sampleIndex: number;
  oldDtsTicks: string; // 文件原值（本轨刻度）
  oldTimescale: number;
  newDtsTicks: string; // 修复后（本轨刻度，机位线绝对位置）
  newTimescale: number;
  oldGlobalSeconds: string; // 原值按锚点换算到全局线的秒
  newGlobalSeconds: string;
  deltaSeconds: string; // 新 - 旧
  note: string;
}

export interface SegmentSummary {
  camera: string;
  segment: string;
  sourceClip: string;
  videoSamples: number;
  audioSamples: number;
  trimmedHeadSamples: number;
  nonMonotonicFixed: number;
  driftRemovedTicks: string; // 旧跨度 - 新跨度（视频刻度）
  anchorRoundingError: string; // 锚点换算舍入 "num/den tick"
  outFile: string;
}

export interface RepairResult {
  summaries: SegmentSummary[];
  rows: MapRow[];
  outputs: { path: string; bytes: Uint8Array }[];
}

function sliceSample(file: Uint8Array, s: SampleInfo): Uint8Array {
  return file.subarray(s.dataOffset, s.dataOffset + s.size);
}

function trackInit(t: TrackSamples): TrackInit {
  if (t.kind === "video") {
    return {
      id: t.trackId, kind: "video", timescale: t.timescale,
      width: t.width, height: t.height, avcC: t.avcC,
    };
  }
  return {
    id: t.trackId, kind: "audio", timescale: t.timescale,
    audioSpecificConfig: t.audioSpecificConfig,
    sampleRate: t.sampleRate, channels: t.channels,
  };
}

// 跨刻度比较：a/as（刻度 as）是否早于 b/bs（刻度 bs）
function earlier(a: bigint, as: bigint, b: bigint, bs: bigint): boolean {
  return a * bs < b * as;
}

interface ClipWork {
  cam: CameraSpec;
  clip: ClipSpec;
  fileBytes: Uint8Array;
  prevEndGlobal: bigint | undefined;
  segName: string;
  opts: Required<RepairOptions>;
}

interface ClipDone {
  summary: SegmentSummary;
  rows: MapRow[];
  bytes: Uint8Array;
  endGlobal: bigint;
}

function repairClip(w: ClipWork): ClipDone {
  const { cam, clip, fileBytes, opts } = w;
  const info = parseMp4(fileBytes);
  const video = info.tracks.find((t) => t.kind === "video");
  const audio = info.tracks.find((t) => t.kind === "audio");
  if (!video) throw new Error(`${clip.file}: 缺少视频轨`);

  const fd = frameDuration(cam.fpsNum, cam.fpsDen, video.timescale);
  const anchorGlobal = BigInt(clip.wallStartMs) * 90n; // ms -> 90000 整刻度
  const vAnchor = convertRound(
    ticks(anchorGlobal, GLOBAL_TIMESCALE),
    video.timescale,
  );
  const aAnchor = audio
    ? convertRound(ticks(anchorGlobal, GLOBAL_TIMESCALE), audio.timescale)
    : undefined;

  // 重叠裁剪：理想全局位置早于上一段结束的头部样本丢弃
  let vStart = 0;
  if (opts.trimOverlapHead && w.prevEndGlobal !== undefined) {
    while (vStart < video.samples.length) {
      const pos = vAnchor.ticks + frameTicksAt(BigInt(vStart), fd.num, fd.den);
      const posG = convertRound(
        ticks(pos, video.timescale),
        GLOBAL_TIMESCALE,
      ).ticks;
      if (posG >= w.prevEndGlobal) break;
      vStart += 1;
    }
  }
  let aStart = 0;
  const aSamples = audio?.samples ?? [];
  if (audio && opts.trimOverlapHead && w.prevEndGlobal !== undefined) {
    while (aStart < aSamples.length) {
      const pos = aAnchor!.ticks + BigInt(aStart) * BigInt(AAC_FRAME_SAMPLES);
      const posG = convertRound(
        ticks(pos, audio.timescale),
        GLOBAL_TIMESCALE,
      ).ticks;
      if (posG >= w.prevEndGlobal) break;
      aStart += 1;
    }
  }

  const keptVideo = video.samples.slice(vStart);
  const keptAudio = aSamples.slice(aStart);
  // 新时间戳：由保留帧的全局帧号直接乘算，误差 < 1 tick，永不累计
  const newVideoDts = keptVideo.map((_, k) =>
    vAnchor.ticks + frameTicksAt(BigInt(vStart + k), fd.num, fd.den),
  );
  const newAudioDts = keptAudio.map(
    (_, k) =>
      (aAnchor?.ticks ?? 0n) +
      BigInt(aStart + k) * BigInt(AAC_FRAME_SAMPLES),
  );

  const rows: MapRow[] = [];
  const pushRow = (
    track: "video" | "audio",
    idx: number,
    oldS: SampleInfo,
    oldScale: number,
    newDts: bigint | undefined,
    newScale: number,
    note: string,
  ) => {
    const oldOnGlobal =
      anchorGlobal +
      convertRound(ticks(oldS.dts, oldScale), GLOBAL_TIMESCALE).ticks;
    const newOnGlobal =
      newDts !== undefined
        ? convertRound(ticks(newDts, newScale), GLOBAL_TIMESCALE).ticks
        : undefined;
    rows.push({
      camera: cam.id,
      segment: w.segName,
      track,
      sampleIndex: idx,
      oldDtsTicks: oldS.dts.toString(),
      oldTimescale: oldScale,
      newDtsTicks: newDts !== undefined ? newDts.toString() : "",
      newTimescale: newScale,
      oldGlobalSeconds: formatSeconds(ticks(oldOnGlobal, GLOBAL_TIMESCALE)),
      newGlobalSeconds:
        newOnGlobal !== undefined
          ? formatSeconds(ticks(newOnGlobal, GLOBAL_TIMESCALE))
          : "",
      deltaSeconds:
        newOnGlobal !== undefined
          ? formatSeconds(ticks(newOnGlobal - oldOnGlobal, GLOBAL_TIMESCALE))
          : "",
      note,
    });
  };

  for (let i = 0; i < vStart; i++) {
    pushRow("video", i, video.samples[i], video.timescale, undefined,
      video.timescale, "TRIMMED_OVERLAP");
  }
  keptVideo.forEach((s, k) => {
    const note = k > 0 && s.dts <= video.samples[vStart + k - 1].dts
      ? "NON_MONOTONIC_FIXED"
      : "";
    pushRow("video", vStart + k, s, video.timescale, newVideoDts[k],
      video.timescale, note);
  });
  for (let i = 0; i < aStart; i++) {
    pushRow("audio", i, aSamples[i], audio!.timescale, undefined,
      audio!.timescale, "TRIMMED_OVERLAP");
  }
  keptAudio.forEach((s, k) => {
    pushRow("audio", aStart + k, s, audio!.timescale, newAudioDts[k],
      audio!.timescale, "");
  });

  // 组装碎片：视频每 opts.fragmentVideoFrames 帧一个 moof，
  // 音频帧按新时间戳落入对应视频窗口（跨刻度整数比较）
  const fragments: FragmentInput[] = [];
  const vScale = BigInt(video.timescale);
  const aScale = BigInt(audio?.timescale ?? AAC_FRAME_SAMPLES);
  let aCursor = 0;
  let seq = 1;
  for (let v0 = 0; v0 < keptVideo.length; v0 += opts.fragmentVideoFrames) {
    const v1 = Math.min(v0 + opts.fragmentVideoFrames, keptVideo.length);
    const winStart = newVideoDts[v0];
    const lastIdx = v1 - 1;
    const winEnd =
      newVideoDts[lastIdx] + frameTicksAt(1n, fd.num, fd.den);
    const a0 = aCursor;
    while (aCursor < keptAudio.length) {
      const aPos = newAudioDts[aCursor];
      if (!earlier(aPos, aScale, winEnd, vScale)) break;
      aCursor += 1;
    }
    const vSamples = keptVideo.slice(v0, v1).map((s, k) => ({
      data: sliceSample(fileBytes, s),
      duration: Number(
        (k + v0 + 1 < keptVideo.length
          ? newVideoDts[k + v0 + 1] - newVideoDts[k + v0]
          : frameTicksAt(1n, fd.num, fd.den)),
      ),
    }));
    const aFragSamples = keptAudio.slice(a0, aCursor).map((s, k) => ({
      data: sliceSample(fileBytes, s),
      duration:
        a0 + k + 1 < keptAudio.length
          ? Number(newAudioDts[a0 + k + 1] - newAudioDts[a0 + k])
          : AAC_FRAME_SAMPLES,
    }));
    const tracks = [
      { trackId: video.trackId, baseDecodeTime: winStart, samples: vSamples },
    ];
    if (audio) {
      tracks.push({
        trackId: audio.trackId,
        baseDecodeTime: a0 < keptAudio.length ? newAudioDts[a0] : 0n,
        samples: aFragSamples,
      });
    }
    fragments.push({ sequenceNumber: seq++, tracks });
  }

  const inits = audio ? [trackInit(video), trackInit(audio)] : [trackInit(video)];
  const bytes = makeFragmentedMp4(inits, fragments);

  let nonMonotonicFixed = 0;
  for (let i = 1; i < video.samples.length; i++) {
    if (video.samples[i].dts <= video.samples[i - 1].dts) nonMonotonicFixed += 1;
  }
  const oldSpan = video.samples.length
    ? video.samples[video.samples.length - 1].dts - video.samples[0].dts +
      BigInt(video.samples[video.samples.length - 1].duration)
    : 0n;
  const newSpan = keptVideo.length
    ? newVideoDts[newVideoDts.length - 1] - newVideoDts[0] +
      frameTicksAt(1n, fd.num, fd.den)
    : 0n;
  const endGlobal = keptVideo.length
    ? convertRound(
        ticks(newVideoDts[newVideoDts.length - 1], video.timescale),
        GLOBAL_TIMESCALE,
      ).ticks +
      convertRound(
        ticks(frameTicksAt(1n, fd.num, fd.den), video.timescale),
        GLOBAL_TIMESCALE,
      ).ticks
    : anchorGlobal;

  return {
    summary: {
      camera: cam.id,
      segment: w.segName,
      sourceClip: clip.file,
      videoSamples: keptVideo.length,
      audioSamples: keptAudio.length,
      trimmedHeadSamples: vStart,
      nonMonotonicFixed,
      driftRemovedTicks: (oldSpan - newSpan).toString(),
      anchorRoundingError: `${vAnchor.errorNum}/${vAnchor.errorDen}`,
      outFile: "",
    },
    rows,
    bytes,
    endGlobal,
  };
}

export function repair(
  manifest: Manifest,
  readFile: (path: string) => Uint8Array,
  options: RepairOptions = {},
): RepairResult {
  const opts: Required<RepairOptions> = {
    trimOverlapHead: options.trimOverlapHead ?? true,
    fragmentVideoFrames: options.fragmentVideoFrames ?? 50,
  };
  const result: RepairResult = { summaries: [], rows: [], outputs: [] };
  for (const cam of manifest.cameras) {
    const sorted = [...cam.clips].sort((a, b) => a.wallStartMs - b.wallStartMs);
    let prevEndGlobal: bigint | undefined;
    sorted.forEach((clip, i) => {
      const segName = `seg${String(i + 1).padStart(3, "0")}`;
      const done = repairClip({
        cam,
        clip,
        fileBytes: readFile(clip.file),
        prevEndGlobal,
        segName,
        opts,
      });
      const outPath = `${cam.id}/${segName}.mp4`;
      done.summary.outFile = outPath;
      result.summaries.push(done.summary);
      result.rows.push(...done.rows);
      result.outputs.push({ path: outPath, bytes: done.bytes });
      prevEndGlobal = done.endGlobal;
    });
  }
  return result;
}

const CSV_HEADER =
  "camera,segment,track,sample_index,old_dts_ticks,old_timescale," +
  "new_dts_ticks,new_timescale,old_global_s,new_global_s,delta_s,note";

export function rowsToCsv(rows: MapRow[]): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [
        r.camera, r.segment, r.track, r.sampleIndex,
        r.oldDtsTicks, r.oldTimescale,
        r.newDtsTicks, r.newTimescale,
        r.oldGlobalSeconds, r.newGlobalSeconds, r.deltaSeconds,
        r.note,
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
