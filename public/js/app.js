import {
  AudioPlayer,
  capabilitySummary,
  decodeAudio,
  exportWav,
  sha256Hex,
  verifyExport,
} from "./audio.js";
import { analyzeAudio } from "./analyzer.js";
import { cleanAllBreaths, processAudio, resetAllAutoActions, setEventAction } from "./editor.js";
import { createManifest } from "./manifest.js";
             
                 
              
             
            
              
           
                 
                    
import { ACTION_LABELS, KIND_LABELS } from "./types.js";
import { WaveformView } from "./waveform.js";

const $ =                                      (id        )    => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element     ;
};

                    
                          
                     
                                  
                                   
                            
                       
                 
                       
                            
                   
                
 

const state           = {
  source: null,
  sourceName: "未命名.wav",
  analysis: null,
  processed: null,
  selectedId: null,
  monitor: "processed",
  policy: 0.55,
  shortenRatio: 0.42,
  filter: "all",
  playhead: 0,
  busy: false,
};

const waveform = new WaveformView($                   ("waveform"));
const player = new AudioPlayer();
let animationFrame = 0;
let processTimer = 0;
let toastTimer = 0;
let exportAudioUrl                = null;
let exportManifestUrl                = null;

function formatDuration(seconds        , precise = false)         {
  const safe = Math.max(0, seconds || 0);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(precise ? 3 : 1).padStart(precise ? 6 : 4, "0")}`;
}

function formatDb(value        )         {
  return value <= -90 ? "−∞ dBFS" : `${value.toFixed(1)} dBFS`;
}

function formatClock(seconds        )         {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = (safe - minutes * 60).toFixed(3).padStart(6, "0");
  return minutes > 0 ? `${minutes}:${rest}` : rest;
}

function formatPercent(value        )         {
  return `${Math.round(value * 100)}%`;
}

function selectedEvent()                     {
  return state.analysis?.events.find((event) => event.id === state.selectedId) || null;
}

function activePcm()                  {
  if (state.monitor === "processed" && state.processed) return state.processed.pcm;
  return state.source;
}

function activeDuration()         {
  const pcm = activePcm();
  return pcm ? pcm.length / pcm.sampleRate : 0;
}

function setStatus(text        , error = false)       {
  $("status-text").textContent = text;
  $("status-dot").style.background = error ? "var(--coral)" : "var(--green)";
}

function toast(message        , error = false)       {
  const element = $("toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.remove("hidden");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element.classList.add("hidden"), 3400);
}

function setProgress(percent        , label        )       {
  $("export-progress").classList.remove("hidden");
  $("progress-fill").style.width = `${Math.max(0, Math.min(100, percent))}%`;
  $("progress-label").textContent = label;
}

function updateRangeFill(element                  )       {
  const min = Number(element.min || 0);
  const max = Number(element.max || 100);
  const ratio = ((Number(element.value) - min) / Math.max(1, max - min)) * 100;
  element.style.background = `linear-gradient(90deg, var(--green) 0 ${ratio}%, #2d3740 ${ratio}% 100%)`;
}

function showLoaded(loaded         )       {
  $("source-empty").classList.toggle("hidden", loaded);
  $("source-loaded").classList.toggle("hidden", !loaded);
  $("canvas-empty").classList.toggle("hidden", loaded);
  $("play-button").toggleAttribute("disabled", !loaded);
  $("export-button").toggleAttribute("disabled", !loaded);
  $("reanalyze-button").toggleAttribute("disabled", !loaded);
  $("bulk-clean").toggleAttribute("disabled", !loaded);
  $("bulk-restore").toggleAttribute("disabled", !loaded);
}

