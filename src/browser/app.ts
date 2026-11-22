import type { AnalysisParams, AnalysisResult, AudioTrack, WindowKind } from "../shared/types.ts";
import { DEFAULT_PARAMS } from "../shared/types.ts";
import { analyzeTracks } from "../shared/analyze.ts";
import { mixToMono } from "../shared/wav.ts";
import { renderCorrected } from "../shared/render.ts";
import { decodeFile } from "./decoder.ts";
import { computePeaks, drawCurve, drawWaveform, windowAtX } from "./canvas.ts";
import { Player, type PlayMode } from "./player.ts";
import { fitSegmented } from "../shared/fit.ts";
import {
  buildKeyframeCsv,
  buildLabels,
  buildProjectJson,
  buildSegmentCsv,
  buildSyncTableCsv,
} from "../shared/export.ts";
import { encodeWavPcm16 } from "../shared/wav.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface AppState {
  camera?: AudioTrack;
  recorder?: AudioTrack;
  aligned?: AudioTrack;
  result?: AnalysisResult;
  selected: number | null;
  params: AnalysisParams;
  peaks?: Float32Array;
}

const state: AppState = { selected: null, params: { ...DEFAULT_PARAMS } };
const player = new Player((seconds) => {
  $("#playTime").textContent = secondsToTimecode(seconds);
  redraw(seconds);
});

void init();

async function init(): Promise<void> {
  $("#cameraFile").addEventListener("change", () => void loadTrack("camera"));
  $("#recorderFile").addEventListener("change", () => void loadTrack("recorder"));
  $("#analyzeBtn").addEventListener("click", () => void runAnalysis());
  $("#reanalyzeBtn").addEventListener("click", () => void runAnalysis());
  bindParams();
  bindTransport();
  bindReview();
  bindExport();
  window.addEventListener("resize", () => {
    if (!state.result) return;
    sizeCanvases();
    state.peaks = computePeaks(mixToMono(state.camera!), $("#waveCanvas").clientWidth || 1200);
    redraw(player.position());
  });
  $("#curveCanvas").addEventListener("click", (event) => {
    if (!state.result) return;
    const rect = (event.target as HTMLCanvasElement).getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * (event.target as HTMLCanvasElement).width;
    const index = windowAtX(state.result, x, (event.target as HTMLCanvasElement).width);
    if (index >= 0) selectWindow(index);
  });
}

async function loadTrack(which: "camera" | "recorder"): Promise<void> {
  const input = $(which === "camera" ? "#cameraFile" : "#recorderFile") as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  setStatus(`解码 ${file.name} …`);
  try {
    const track = await decodeFile(file);
    state[which] = track;
    $(which === "camera" ? "#cameraMeta" : "#recorderMeta").textContent =
      `${track.name} · ${track.sampleRate}Hz · ${track.channels.length}ch · ${track.duration.toFixed(1)}s`;
    setStatus("");
    $("#analyzeBtn").disabled = !(state.camera && state.recorder);
  } catch (error) {
    setStatus(`解码失败：${(error as Error).message}`);
  }
}

async function runAnalysis(): Promise<void> {
  if (!state.camera || !state.recorder) return;
  setStatus("分析中（FFT 互相关 + 分段拟合）…");
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    state.result = analyzeTracks(state.camera, state.recorder, { ...state.params });
    state.aligned = renderCorrected(state.recorder, state.result, { targetSampleRate: state.camera.sampleRate });
  sizeCanvases();
  state.peaks = computePeaks(mixToMono(state.camera), ($("#waveCanvas") as HTMLCanvasElement).width);
    await player.addTrack("reference", state.camera);
    await player.addTrack("recorded", state.recorder);
    await player.addTrack("aligned", state.aligned);
    state.selected = state.result.windows.findIndex((w) => !w.excluded && w.lagMs !== null);
    for (const id of ["#paramsPanel", "#viewsPanel", "#transportPanel", "#reviewPanel", "#exportPanel"]) {
      $(id).hidden = false;
    }
    renderTable();
    selectWindow(state.selected);
    redraw(0);
    setStatus(`完成：${state.result.anchors.length} 个锚点，${state.result.segments.length} 个分段`);
  } catch (error) {
    setStatus(`分析失败：${(error as Error).message}`);
  }
}

