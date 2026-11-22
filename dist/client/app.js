import { buildM3U8, buildManifest, confirmedEntries } from "../analysis/playlist.js";
             
                 
                   
                
             
                  
              
              
                            
import {
  audioContext,
  confirmedClips,
  createDemoAudio,
  downmixAsync,
  encodeWav,
  loadAudioFile,
  PlaybackEngine,
                   
                 
                     
} from "./audio.js";
import { drawComparison, drawOverview, drawWaveformStrip } from "./draw.js";

                        
               
               
                      
                       
                            
                          
 

                                              

const DEFAULTS = {
  minRepeat: 3.5,
  minGap: 20,
  transpose: 2,
  similarity: 76,
};

const $ =                        (selector        )    => {
  const element = document.querySelector   (selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const elements = {
  app: $("#app"),
  fileInput: $                  ("#fileInput"),
  importBtn: $                   ("#importBtn"),
  demoBtn: $                   ("#demoBtn"),
  emptyImport: $                   ("#emptyImport"),
  emptyDemo: $                   ("#emptyDemo"),
  dropZone: $                   ("#dropZone"),
  dropTitle: $("#dropTitle"),
  dropSub: $("#dropSub"),
  dropOverlay: $("#dropOverlay"),
  fileName: $("#fileName"),
  fileMeta: $("#fileMeta"),
  projectDot: $("#projectDot"),
  minRepeat: $                  ("#minRepeat"),
  minGap: $                  ("#minGap"),
  transpose: $                  ("#transpose"),
  similarity: $                  ("#similarity"),
  minRepeatValue: $("#minRepeatValue"),
  minGapValue: $("#minGapValue"),
  transposeValue: $("#transposeValue"),
  similarityValue: $("#similarityValue"),
  resetParams: $                   ("#resetParams"),
  analyzeBtn: $                   ("#analyzeBtn"),
  analyzeLabel: $("#analyzeLabel"),
  progressTrack: $("#progressTrack"),
  progressFill: $("#progressFill"),
  progressCopy: $("#progressCopy"),
  statScanned: $("#statScanned"),
  statGroups: $("#statGroups"),
  statRejected: $("#statRejected"),
  statPending: $("#statPending"),
  confirmedCount: $("#confirmedCount"),
  auditionBtn: $                   ("#auditionBtn"),
  exportBtn: $                   ("#exportBtn"),
  resultCount: $("#resultCount"),
  reviewProgressBar: $("#reviewProgressBar"),
  groupList: $("#groupList"),
  overviewCanvas: $                   ("#overviewCanvas"),
  overviewTime: $("#overviewTime"),
  overviewScale: $("#overviewScale"),
  detailEmpty: $("#detailEmpty"),
  detailContent: $("#detailContent"),
  detailNumber: $("#detailNumber"),
  detailTitle: $("#detailTitle"),
  detailMeta: $("#detailMeta"),
  detailScore: $("#detailScore"),
  detailStatus: $("#detailStatus"),
  compareCanvas: $                   ("#compareCanvas"),
  occurrenceCount: $("#occurrenceCount"),
  occurrenceList: $("#occurrenceList"),
  confirmBtn: $                   ("#confirmBtn"),
  rejectBtn: $                   ("#rejectBtn"),
  reviewHint: $("#reviewHint"),
  transport: $("#transport"),
  transportState: $("#transportState"),
  transportFill: $("#transportFill"),
  transportTime: $("#transportTime"),
  stopBtn: $                   ("#stopBtn"),
  toast: $("#toast"),
};

let project                      = null;
let features                       = null;
let result                        = null;
let worker                = null;
let busy = false;
let dirty = false;
let filter         = "all";
let selectedId                = null;
let compareA = 0;
let compareB = 1;
let toastTimer = 0;
let dragDepth = 0;
let transportTimer = 0;
let activeClip                                                           = null;
const playback = new PlaybackEngine();

function formatTime(seconds        , tenths = false)         {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const whole = Math.floor(safe % 60);
  const base = `${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}`;
  if (!tenths) return base;
  return `${base}.${Math.floor((safe % 1) * 10)}`;
}

function formatLong(seconds        )         {
  const safe = Math.max(0, seconds || 0);
  if (safe < 60) return `${safe.toFixed(1)}s`;
  if (safe < 3600) {
    const minutes = Math.floor(safe / 60);
    return `${minutes}m ${Math.round(safe % 60)}s`;
  }
  const hours = Math.floor(safe / 3600);
  return `${hours}h ${Math.round((safe % 3600) / 60)}m`;
}

function formatBytes(bytes        )         {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showToast(message        )       {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 3400);
}

function settings()                   {
  return {
    minRepeatSec: Number(elements.minRepeat.value),
    minGapSec: Number(elements.minGap.value),
    transposeSemitones: Number(elements.transpose.value),
    similarityThreshold: Number(elements.similarity.value) / 100,
  };
}

function updateRangeVisual(input                  )       {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const ratio = ((value - min) / Math.max(0.001, max - min)) * 100;
  input.style.setProperty("--fill", `${ratio}%`);
}

function updateParameterLabels()       {
  elements.minRepeatValue.textContent = `${Number(elements.minRepeat.value).toFixed(1)} 秒`;
  elements.minGapValue.textContent =
    Number(elements.minGap.value) >= 60
      ? `${(Number(elements.minGap.value) / 60).toFixed(1)} 分钟`
      : `${Number(elements.minGap.value)} 秒`;
  elements.transposeValue.textContent = `±${Number(elements.transpose.value).toFixed(1)} 半音`;
  elements.similarityValue.textContent = `${elements.similarity.value}%`;
  for (const input of [
    elements.minRepeat,
    elements.minGap,
    elements.transpose,
    elements.similarity,
  ]) {
    updateRangeVisual(input);
  }
}

function updateAnalyzeLabel()       {
  elements.analyzeBtn.disabled = !project || busy;
  if (busy) elements.analyzeLabel.textContent = "正在分析…";
  else if (!project) elements.analyzeLabel.textContent = "等待载入录音";
  else if (result && dirty) elements.analyzeLabel.textContent = "按新参数重新检索";
  else if (result) elements.analyzeLabel.textContent = "重新检索";
  else elements.analyzeLabel.textContent = "开始检索";
}

function markDirty()       {
  if (!result) return;
  dirty = true;
  updateAnalyzeLabel();
  elements.progressCopy.textContent = "参数已修改 · 重新检索后更新候选组";
}

function setProjectHeader()       {
  if (!project) {
    elements.fileName.textContent = "尚未载入录音";
    elements.fileMeta.textContent = "本地处理 · 不上传";
    elements.projectDot.classList.remove("ready");
    return;
  }
  elements.fileName.textContent = project.name;
  elements.fileMeta.textContent =
    project.source === "demo"
      ? `${formatLong(project.buffer.duration)} · 合成演示 · ${project.buffer.sampleRate / 1000} kHz`
      : `${formatLong(project.buffer.duration)} · ${project.buffer.sampleRate / 1000} kHz · ${formatBytes(project.size)}`;
  elements.projectDot.classList.add("ready");
  elements.dropTitle.textContent = "更换录音";
  elements.dropSub.textContent = `${project.name} · ${formatLong(project.buffer.duration)}`;
  elements.overviewScale.innerHTML = "";
  for (let i = 0; i <= 5; i++) {
    const span = document.createElement("span");
    span.textContent = formatTime((project.buffer.duration * i) / 5);
    elements.overviewScale.append(span);
  }
  drawOverview(
    elements.overviewCanvas,
    project.peaks,
    project.buffer.duration,
    result?.groups ?? [],
    selectedId,
    null,
  );
  elements.overviewTime.textContent = `00:00.0 / ${formatTime(project.buffer.duration, true)}`;
}

function currentGroup()                    {
  return result?.groups.find((group) => group.id === selectedId) ?? null;
}

function visibleGroups()               {
  if (!result) return [];
  if (filter === "all") return result.groups;
  return result.groups.filter((group) => group.status === filter);
}

function chooseInitialSelection()       {
  if (!result?.groups.length) {
    selectedId = null;
    return;
  }
  const current = currentGroup();
  if (current) return;
  const pending = result.groups.find((group) => group.status === "pending");
  selectedId = (pending ?? result.groups[0]).id;
  compareA = 0;
  compareB = 1;
}

async function ingestAudio(
  name        ,
  size        ,
  loader                            ,
  source                 ,
)                {
  if (busy) return;
  busy = true;
  updateAnalyzeLabel();
  elements.progressFill.style.width = "12%";
  elements.progressCopy.textContent = "正在读取音频…";
  try {
    const loaded = await loader();
    project = {
      name,
      size,
      buffer: loaded.buffer,
      peaks: loaded.peaks,
      mono: loaded.mono,
      source,
    };
    features = null;
    result = null;
    selectedId = null;
    dirty = false;
    playback.setBuffer(loaded.buffer);
    setProjectHeader();
    updateStats();
    renderQueue();
    renderDetail();
    void audioContext().resume().catch(() => undefined);
    busy = false;
    updateAnalyzeLabel();
    void startAnalysis();
  } catch (error) {
    busy = false;
    updateAnalyzeLabel();
    elements.progressFill.style.width = "0";
    const message = error instanceof Error ? error.message : String(error);
    elements.progressCopy.textContent = "载入失败，请检查音频格式";
    showToast(`无法载入音频：${message}`);
  }
}

async function loadFile(file      )                {
  await ingestAudio(
    file.name,
    file.size,
    () => loadAudioFile(file, (message) => {
      elements.progressCopy.textContent = message;
    }),
    "file",
  );
}

async function loadDemo()                {
  await ingestAudio(
    "echo-takes-demo.wav",
    0,
    async () => {
      elements.progressCopy.textContent = "正在合成示例人声…";
      await new Promise((resolve) => window.setTimeout(resolve, 30));
      const demo = createDemoAudio();
      return { ...demo, waveformMs: 0 };
    },
    "demo",
  );
}

async function startAnalysis()                {
  if (!project || busy) return;
  worker?.terminate();
  worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });
  busy = true;
  dirty = false;
  elements.app.classList.add("is-busy");
  elements.progressFill.style.width = "2%";
  elements.progressCopy.textContent = "准备音高轮廓…";
  updateAnalyzeLabel();
  let samples              ;
  if (project.mono) {
    samples = project.mono;
    project.mono = null;
  } else {
    elements.progressCopy.textContent = "正在重建分析单声道…";
    try {
      samples = await downmixAsync(project.buffer, (value) => {
        elements.progressFill.style.width = `${2 + value * 6}%`;
        elements.progressCopy.textContent = `正在重建分析单声道… ${Math.round(value * 100)}%`;
      });
    } catch (error) {
      finishAnalysis();
      elements.progressCopy.textContent = "无法准备分析数据";
      showToast(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  const requestSettings = settings();
  worker.onmessage = (event                           ) => {
    const message = event.data;
    if (message.type === "progress") {
      elements.progressFill.style.width = `${(message.value * 100).toFixed(1)}%`;
      elements.progressCopy.textContent = `${message.detail} · ${Math.round(message.value * 100)}%`;
      return;
    }
    if (message.type === "error") {
      finishAnalysis();
      elements.progressFill.style.width = "0";
      elements.progressCopy.textContent = "分析中断";
      showToast(`分析失败：${message.message}`);
      return;
    }
    features = message.features;
    result = message.result;
    finishAnalysis();
    dirty = false;
    elements.progressFill.style.width = "100%";
    elements.progressCopy.textContent = result.groups.length
      ? `扫描完成 · 找到 ${result.groups.length} 组远距旋律候选`
      : "扫描完成 · 没有超过门槛的可靠候选";
    chooseInitialSelection();
    updateStats();
    renderQueue();
    renderDetail();
    drawOverview(
      elements.overviewCanvas,
      project .peaks,
      project .buffer.duration,
      result.groups,
      selectedId,
      null,
    );
    showToast(
      result.groups.length
        ? `已找到 ${result.groups.length} 组候选，请逐组确认`
        : "本轮没有可靠重复。可尝试缩短最短长度或降低相似度门槛。",
    );
  };
  worker.onerror = (event) => {
    finishAnalysis();
    elements.progressFill.style.width = "0";
    elements.progressCopy.textContent = "分析器异常";
    showToast(`分析器异常：${event.message}`);
  };
  worker.postMessage(
    {
      type: "analyze",
      samples,
      sampleRate: project.buffer.sampleRate,
      durationSec: project.buffer.duration,
      settings: requestSettings,
    },
    [samples.buffer               ],
  );
}

function finishAnalysis()       {
  busy = false;
  elements.app.classList.remove("is-busy");
  worker?.terminate();
  worker = null;
  updateAnalyzeLabel();
  updateStats();
}

function updateStats()       {
  const groups = result?.groups ?? [];
  const pending = groups.filter((group) => group.status === "pending").length;
  const confirmed = groups.filter((group) => group.status === "confirmed").length;
  const reviewed = groups.filter((group) => group.status !== "pending").length;
  elements.statScanned.textContent = features
    ? formatLong(features.stats.voicedSec)
    : "—";
  elements.statGroups.textContent = result ? String(groups.length) : "—";
  elements.statRejected.textContent = result
    ? formatLong(result.rejectedSec)
    : "—";
  elements.statPending.textContent = result ? String(pending) : "—";
  elements.confirmedCount.textContent = `${confirmed} / ${groups.length} 已确认`;
  elements.reviewProgressBar.style.width = `${groups.length ? (reviewed / groups.length) * 100 : 0}%`;
  const entries = confirmedEntries(groups);
  elements.auditionBtn.disabled = entries.length === 0;
  elements.exportBtn.disabled = entries.length === 0;
  elements.auditionBtn.innerHTML = entries.length
    ? `<span>▷</span> 试听串烧 · ${entries.length}`
    : "<span>▷</span> 试听串烧";
}

function renderQueue()       {
  elements.groupList.innerHTML = "";
  const groups = visibleGroups();
  const allGroups = result?.groups ?? [];
  elements.resultCount.textContent = String(allGroups.length);

  if (!groups.length) {
    const placeholder = document.createElement("div");
    placeholder.className = "queue-empty-filter";
    placeholder.innerHTML = result
      ? filter === "pending"
        ? "没有待复核候选。<br />切换筛选查看已确认或排除的组。"
        : filter === "confirmed"
          ? "还没有确认的候选组。<br />逐组试听并确认后，会汇集到这里。"
          : "本轮没有形成可靠候选。<br />可降低相似度门槛后重新检索。"
      : "载入录音后，相似但演唱不同的<br />远距离段落会出现在这里。";
    elements.groupList.append(placeholder);
    return;
  }

  const fragment = document.createDocumentFragment();
  groups.forEach((group, visibleIndex) => {
    const rank = allGroups.indexOf(group) + 1;
    const card = document.createElement("article");
    card.className = `group-card ${group.status}`;
    if (group.id === selectedId) card.classList.add("selected");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute(
      "aria-label",
      `候选组 ${rank}，相似度 ${Math.round(group.score * 100)}%，${group.occurrences.length} 个片段`,
    );
    const occurrence = group.occurrences[0];
    const startList = group.occurrences
      .slice(0, 3)
      .map((item) => formatTime(item.start, true))
      .join(" · ");
    card.innerHTML = `
      <div class="group-rank"><span>${String(rank).padStart(2, "0")}</span><i></i></div>
      <div class="group-main">
        <div class="group-title-row">
          <strong>旋律重复候选</strong>
          <span>${group.occurrences.length} take${group.occurrences.length > 1 ? "s" : ""}</span>
        </div>
        <canvas data-role="thumb"></canvas>
        <div class="group-times">
          <span>${startList}${group.occurrences.length > 3 ? " …" : ""}</span>
          <span>${formatTime(occurrence.start, true)} → ${formatTime(occurrence.end, true)}</span>
        </div>
      </div>
      <div class="group-score">
        <strong>${Math.round(group.score * 100)}%</strong>
        <span class="group-status-mark">${statusGlyph(group.status)}</span>
      </div>
    `;
    card.addEventListener("click", () => selectGroup(group.id));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectGroup(group.id);
      }
    });
    fragment.append(card);
    requestAnimationFrame(() => {
      const canvas = card.querySelector                   (
        'canvas[data-role="thumb"]',
      );
      if (!canvas || !project || !card.isConnected) return;
      drawWaveformStrip(
        canvas,
        project.peaks,
        occurrence.start,
        occurrence.end,
        {
          color:
            group.status === "confirmed"
              ? "rgba(101,219,179,0.78)"
              : group.status === "rejected"
                ? "rgba(125,137,149,0.45)"
                : group.id === selectedId
                  ? "rgba(255,196,118,0.92)"
                  : "rgba(242,176,92,0.58)",
          fill:
            group.status === "confirmed"
              ? "rgba(101,219,179,0.08)"
              : "rgba(242,176,92,0.055)",
        },
      );
    });
    if (visibleIndex === -1) card.remove();
  });
  elements.groupList.append(fragment);
}