async function loadAudioBuffer(data             , name        )                {
  try {
    setStatus("正在解码音频…");
    const pcm = await decodeAudio(data);
    state.source = pcm;
    state.sourceName = name;
    state.analysis = null;
    state.processed = null;
    state.selectedId = null;
    state.playhead = 0;
    state.monitor = "processed";
    waveform.setData(pcm, null, null);
    showLoaded(true);
    $("source-name").textContent = name;
    $("source-meta").textContent = `${(pcm.sampleRate / 1000).toFixed(1)} kHz · ${
      pcm.channels.length === 1 ? "单声道" : pcm.channels.length === 2 ? "立体声" : `${pcm.channels.length} 声道`
    } · ${pcm.length.toLocaleString("zh-CN")} 样本`;
    $("source-duration").textContent = formatDuration(pcm.length / pcm.sampleRate);
    updateMonitorButtons();
    await runAnalysis(false);
  } catch (error) {
    console.error(error);
    setStatus("无法解码该音频", true);
    toast("解码失败：请确认文件是浏览器可读的 WAV、MP3、M4A 或 OGG。", true);
  }
}

async function runAnalysis(preserveDecisions         )                {
  if (!state.source) return;
  const prior = preserveDecisions && state.analysis ? snapshotDecisions(state.analysis) : [];
  $("analysis-state").textContent = "分析中…";
  await new Promise((resolve) => window.setTimeout(resolve, 20));
  const analysis = analyzeAudio(state.source, { policy: state.policy });
  if (prior.length) restoreDecisions(analysis, prior);
  state.analysis = analysis;
  if (state.selectedId && !analysis.events.some((event) => event.id === state.selectedId)) {
    state.selectedId = analysis.events[0]?.id || null;
  } else if (!state.selectedId) {
    state.selectedId = analysis.events[0]?.id || null;
  }
  state.processed = processAudio(state.source, analysis, {
    shortenRatio: state.shortenRatio,
    seamMs: 32,
    fadeMs: 24,
    attenuationDb: -12,
  });
  waveform.setData(state.source, state.processed, analysis);
  waveform.setSelected(state.selectedId);
  $("analysis-state").textContent = `${analysis.events.length} 处事件 · 已保守分层`;
  $("source-floor").textContent = formatDb(analysis.noiseFloorDb);
  $("source-peak").textContent = formatDb(analysis.peakDb);
  $("room-status").textContent = `${analysis.roomWindows.length} 个安静窗 · ${formatDb(analysis.noiseFloorDb)}`;
  renderAll();
  setStatus(
    `分析完成：${analysis.events.filter((event) => event.kind === "clean").length} 个气口，${
      analysis.events.filter((event) => event.kind === "emotional").length
    } 个情绪呼吸，${analysis.events.filter((event) => event.kind === "impulse").length} 个低频冲激`,
  );
}

                            
                
              
                  
                               
                     
               
 

function snapshotDecisions(analysis                )                     {
  return analysis.events
    .filter((event) => event.manualKind !== null || event.action !== event.autoAction || event.note)
    .map((event) => ({
      start: event.start,
      end: event.end,
      kind: event.kind,
      manualKind: event.manualKind,
      action: event.action,
      note: event.note,
    }));
}

function restoreDecisions(analysis                , snapshots                    )       {
  for (const event of analysis.events) {
    const match = snapshots.find((snapshot) => {
      const overlap = Math.min(event.end, snapshot.end) - Math.max(event.start, snapshot.start);
      return overlap / Math.max(1, Math.min(event.end - event.start, snapshot.end - snapshot.start)) > 0.35;
    });
    if (!match) continue;
    event.kind = match.kind;
    event.manualKind = match.manualKind;
    event.action = match.action;
    event.note = match.note;
  }
}

function renderAll()       {
  renderCounts();
  renderEventTable();
  renderInspector();
  updateAuditSummary();
  updateMonitorButtons();
  updateTransport();
}

function renderCounts()       {
  if (!state.analysis) return;
  $("count-clean").textContent = String(state.analysis.events.filter((event) => event.kind === "clean").length);
  $("count-emotional").textContent = String(state.analysis.events.filter((event) => event.kind === "emotional").length);
  $("count-impulse").textContent = String(state.analysis.events.filter((event) => event.kind === "impulse").length);
}