function redraw(playheadSec: number): void {
  if (!state.result || !state.camera) return;
  drawWaveform($("#waveCanvas") as HTMLCanvasElement, state.peaks ?? computePeaks(mixToMono(state.camera), 1200), state.result, playheadSec);
  drawCurve($("#curveCanvas") as HTMLCanvasElement, {
    result: state.result,
    playheadSec,
    selectionIndex: state.selected,
  });
}

function sizeCanvases(): void {
  for (const id of ["#waveCanvas", "#curveCanvas"]) {
    const canvas = $(id) as HTMLCanvasElement;
    const width = Math.max(640, Math.floor(canvas.clientWidth || canvas.parentElement!.clientWidth));
    if (canvas.width !== width) canvas.width = width;
  }
}

function setStatus(message: string): void {
  $("#status").textContent = message;
}

function secondsToTimecode(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":") + "." + String(ms).padStart(3, "0");
}

function kindLabel(kind: WindowKind): string {
  return { silence: "静音", music: "音乐", ambient: "环境", transient: "瞬态/拍手" }[kind];
}

function bindParams(): void {
  const sync = () => {
    state.params = {
      windowSec: Number($("#windowSec").value),
      hopSec: Number($("#hopSec").value),
      maxOffsetMs: Number($("#maxOffsetMs").value),
      silenceDb: Number($("#silenceDb").value),
      periodicityLimit: Number($("#periodicityLimit").value),
      maxSegments: Number($("#maxSegments").value),
    };
    $("#windowVal").textContent = `${state.params.windowSec.toFixed(1)}s`;
    $("#hopVal").textContent = `${state.params.hopSec.toFixed(1)}s`;
    $("#maxOffsetVal").textContent = `${state.params.maxOffsetMs}ms`;
    $("#silenceVal").textContent = `${state.params.silenceDb}dB`;
    $("#periodicityVal").textContent = state.params.periodicityLimit.toFixed(2);
    $("#segmentsVal").textContent = String(state.params.maxSegments);
  };
  document.querySelectorAll(".params input").forEach((input) => input.addEventListener("input", sync));
  sync();
}

function bindTransport(): void {
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      player.setMode(radio.value as PlayMode);
    });
  });
  $("#playBtn").addEventListener("click", async () => {
    if (!state.result) return;
    await player.resume();
    if (state.selected !== null && $("#loopWindow").checked) {
      const window = state.result.windows[state.selected]!;
      player.setLoopRange(window.start, window.end);
      player.play(window.start);
    } else {
      player.clearLoop();
      player.play(0);
    }
  });
  $("#stopBtn").addEventListener("click", () => player.stop());
}

function bindReview(): void {
  $("#prevBtn").addEventListener("click", () => {
    if (state.selected === null) return;
    selectWindow(Math.max(0, state.selected - 1));
  });
  $("#nextBtn").addEventListener("click", () => {
    if (state.selected === null || !state.result) return;
    selectWindow(Math.min(state.result.windows.length - 1, state.selected + 1));
  });
  $("#excludeBtn").addEventListener("click", () => {
    if (state.selected === null || !state.result) return;
    const window = state.result.windows[state.selected]!;
    window.excluded = !window.excluded;
    rebuildAfterReview();
  });
  const nudge = (delta: number) => {
    if (state.selected === null || !state.result) return;
    const window = state.result.windows[state.selected]!;
    if (window.lagMs === null) return;
    window.lagMs += delta;
    window.excluded = false;
    rebuildAfterReview();
  };
  $("#nudgeMinusBtn").addEventListener("click", () => nudge(-1));
  $("#nudgePlusBtn").addEventListener("click", () => nudge(1));
  $("#toggleSegmentBtn").addEventListener("click", () => {
    if (state.selected === null || !state.result) return;
    const window = state.result.windows[state.selected]!;
    const segment = state.result.segments.find((s) => window.start >= s.start && window.start < s.end);
    if (segment) segment.enabled = !segment.enabled;
    redraw(player.position());
    renderTable();
  });
}