function statusGlyph(status             )         {
  if (status === "confirmed") return "✓";
  if (status === "rejected") return "×";
  return "·";
}

function statusLabel(status             )         {
  if (status === "confirmed") return "已确认";
  if (status === "rejected") return "已排除";
  return "待复核";
}

function selectGroup(id        )       {
  if (id === selectedId) return;
  selectedId = id;
  compareA = 0;
  compareB = 1;
  renderQueue();
  renderDetail();
  const group = currentGroup();
  if (group && project) {
    drawOverview(
      elements.overviewCanvas,
      project.peaks,
      project.buffer.duration,
      result?.groups ?? [],
      selectedId,
      null,
    );
    elements.overviewTime.textContent = `${formatTime(group.occurrences[0].start, true)} / ${formatTime(project.buffer.duration, true)}`;
  }
}

function setEmptyCopy(title        , body        , showActions         )       {
  const heading = elements.detailEmpty.querySelector("h2");
  const paragraph = elements.detailEmpty.querySelector("p");
  const actions = elements.detailEmpty.querySelector             (".empty-actions");
  if (heading) heading.innerHTML = title;
  if (paragraph) paragraph.textContent = body;
  if (actions) actions.hidden = !showActions;
}

function renderDetail()       {
  const group = currentGroup();
  if (!group) {
    elements.detailContent.hidden = true;
    elements.detailEmpty.hidden = false;
    if (result) {
      setEmptyCopy(
        "这一轮没有发现<br />可靠的远距重复",
        "空白与宽带噪声已被门限过滤。可以缩短最短重复长度、增大移调容差，或降低相似度门槛再扫描一次。",
        true,
      );
    } else {
      setEmptyCopy(
        "让相隔很远的演唱<br />在这里重新相遇",
        "上传几小时的单声道录音，自动提取旋律轮廓。每组候选都保留起止时间、匹配分数和可对比的小波形，由你逐组决定去留。",
        true,
      );
    }
    return;
  }
  if (!project || !features) return;
  elements.detailEmpty.hidden = true;
  elements.detailContent.hidden = false;
  const allIndex = result?.groups.indexOf(group) ?? 0;
  compareA = Math.min(compareA, group.occurrences.length - 1);
  compareB = Math.min(
    Math.max(0, compareB),
    group.occurrences.length - 1,
  );
  if (group.occurrences.length > 1 && compareA === compareB) {
    compareB = (compareA + 1) % group.occurrences.length;
  }
  const minimumGap = group.occurrences
    .slice(1)
    .reduce(
      (minimum, item, index) =>
        Math.min(minimum, item.start - group.occurrences[index].end),
      Number.POSITIVE_INFINITY,
    );
  const averageShift =
    group.occurrences.reduce((sum, item) => sum + Math.abs(item.shift), 0) /
    Math.max(1, group.occurrences.length);
  elements.detailNumber.textContent = `GROUP ${String(allIndex + 1).padStart(2, "0")}`;
  elements.detailTitle.textContent = "远距旋律重复候选";
  elements.detailMeta.textContent = `${group.occurrences.length} 个演唱片段 · 相邻间隔 ${Number.isFinite(minimumGap) ? formatLong(minimumGap) : "—"} · 平均移调 ${averageShift.toFixed(1)} 半音`;
  elements.detailScore.textContent = `${Math.round(group.score * 100)}%`;
  elements.detailStatus.textContent = statusLabel(group.status);
  elements.detailStatus.className = `status-pill ${group.status}`;
  elements.occurrenceCount.textContent = `${group.occurrences.length} 个片段`;
  elements.reviewHint.textContent =
    group.status === "confirmed"
      ? "已写入命中清单 · 可继续确认或排除"
      : group.status === "rejected"
        ? "已排除出清单 · 可重新确认"
        : "确认后将进入只播放命中片段的清单";
  renderOccurrences(group);
  drawComparison(
    elements.compareCanvas,
    project.peaks,
    features,
    group.occurrences[compareA],
    group.occurrences[compareB] ?? group.occurrences[compareA],
  );
}