function renderEventTable()       {
  const body = $("event-body");
  body.replaceChildren();
  if (!state.analysis || state.analysis.events.length === 0) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = state.analysis ? "未发现需要审听的呼吸事件" : "尚未分析到呼吸事件";
    row.append(cell);
    body.append(row);
    return;
  }
  const events = state.analysis.events.filter(
    (event) => state.filter === "all" || event.kind === state.filter,
  );
  if (events.length === 0) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "当前分类筛选下没有事件";
    row.append(cell);
    body.append(row);
    return;
  }
  for (const event of events) {
    const row = document.createElement("tr");
    row.dataset.id = event.id;
    row.classList.toggle("selected", event.id === state.selectedId);
    row.addEventListener("click", () => selectEvent(event.id, true));

    const time = document.createElement("td");
    time.className = "mono";
    time.textContent = `${formatClock(event.start / state.analysis .sampleRate)}–${formatClock(
      event.end / state.analysis .sampleRate,
    )}`;
    time.title = `样本 ${event.start} – ${event.end}`;

    const kind = document.createElement("td");
    const kindBadge = document.createElement("span");
    kindBadge.className = `event-kind kind-${event.kind}`;
    const dot = document.createElement("i");
    kindBadge.append(dot, document.createTextNode(KIND_LABELS[event.kind]));
    if (event.manualKind) {
      const manual = document.createElement("small");
      manual.textContent = "手动";
      manual.style.cssText = "margin-left:5px;color:#54616c;font-size:7px;";
      kindBadge.append(manual);
    }
    kind.append(kindBadge);

    const evidence = document.createElement("td");
    evidence.textContent = `噪声 ${formatPercent(event.evidence.noiseLikeness)} · 低频 ${formatPercent(
      event.evidence.lowBandRatio,
    )} · ${formatDb(event.evidence.rmsDb)}`;

    const duration = document.createElement("td");
    duration.className = "mono";
    duration.textContent = `${Math.round(event.evidence.durationMs)} ms`;

    const action = document.createElement("td");
    const tag = document.createElement("span");
    tag.className = `action-tag ${event.action}`;
    tag.textContent = ACTION_LABELS[event.action];
    action.append(tag);

    const seam = document.createElement("td");
    seam.className = "seam-tag";
    const seamRecord = state.processed?.seams.find((item) => item.eventId === event.id);
    seam.textContent = seamRecord
      ? `${(seamRecord.lengthSamples / state.processed .pcm.sampleRate * 1000).toFixed(0)} ms 底噪`
      : event.action === "keep" || event.action === "restore"
        ? "原样"
        : "—";
    row.append(time, kind, evidence, duration, action, seam);
    body.append(row);
  }
}

