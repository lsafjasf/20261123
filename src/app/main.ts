// UI wiring: load media, pick a range, decode + reverse, play, export.
import { parseMp4, decodeSegment } from "./decoder.ts";
import { buildReversePlan } from "../shared/timeline.ts";
import { reversePcmPlanar } from "../shared/wav.ts";
import { ReversePlayer } from "./player.ts";
import { exportSegment, previewWithMediaSource } from "./exporter.ts";
import type { DemuxResult } from "../shared/mp4.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const preview = $<HTMLVideoElement>("preview");
const mediaInfo = $("mediaInfo");
const startRange = $<HTMLInputElement>("startRange");
const endRange = $<HTMLInputElement>("endRange");
const startLabel = $("startLabel");
const endLabel = $("endLabel");
const prepareStatus = $("prepareStatus");
const playPauseBtn = $<HTMLButtonElement>("playPause");
const restartBtn = $<HTMLButtonElement>("restart");
const playhead = $<HTMLProgressElement>("playhead");
const clock = $("clock");
const exportBtn = $<HTMLButtonElement>("exportBtn");
const exportStatus = $("exportStatus");
const exportPreview = $<HTMLVideoElement>("exportPreview");
const downloadRow = $("downloadRow");
const reportView = $("reportView");

let demuxed: DemuxResult | null = null;
let sourceName = "";
let player: ReversePlayer | null = null;
let plan: ReturnType<typeof buildReversePlan> | null = null;
let pcmReversed: Float32Array[] = [];
let sampleRate = 48000;
let outputFrames: VideoFrame[] = [];

function fmt(t: number): string { return t.toFixed(3); }

function updateRangeLabels() {
  startLabel.textContent = fmt(Number(startRange.value));
  endLabel.textContent = fmt(Number(endRange.value));
}

function setDefaultLast2s() {
  if (!demuxed) return;
  const dur = demuxed.video?.durationSec ?? demuxed.durationSec;
  endRange.value = String(dur);
  startRange.value = String(Math.max(0, dur - 2));
  updateRangeLabels();
}

async function loadSource(buf: ArrayBuffer, name: string, previewUrl: string) {
  player?.dispose();
  player = null;
  plan = null;
  outputFrames = [];
  playPauseBtn.disabled = true;
  restartBtn.disabled = true;
  exportBtn.disabled = true;
  demuxed = parseMp4(buf);
  sourceName = name;
  preview.src = previewUrl;
  const dur = demuxed.video?.durationSec ?? demuxed.durationSec;
  for (const r of [startRange, endRange]) {
    r.max = String(dur);
  }
  mediaInfo.textContent =
    `${name} · ${fmt(dur)}s · ${demuxed.video?.codec} ` +
    `${demuxed.video?.width}x${demuxed.video?.height} · ${demuxed.audio?.codec ?? "no audio"}`;
  setDefaultLast2s();
  prepareStatus.textContent = "";
}

$("loadSample").addEventListener("click", async () => {
  const res = await fetch("/media/sample.mp4");
  const buf = await res.arrayBuffer();
  await loadSource(buf, "sample.mp4", "/media/sample.mp4");
});

$("fileInput").addEventListener("change", async ev => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await loadSource(await file.arrayBuffer(), file.name, URL.createObjectURL(file));
});

$("last2s").addEventListener("click", setDefaultLast2s);
startRange.addEventListener("input", updateRangeLabels);
endRange.addEventListener("input", updateRangeLabels);

$("prepare").addEventListener("click", async () => {
  if (!demuxed) return;
  player?.dispose();
  player = null;
  exportBtn.disabled = true;
  const start = Math.min(Number(startRange.value), Number(endRange.value));
  const end = Math.max(Number(startRange.value), Number(endRange.value));
  if (end - start < 0.05) {
    prepareStatus.textContent = "区间太短";
    return;
  }
  prepareStatus.textContent = "解码中…";
  try {
    const seg = await decodeSegment(demuxed, start, end);
    const frameInfos = seg.frames.map((f, i) => ({
      cts: f.timestamp / 1e6,
      duration: seg.frameDurations[i],
      keyframe: i === 0,
    }));
    plan = buildReversePlan(frameInfos, start, end);
    pcmReversed = seg.pcm.length ? reversePcmPlanar(seg.pcm) : [];
    sampleRate = seg.sampleRate;
    outputFrames = seg.frames.slice().reverse();
    player = new ReversePlayer(
      $<HTMLCanvasElement>("stage"), plan, outputFrames, pcmReversed, sampleRate,
      {
        onTick: (pos, total) => {
          playhead.value = total ? pos / total : 0;
          clock.textContent = `${fmt(pos)} / ${fmt(total)} s`;
        },
        onEnded: () => { playPauseBtn.textContent = "播放"; },
      },
    );
    playhead.value = 0;
    clock.textContent = `0.000 / ${fmt(plan.totalDuration)} s`;
    playPauseBtn.disabled = false;
    restartBtn.disabled = false;
    exportBtn.disabled = false;
    prepareStatus.textContent =
      `就绪：${plan.frames.length} 帧，${fmt(plan.totalDuration)}s，` +
      `计划音画误差 ≤ ${plan.avError.maxAbsMs.toFixed(2)}ms`;
  } catch (err) {
    prepareStatus.textContent = `失败：${err}`;
  }
});

playPauseBtn.addEventListener("click", () => {
  if (!player) return;
  if (player.isPlaying) {
    player.pause();
    playPauseBtn.textContent = "播放";
  } else {
    player.play();
    playPauseBtn.textContent = "暂停";
  }
});

restartBtn.addEventListener("click", () => {
  player?.restart();
  playPauseBtn.textContent = "暂停";
});

exportBtn.addEventListener("click", async () => {
  if (!demuxed || !plan || !player) return;
  exportStatus.textContent = "编码导出中…";
  try {
    const result = await exportSegment({
      sourceName,
      sourceDurationSec: demuxed.video?.durationSec ?? demuxed.durationSec,
      codec: demuxed.video!.codec,
      width: demuxed.video!.width,
      height: demuxed.video!.height,
      plan,
      outputFrames,
      pcmReversed,
      sampleRate,
      measuredAv: player.measuredAvError(),
    });
    downloadRow.replaceChildren();
    const addLink = (data: Uint8Array, name: string, type: string) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type }));
      a.download = name;
      a.textContent = `下载 ${name}`;
      downloadRow.appendChild(a);
    };
    addLink(result.mp4, "reversed.mp4", "video/mp4");
    addLink(result.wav, "reversed.wav", "audio/wav");
    addLink(new TextEncoder().encode(JSON.stringify(result.report, null, 2)),
      "report.json", "application/json");
    previewWithMediaSource(exportPreview, result.init, result.media, demuxed.video!.codec);
    reportView.textContent = JSON.stringify(result.report, null, 2);
    const saved = await fetch("/api/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result.report),
    }).then(r => r.json()).catch(() => null);
    exportStatus.textContent =
      `完成${saved?.saved ? `，报告已存至 ${saved.saved}` : ""}`;
  } catch (err) {
    exportStatus.textContent = `导出失败：${err}`;
  }
});

updateRangeLabels();