function renderOccurrences(group            )       {
  if (!project) return;
  elements.occurrenceList.innerHTML = "";
  const fragment = document.createDocumentFragment();
  group.occurrences.forEach((occurrence, index) => {
    const article = document.createElement("article");
    article.className = "occurrence";
    if (index === compareA) article.classList.add("is-a");
    if (index === compareB) article.classList.add("is-b");
    const marker =
      index === compareA ? "A" : index === compareB ? "B" : String(index + 1);
    const duration = occurrence.end - occurrence.start;
    const shiftCopy =
      Math.abs(occurrence.shift) >= 0.25
        ? ` · ${occurrence.shift > 0 ? "+" : ""}${occurrence.shift.toFixed(1)} 半音`
        : "";
    article.innerHTML = `
      <span class="take-tag">${marker}</span>
      <div class="take-info">
        <span class="take-time">${formatTime(occurrence.start, true)} → ${formatTime(occurrence.end, true)}</span>
        <span class="take-note">${duration.toFixed(2)}s · ${Math.round(occurrence.score * 100)}%${shiftCopy}</span>
        <canvas data-role="take-wave"></canvas>
      </div>
      <button class="play-mini" type="button" aria-label="试听片段 ${index + 1}">▷</button>
    `;
    article.addEventListener("click", () => {
      if (group.occurrences.length < 2) return;
      compareA = compareB;
      compareB = index;
      if (compareA === compareB) compareA = (compareB + 1) % group.occurrences.length;
      renderDetail();
    });
    const playButton = article.querySelector                   (".play-mini");
    playButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      void playOccurrence(occurrence, group);
    });
    fragment.append(article);
    requestAnimationFrame(() => {
      const canvas = article.querySelector                   (
        'canvas[data-role="take-wave"]',
      );
      if (!canvas || !canvas.isConnected) return;
      const accent =
        index === compareA
          ? "rgba(255,208,148,0.94)"
          : index === compareB
            ? "rgba(114,234,227,0.9)"
            : "rgba(157,172,185,0.65)";
      drawWaveformStrip(
        canvas,
        project .peaks,
        occurrence.start,
        occurrence.end,
        {
          color: accent,
          fill:
            index === compareA
              ? "rgba(242,176,92,0.07)"
              : index === compareB
                ? "rgba(98,211,207,0.06)"
                : "rgba(255,255,255,0.025)",
        },
      );
    });
  });
  elements.occurrenceList.append(fragment);
}