function renderInspector()       {
  const event = selectedEvent();
  const empty = $("inspector-empty");
  const content = $("inspector-content");
  empty.classList.toggle("hidden", Boolean(event));
  content.classList.toggle("hidden", !event);
  if (!event || !state.analysis) {
    $("inspect-title").textContent = "未选择事件";
    $("inspect-id").textContent = "—";
    return;
  }
  $("inspect-title").textContent = `${KIND_LABELS[event.kind]} · ${event.id}`;
  $("inspect-id").textContent = `#${event.start}–#${event.end}`;
  $("confidence-label").textContent = `置信 ${formatPercent(event.confidence)}`;

  setMeter("meter-noise", "val-noise", event.evidence.noiseLikeness, formatPercent(event.evidence.noiseLikeness));
  setMeter("meter-low", "val-low", event.evidence.lowBandRatio, formatPercent(event.evidence.lowBandRatio), "hot");
  setMeter(
    "meter-distance",
    "val-distance",
    Math.max(0, 1 - Math.min(1, event.evidence.distanceToSpeechMs / 1500)),
    `${Math.round(event.evidence.distanceToSpeechMs)} ms`,
    "warm",
  );
  setMeter(
    "meter-crest",
    "val-crest",
    Math.min(1, Math.max(0, (event.evidence.crest - 1) / 2.5)),
    `${event.evidence.crest.toFixed(1)}×`,
    "hot",
  );

  const reasons = $("reason-list");
  reasons.replaceChildren();
  for (const reason of event.reasons.slice(0, 5)) {
    const item = document.createElement("li");
    item.textContent = reason;
    reasons.append(item);
  }

  document.querySelectorAll                   (".classification button").forEach((button) => {
    button.classList.toggle("active", button.dataset.kind === event.kind);
  });
  document.querySelectorAll                   (".action-grid button").forEach((button) => {
    const action = button.dataset.action;
    button.classList.toggle(
      "active",
      action === event.action || (action === "restore" && event.action === "keep"),
    );
  });
  $                  ("shorten-amount").value = String(Math.round(state.shortenRatio * 100));
  $("shorten-output").textContent = `${Math.round(state.shortenRatio * 100)}%`;
  updateRangeFill($                  ("shorten-amount"));

  const seam = state.processed?.seams.find((item) => item.eventId === event.id);
  const seamDuration = $("seam-duration");
  const seamSource = $("seam-source");
  const seamLevel = $("seam-level");
  const seamRecordElement = $("seam-record");
  if (seam) {
    seamDuration.textContent = `${((seam.lengthSamples / state.processed .pcm.sampleRate) * 1000).toFixed(0)} ms`;
    seamSource.textContent = `S#${seam.sourceStart}–#${seam.sourceEnd}`;
    seamLevel.textContent = `${seam.seamRmsDb.toFixed(1)} dBFS`;
    seamRecordElement.textContent = `O#${seam.outputStart}–#${seam.outputEnd}`;
  } else if (event.action === "attenuate") {
    seamDuration.textContent = "原位";
    seamSource.textContent = "无剪切";
    seamLevel.textContent = "−12 dB";
    seamRecordElement.textContent = `S#${event.start}–#${event.end}`;
  } else {
    seamDuration.textContent = "不填充";
    seamSource.textContent = event.action === "keep" || event.action === "restore" ? "原声通过" : "—";
    seamLevel.textContent = "—";
    seamRecordElement.textContent = `S#${event.start}–#${event.end}`;
  }
  $                     ("event-note").value = event.note;
}

function setMeter(id        , valueId        , value        , label        , tone = "")       {
  const meter = $(id);
  meter.style.width = `${Math.max(2, Math.min(100, value * 100))}%`;
  meter.className = tone;
  $(valueId).textContent = label;
}

function updateAuditSummary()       {
  if (!state.processed) {
    $("edit-summary").textContent = "0 处改动 · 0 个样本";
    return;
  }
  const edits = state.processed.eventsUsed.filter((event) => event.action !== "keep" && event.action !== "restore").length;
  $("edit-summary").textContent = `${edits} 处改动 · ${state.processed.modifiedOutputSamples.toLocaleString(
    "zh-CN",
  )} 个样本值 · ${state.processed.seams.length} 接缝`;
}

function updateMonitorButtons()       {
  document.querySelectorAll                   (".ab-toggle button").forEach((button) => {
    button.classList.toggle("active", button.dataset.monitor === state.monitor);
    if (button.dataset.monitor === "processed") button.disabled = !state.processed;
  });
}

function updateTransport()       {
  const duration = activeDuration();
  state.playhead = Math.min(state.playhead, duration);
  $("current-time").textContent = formatDuration(state.playhead, true);
  $("total-time").textContent = `/ ${formatDuration(duration, true)}`;
  waveform.setPlayhead(state.playhead);
  const range = waveform.getRange();
  $("view-range").textContent = `${formatDuration(range.start, true)} – ${formatDuration(range.end, true)} · ${
    range.zoom > 1.4 ? `${range.zoom.toFixed(1)}×` : "全览"
  }`;
  $("zoom-label").textContent = range.zoom > 1.4 ? `${range.zoom.toFixed(1)}×` : "全览";
}