function rebuildAfterReview(): void {
  if (!state.result || !state.recorder || !state.camera) return;
  state.result.anchors = state.result.windows
    .filter((w) => !w.excluded && w.lagMs !== null)
    .map((w) => ({
      t: (w.start + w.end) / 2,
      offsetMs: w.lagMs!,
      confidence: w.confidence,
      corrZ: w.corrZ,
      kind: w.kind,
      windowIndex: w.index,
    }));
  const segmented = fitSegmented(state.result.anchors, state.params.maxSegments, state.result.duration);
  state.result.segments = segmented.segments;
  state.result.breakpoints = segmented.breakpoints;
  state.aligned = renderCorrected(state.recorder, state.result, { targetSampleRate: state.camera.sampleRate });
  void player.addTrack("aligned", state.aligned);
  renderTable();
  selectWindow(state.selected);
  redraw(player.position());
}

function selectWindow(index: number): void {
  if (!state.result || index < 0) return;
  state.selected = index;
  const window = state.result.windows[index]!;
  const segment = state.result.segments.find((s) => window.start >= s.start && window.start < s.end);
  $("#windowDetails").innerHTML = [
    metric("时间范围", `${window.start.toFixed(2)}–${window.end.toFixed(2)}s`),
    metric("类型", kindLabel(window.kind)),
    metric("偏移", window.lagMs === null ? "—" : `${window.lagMs.toFixed(2)} ms`),
    metric("相关 z", window.corrZ.toFixed(2)),
    metric("置信度", `${(window.confidence * 100).toFixed(0)}%`),
    metric("状态", window.excluded ? "已排除" : "参与拟合"),
    metric("分段置信", segment ? `${(segment.confidence * 100).toFixed(0)}%` : "—"),
    metric("分段拉伸", segment ? segment.stretchFactor.toFixed(6) : "—"),
  ].join("");
  renderTable();
  redraw(player.position());
}

function metric(label: string, value: string): string {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderTable(): void {
  if (!state.result) return;
  const body = $("#windowRows");
  body.innerHTML = state.result.windows.map((window) => {
    const segment = state.result!.segments.find((s) => window.start >= s.start && window.start < s.end);
    return `<tr data-index="${window.index}" class="${window.index === state.selected ? "selected" : ""} ${window.excluded ? "excluded" : ""}">
      <td>${window.index}</td>
      <td>${window.start.toFixed(1)}s</td>
      <td>${kindLabel(window.kind)}</td>
      <td>${window.lagMs === null ? "—" : window.lagMs.toFixed(1)}</td>
      <td>${window.corrZ.toFixed(1)}</td>
      <td>${(window.confidence * 100).toFixed(0)}%</td>
      <td>${window.excluded ? "排除" : "使用"}</td>
      <td>${segment ? `#${segment.index} ${segment.enabled ? "" : "(停)"}` : "—"}</td>
    </tr>`;
  }).join("");
  body.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", () => selectWindow(Number(row.dataset.index)));
  });
}

function bindExport(): void {
  const download = (filename: string, content: string | ArrayBuffer, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };
  $("#exportWav").addEventListener("click", () => {
    if (!state.aligned) return;
    download(state.aligned.name, encodeWavPcm16(state.aligned), "audio/wav");
  });
  $("#exportKeyframes").addEventListener("click", () => state.result && download("sync-keyframes.csv", buildKeyframeCsv(state.result), "text/csv"));
  $("#exportWindows").addEventListener("click", () => state.result && download("sync-windows.csv", buildSyncTableCsv(state.result), "text/csv"));
  $("#exportSegments").addEventListener("click", () => state.result && download("sync-segments.csv", buildSegmentCsv(state.result), "text/csv"));
  $("#exportJson").addEventListener("click", () => {
    if (!state.result || !state.camera || !state.recorder) return;
    download("sync-project.json", buildProjectJson(state.result, state.camera.name, state.recorder.name), "application/json");
  });
  $("#exportLabels").addEventListener("click", () => state.result && download("sync-labels.txt", buildLabels(state.result), "text/plain"));
}