function redrawCanvases()       {
  if (!project) return;
  drawOverview(
    elements.overviewCanvas,
    project.peaks,
    project.buffer.duration,
    result?.groups ?? [],
    selectedId,
    activeClip ? playheadPosition() : null,
  );
  renderQueue();
  const group = currentGroup();
  if (group && features) {
    renderOccurrences(group);
    renderDetail();
  }
}

function playheadPosition()                {
  if (!activeClip) return null;
  const elapsed = (performance.now() - activeClip.startedAt) / 1000;
  return Math.min(activeClip.end, activeClip.start + Math.max(0, elapsed));
}

function startPlayheadLoop()       {
  window.clearInterval(transportTimer);
  transportTimer = window.setInterval(() => {
    const position = playheadPosition();
    if (!project || position === null) return;
    drawOverview(
      elements.overviewCanvas,
      project.peaks,
      project.buffer.duration,
      result?.groups ?? [],
      selectedId,
      position,
    );
    elements.overviewTime.textContent = `${formatTime(position, true)} / ${formatTime(project.buffer.duration, true)}`;
    const duration = activeClip ? activeClip.end - activeClip.start : 1;
    const progress = activeClip
      ? Math.max(0, Math.min(1, (position - activeClip.start) / duration))
      : 0;
    elements.transportFill.style.width = `${progress * 100}%`;
    elements.transportTime.textContent = `${formatTime(position, true)} / ${formatTime(activeClip?.end ?? 0, true)}`;
  }, 90);
}