function selectEvent(id               , seek = false)       {
  state.selectedId = id;
  waveform.setSelected(id);
  renderEventTable();
  renderInspector();
  if (seek) {
    const event = selectedEvent();
    if (event && state.analysis) {
      state.playhead = event.start / state.analysis.sampleRate;
      updateTransport();
    }
  }
}

function scheduleProcess()       {
  window.clearTimeout(processTimer);
  processTimer = window.setTimeout(() => {
    if (!state.source || !state.analysis) return;
    state.processed = processAudio(state.source, state.analysis, {
      shortenRatio: state.shortenRatio,
      seamMs: 32,
      fadeMs: 24,
      attenuationDb: -12,
    });
    waveform.setProcessed(state.processed);
    renderCounts();
    renderEventTable();
    renderInspector();
    updateAuditSummary();
    updateMonitorButtons();
    updateTransport();
  }, 45);
}

function stopPlayback(resetDisplay = true)       {
  if (player.playing) player.stop();
  $("play-button").classList.remove("playing");
  window.cancelAnimationFrame(animationFrame);
  if (resetDisplay) updateTransport();
}

function animatePlayback()       {
  if (!player.playing) return;
  state.playhead = player.position;
  waveform.setPlayhead(state.playhead);
  $("current-time").textContent = formatDuration(state.playhead, true);
  animationFrame = window.requestAnimationFrame(animatePlayback);
}

async function togglePlayback()                {
  if (player.playing) {
    stopPlayback();
    setStatus("已暂停");
    return;
  }
  const pcm = activePcm();
  if (!pcm) return;
  if (state.playhead >= pcm.length / pcm.sampleRate - 0.01) state.playhead = 0;
  try {
    await player.play(pcm, state.playhead);
    $("play-button").classList.add("playing");
    setStatus(state.monitor === "processed" ? "监听处理后的输出" : "监听原始素材");
    animationFrame = window.requestAnimationFrame(animatePlayback);
  } catch (error) {
    console.error(error);
    toast("浏览器未能启动音频输出，请再次点击播放。", true);
  }
}

function seekTo(seconds        )       {
  const duration = activeDuration();
  const wasPlaying = player.playing;
  state.playhead = Math.max(0, Math.min(duration, seconds));
  if (wasPlaying) {
    stopPlayback(false);
    void player.play(activePcm() , state.playhead).then(() => {
      $("play-button").classList.add("playing");
      animationFrame = window.requestAnimationFrame(animatePlayback);
    });
  }
  updateTransport();
}

function bindCanvas()       {
  const canvas = $                   ("waveform");
  const tooltip = $("canvas-tooltip");
  let dragging = false;
  let moved = false;
  let lastX = 0;
  let startX = 0;
  let startPlayhead = 0;

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    waveform.zoomAt(event.deltaY < 0 ? 1.32 : 0.76, (event.clientX - rect.left) / rect.width);
    updateTransport();
  }, { passive: false });

  canvas.addEventListener("pointerdown", (event) => {
    if (!state.source) return;
    canvas.setPointerCapture(event.pointerId);
    dragging = true;
    moved = false;
    lastX = event.clientX;
    startX = event.clientX;
    startPlayhead = state.playhead;
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!state.source) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const time = waveform.timeAtRatio(ratio);
    const eventAtCursor = waveform.eventAt(time);
    tooltip.classList.remove("hidden");
    tooltip.style.left = `${event.clientX - rect.left}px`;
    tooltip.style.top = `${Math.max(38, event.clientY - rect.top)}px`;
    tooltip.textContent = eventAtCursor
      ? `${eventAtCursor.id} · ${KIND_LABELS[eventAtCursor.kind]} · ${formatDuration(time, true)}`
      : formatDuration(time, true);
    waveform.setHoverTime(time);
    if (dragging && Math.abs(event.clientX - startX) > 3) {
      moved = true;
      const span = waveform.getRange();
      waveform.panBy(((lastX - event.clientX) / rect.width) * (span.end - span.start));
      lastX = event.clientX;
      state.playhead = startPlayhead;
      updateTransport();
    }
  });

  canvas.addEventListener("pointerup", (event) => {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture(event.pointerId);
    if (moved) return;
    const rect = canvas.getBoundingClientRect();
    const time = waveform.timeAtRatio((event.clientX - rect.left) / rect.width);
    const eventAtCursor = waveform.eventAt(time);
    if (eventAtCursor) selectEvent(eventAtCursor.id);
    seekTo(time);
  });

  canvas.addEventListener("pointerleave", () => {
    tooltip.classList.add("hidden");
    waveform.setHoverTime(null);
  });

  canvas.addEventListener("dblclick", () => {
    waveform.resetView();
    updateTransport();
  });
}