function showTransport(label        )       {
  elements.transport.hidden = false;
  elements.app.classList.add("has-transport");
  elements.transportState.textContent = label;
  startPlayheadLoop();
}

function hideTransport()       {
  window.clearInterval(transportTimer);
  activeClip = null;
  elements.transport.hidden = true;
  elements.app.classList.remove("has-transport");
  if (project) {
    drawOverview(
      elements.overviewCanvas,
      project.peaks,
      project.buffer.duration,
      result?.groups ?? [],
      selectedId,
      null,
    );
    elements.overviewTime.textContent = `00:00.0 / ${formatTime(project.buffer.duration, true)}`;
  }
}

async function playOccurrence(
  occurrence                 ,
  group            ,
)                {
  if (!project) return;
  const groupIndex = (result?.groups.indexOf(group) ?? 0) + 1;
  await playback.playClip(occurrence, hideTransport);
  activeClip = {
    start: occurrence.start,
    end: occurrence.end,
    startedAt: performance.now(),
  };
  showTransport(`GROUP ${String(groupIndex).padStart(2, "0")} · 单段试听`);
}

async function auditionHits()                {
  if (!result) return;
  const clips = confirmedClips(result.groups);
  if (!clips.length) {
    showToast("请先确认至少一组候选。");
    return;
  }
  await playback.playReel(
    clips,
    hideTransport,
    (state           ) => {
      activeClip = {
        start: state.start,
        end: state.end,
        startedAt: performance.now(),
      };
      elements.transportState.textContent = `命中串烧 ${state.index + 1} / ${state.total}`;
    },
  );
  activeClip = {
    start: clips[0].start,
    end: clips[0].end,
    startedAt: performance.now(),
  };
  showTransport(`命中串烧 1 / ${clips.length}`);
}