function bindSourceControls()       {
  $                  ("file-input").addEventListener("change", async (event) => {
    const input = event.currentTarget                    ;
    const file = input.files?.[0];
    if (!file) return;
    await loadAudioBuffer(await file.arrayBuffer(), file.name);
    input.value = "";
  });

  $("demo-button").addEventListener("click", loadDemo);
  const dropZone = $("drop-zone");
  let dragDepth = 0;
  window.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    dragDepth += 1;
    dropZone.classList.add("dragging");
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropZone.classList.remove("dragging");
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", async (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove("dragging");
    const file = event.dataTransfer?.files[0];
    if (file) await loadAudioBuffer(await file.arrayBuffer(), file.name);
  });
}

async function loadDemo()                {
  setStatus("正在载入测试段落…");
  try {
    const response = await fetch("/demo.wav");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await loadAudioBuffer(await response.arrayBuffer(), "春日来信_呼吸测试段.wav");
  } catch (error) {
    console.error(error);
    setStatus("演示音频不可用，请导入本地文件", true);
  }
}

function bindEditingControls()       {
  $("play-button").addEventListener("click", () => void togglePlayback());
  $("zoom-in").addEventListener("click", () => {
    waveform.zoomAt(1.45, 0.5);
    updateTransport();
  });
  $("zoom-out").addEventListener("click", () => {
    waveform.zoomAt(0.68, 0.5);
    updateTransport();
  });
  $("reanalyze-button").addEventListener("click", async () => {
    if (state.busy) return;
    state.busy = true;
    setStatus("按当前保守度重新分析…");
    await runAnalysis(true);
    state.busy = false;
  });

  document.querySelectorAll                   (".ab-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.monitor               ;
      if (mode === "processed" && !state.processed) return;
      stopPlayback(false);
      state.monitor = mode;
      state.playhead = Math.min(state.playhead, activeDuration());
      updateMonitorButtons();
      updateTransport();
      setStatus(mode === "processed" ? "监听处理后版本" : "监听原始版本");
    });
  });

  document.querySelectorAll                   (".legend").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = (button.dataset.filter || "all")                      ;
      document.querySelectorAll(".legend").forEach((item) => item.classList.toggle("active", item === button));
      renderEventTable();
    });
  });

  document.querySelectorAll                   (".classification button").forEach((button) => {
    button.addEventListener("click", () => {
      const event = selectedEvent();
      if (!event || !button.dataset.kind) return;
      const kind = button.dataset.kind             ;
      event.kind = kind;
      event.manualKind = kind;
      event.action = kind === "clean" ? "shorten" : kind === "emotional" ? "keep" : "attenuate";
      renderAll();
      scheduleProcess();
    });
  });

  document.querySelectorAll                   (".action-grid button").forEach((button) => {
    button.addEventListener("click", () => {
      const event = selectedEvent();
      if (!event || !button.dataset.action) return;
      setEventAction(event, button.dataset.action              );
      renderInspector();
      renderEventTable();
      scheduleProcess();
    });
  });

  $                  ("shorten-amount").addEventListener("input", (event) => {
    const input = event.currentTarget                    ;
    state.shortenRatio = Number(input.value) / 100;
    $("shorten-output").textContent = `${input.value}%`;
    updateRangeFill(input);
    scheduleProcess();
  });

  $                     ("event-note").addEventListener("input", (noteEvent) => {
    const event = selectedEvent();
    if (event) event.note = (noteEvent.currentTarget                       ).value;
  });

  $("bulk-clean").addEventListener("click", () => {
    if (!state.analysis) return;
    cleanAllBreaths(state.analysis.events);
    renderAll();
    scheduleProcess();
    toast("全部可清理气口已设为缩短，情绪呼吸与冲激未动。");
  });

  $("bulk-restore").addEventListener("click", () => {
    if (!state.analysis) return;
    resetAllAutoActions(state.analysis.events);
    renderAll();
    scheduleProcess();
    toast("已恢复所有自动处理决定。");
  });

  const policy = $                  ("policy-slider");
  policy.addEventListener("input", () => {
    state.policy = Number(policy.value) / 100;
    updateRangeFill(policy);
    $("policy-output").textContent = state.policy < 0.34 ? "多清理" : state.policy > 0.66 ? "多保留" : "均衡";
  });
  policy.addEventListener("change", async () => {
    if (!state.source || state.busy) return;
    state.busy = true;
    setStatus("按新的保守度重新分析，手动决定已保留…");
    await runAnalysis(true);
    state.busy = false;
    toast("已重新分析；手动分类、处理和备注均已保留。");
  });

  player.onEnded = () => {
    $("play-button").classList.remove("playing");
    window.cancelAnimationFrame(animationFrame);
    state.playhead = activeDuration();
    updateTransport();
    setStatus("播放结束");
  };

  window.addEventListener("keydown", (event) => {
    const target = event.target               ;
    const typing = ["INPUT", "TEXTAREA"].includes(target.tagName);
    if (!typing && event.code === "Space") {
      event.preventDefault();
      void togglePlayback();
    }
    if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "e") {
      event.preventDefault();
      if (state.processed) openExport();
    }
  });
}