function setGroupStatus(status             )       {
  const group = currentGroup();
  if (!group || !result) return;
  const previous = group.status;
  group.status = status;
  updateStats();
  drawOverview(
    elements.overviewCanvas,
    project .peaks,
    project .buffer.duration,
    result.groups,
    selectedId,
    null,
  );
  if (status === "confirmed") {
    showToast(`候选组已确认，已加入 ${confirmedEntries(result.groups).length} 段命中清单。`);
  } else if (status === "rejected") {
    showToast("候选组已排除，不会进入导出清单。");
  } else {
    showToast("候选组已改回待复核。");
  }
  const next = result.groups.find(
    (candidate) => candidate.id !== group.id && candidate.status === "pending",
  );
  if (next && status !== "pending" && filter !== "confirmed") {
    selectedId = next.id;
    compareA = 0;
    compareB = 1;
  } else if (previous !== status) {
    selectedId = group.id;
  }
  renderQueue();
  renderDetail();
}

function moveSelection(direction        )       {
  const groups = visibleGroups();
  if (!groups.length) return;
  const index = groups.findIndex((group) => group.id === selectedId);
  const next = (index + direction + groups.length) % groups.length;
  selectGroup(groups[next].id);
}

function downloadBlob(filename        , blob      )       {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportHitList()       {
  if (!project || !result) return;
  const entries = confirmedEntries(result.groups);
  if (!entries.length) {
    showToast("清单为空：请先确认至少一组候选。");
    return;
  }
  const base = project.name.replace(/\.[^.]+$/, "") || "echo-takes";
  const manifestInput = {
    sourceName: project.name,
    durationSec: project.buffer.duration,
    groups: result.groups,
  };
  downloadBlob(
    `${base}-hits.m3u8`,
    new Blob([buildM3U8(manifestInput)], { type: "audio/x-mpegurl;charset=utf-8" }),
  );
  window.setTimeout(() => {
    downloadBlob(
      `${base}-hits.json`,
      new Blob([buildManifest(manifestInput)], {
        type: "application/json;charset=utf-8",
      }),
    );
  }, 100);
  if (project.source === "demo") {
    window.setTimeout(() => {
      downloadBlob(
        project .name,
        new Blob([encodeWav(project .buffer)], { type: "audio/wav" }),
      );
    }, 200);
  }
  showToast(
    `已导出 ${entries.length} 段命中。将 M3U8、音频文件放在同一目录即可只播放命中片段。`,
  );
}

function openFilePicker()       {
  if (busy) {
    showToast("当前分析仍在进行，请稍候。");
    return;
  }
  elements.fileInput.click();
}

function applyFilter(next        )       {
  filter = next;
  document.querySelectorAll                   (".filter-chip").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === filter);
  });
  const groups = visibleGroups();
  if (groups.length && !groups.some((group) => group.id === selectedId)) {
    selectedId = groups[0].id;
    compareA = 0;
    compareB = 1;
  }
  renderQueue();
  renderDetail();
}