function updateVerifyRow(id        , pass         , text        )       {
  const row = $(id);
  row.classList.toggle("pass", pass);
  row.classList.toggle("fail", !pass);
  row.querySelector("em") .textContent = text;
}

function openExport()       {
  if (!state.processed || !state.analysis) return;
  $("export-progress").classList.add("hidden");
  $("verify-panel").classList.add("hidden");
  $("download-audio").classList.add("hidden");
  $("download-manifest").classList.add("hidden");
  $("run-export").removeAttribute("disabled");
  $("verify-verdict").textContent = "等待生成";
  $("verify-verdict").classList.remove("fail");
  const base = state.sourceName.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_");
  $                  ("filename-input").value = `${base}_cleaned`;
  $("export-input-duration").textContent = formatDuration(state.source .length / state.source .sampleRate, true);
  $("export-output-duration").textContent = formatDuration(state.processed.expectedDuration, true);
  $("export-event-count").textContent = `${state.processed.eventsUsed.length} / ${
    state.analysis.events.length
  } 判定`;
  $("export-seam-count").textContent = `${state.processed.seams.length} 处`;
  $                   ("export-dialog").showModal();
}

async function runExport()                {
  if (!state.source || !state.analysis || !state.processed) return;
  const button = $                   ("run-export");
  button.disabled = true;
  $("download-audio").classList.add("hidden");
  $("download-manifest").classList.add("hidden");
  $("verify-panel").classList.add("hidden");
  setProgress(6, "重新组装编辑后的样本映射…");
  await new Promise((resolve) => window.setTimeout(resolve, 30));
  try {
    state.processed = processAudio(state.source, state.analysis, {
      shortenRatio: state.shortenRatio,
      seamMs: 32,
      fadeMs: 24,
      attenuationDb: -12,
    });
    waveform.setProcessed(state.processed);
    updateAuditSummary();
    setProgress(24, "编码 32-bit float WAV…");
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    const { blob, arrayBuffer } = exportWav(state.processed);
    setProgress(50, "计算 SHA-256 与样本清单…");
    const sha256 = await sha256Hex(arrayBuffer);
    const manifest = createManifest(state.source, state.analysis, state.processed, state.sourceName, sha256);
    const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    setProgress(66, "重新解码并逐样本核验未处理区…");
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    const { verification } = await verifyExport(blob, state.source, state.processed);
    setProgress(94, "核对总时长、峰值与 WebCodecs 指纹…");
    const base = ($                  ("filename-input").value || "audiobook_cleaned").trim() || "audiobook_cleaned";
    if (exportAudioUrl) URL.revokeObjectURL(exportAudioUrl);
    if (exportManifestUrl) URL.revokeObjectURL(exportManifestUrl);
    exportAudioUrl = URL.createObjectURL(blob);
    exportManifestUrl = URL.createObjectURL(manifestBlob);
    const audioLink = $                   ("download-audio");
    audioLink.href = exportAudioUrl;
    audioLink.download = `${base}.wav`;
    audioLink.classList.remove("hidden");
    const manifestLink = $                   ("download-manifest");
    manifestLink.href = exportManifestUrl;
    manifestLink.download = `${base}.manifest.json`;
    manifestLink.classList.remove("hidden");
    manifestLink.title = `输出 SHA-256: ${sha256}`;

    const { duration, peak, untouched, webCodecs } = verification;
    $("verify-panel").classList.remove("hidden");
    $("verify-verdict").textContent = verification.pass ? "全部通过" : "需要复核";
    $("verify-verdict").classList.toggle("fail", !verification.pass);
    updateVerifyRow(
      "verify-duration",
      duration.pass,
      `${duration.expected.toFixed(3)}s → ${duration.actual.toFixed(3)}s · Δ${duration.deltaSamples} 样本`,
    );
    updateVerifyRow(
      "verify-peak",
      peak.pass,
      `${peak.dbfs.toFixed(1)} dBFS · ${peak.clippedSamples} 削波`,
    );
    updateVerifyRow(
      "verify-untouched",
      untouched.pass,
      `${untouched.spans} 段 / ${untouched.samples.toLocaleString("zh-CN")} 样本 · 最大差 ${untouched.maxDifference.toExponential(1)}`,
    );
    updateVerifyRow(
      "verify-webcodecs",
      webCodecs.pass,
      webCodecs.available ? `${webCodecs.frames.toLocaleString("zh-CN")} 帧 · 峰 ${webCodecs.peak.toFixed(3)}` : "当前浏览器不支持，已跳过",
    );
    setProgress(100, verification.pass ? "导出完成，核验通过" : "导出完成，但存在需复核项");
    setStatus(verification.pass ? "导出核验通过：时长、峰值、未处理区均一致" : "导出完成，核验存在异常", !verification.pass);
    if (!verification.pass) toast("导出已生成，但核验未全部通过，请查看报告。", true);
  } catch (error) {
    console.error(error);
    setProgress(100, "导出失败");
    toast(`导出失败：${error instanceof Error ? error.message : "未知错误"}`, true);
    setStatus("导出失败", true);
  } finally {
    button.disabled = false;
  }
}

function bindExportControls()       {
  $("export-button").addEventListener("click", openExport);
  $("run-export").addEventListener("click", () => void runExport());
  $("cancel-export").addEventListener("click", () => $                   ("export-dialog").close());
  window.addEventListener("beforeunload", () => {
    if (exportAudioUrl) URL.revokeObjectURL(exportAudioUrl);
    if (exportManifestUrl) URL.revokeObjectURL(exportManifestUrl);
  });
}

function init()       {
  showLoaded(false);
  bindCanvas();
  bindSourceControls();
  bindEditingControls();
  bindExportControls();
  updateRangeFill($                  ("policy-slider"));
  updateRangeFill($                  ("shorten-amount"));
  $("engine-status").textContent = capabilitySummary();
  const resizeObserver = new ResizeObserver(() => waveform.resize());
  resizeObserver.observe($("canvas-wrap"));
  setStatus("本地工作台已就绪");
  void loadDemo();
}

init();