function resetParameters()       {
  elements.minRepeat.value = String(DEFAULTS.minRepeat);
  elements.minGap.value = String(DEFAULTS.minGap);
  elements.transpose.value = String(DEFAULTS.transpose);
  elements.similarity.value = String(DEFAULTS.similarity);
  updateParameterLabels();
  markDirty();
}

function bindEvents()       {
  elements.importBtn.addEventListener("click", openFilePicker);
  elements.emptyImport.addEventListener("click", openFilePicker);
  elements.dropZone.addEventListener("click", openFilePicker);
  elements.fileInput.addEventListener("change", () => {
    const file = elements.fileInput.files?.[0];
    elements.fileInput.value = "";
    if (file) void loadFile(file);
  });
  elements.demoBtn.addEventListener("click", () => void loadDemo());
  elements.emptyDemo.addEventListener("click", () => void loadDemo());
  elements.analyzeBtn.addEventListener("click", () => void startAnalysis());
  elements.resetParams.addEventListener("click", resetParameters);
  elements.confirmBtn.addEventListener("click", () => setGroupStatus("confirmed"));
  elements.rejectBtn.addEventListener("click", () => setGroupStatus("rejected"));
  elements.auditionBtn.addEventListener("click", () => void auditionHits());
  elements.exportBtn.addEventListener("click", exportHitList);
  elements.stopBtn.addEventListener("click", () => {
    playback.stop();
    hideTransport();
  });

  for (const input of [
    elements.minRepeat,
    elements.minGap,
    elements.transpose,
    elements.similarity,
  ]) {
    input.addEventListener("input", () => {
      updateParameterLabels();
      markDirty();
    });
  }

  document.querySelectorAll                   (".filter-chip").forEach((button) => {
    button.addEventListener("click", () => {
      applyFilter((button.dataset.filter          ) ?? "all");
    });
  });

  elements.overviewCanvas.addEventListener("click", (event) => {
    if (!project || !result) return;
    const rect = elements.overviewCanvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const position = ratio * project.buffer.duration;
    const hit = result.groups
      .filter((group) => group.status !== "rejected")
      .flatMap((group) =>
        group.occurrences.map((occurrence) => ({ group, occurrence })),
      )
      .find(
        ({ occurrence }) =>
          position >= occurrence.start - 0.35 && position <= occurrence.end + 0.35,
      );
    if (hit) {
      selectGroup(hit.group.id);
      void playOccurrence(hit.occurrence, hit.group);
      return;
    }
    const end = Math.min(project.buffer.duration, position + 4);
    if (end - position < 0.2) return;
    void playback
      .playClip({ start: position, end }, hideTransport)
      .then(() => {
        activeClip = {
          start: position,
          end,
          startedAt: performance.now(),
        };
        showTransport("时间轴定位试听");
      });
  });

  window.addEventListener("keydown", (event) => {
    const target = event.target                      ;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void startAnalysis();
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void startAnalysis();
      return;
    }
    if (event.key.toLowerCase() === "j") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key.toLowerCase() === "k") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Enter" && currentGroup()) {
      event.preventDefault();
      setGroupStatus("confirmed");
    } else if (event.key.toLowerCase() === "x" && currentGroup()) {
      event.preventDefault();
      setGroupStatus("rejected");
    } else if (event.key === "Escape" && !elements.transport.hidden) {
      playback.stop();
      hideTransport();
    }
  });

  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => redrawCanvases());
  });

  window.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dragDepth++;
    elements.dropOverlay.hidden = false;
  });
  window.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) elements.dropOverlay.hidden = true;
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    elements.dropOverlay.hidden = true;
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  });
  window.addEventListener("beforeunload", () => playback.stop());
}

function initialize()       {
  bindEvents();
  updateParameterLabels();
  updateAnalyzeLabel();
  updateStats();
  setProjectHeader();
  renderQueue();
  renderDetail();
}

initialize();
