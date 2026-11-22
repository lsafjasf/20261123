// UI 主逻辑：加载 -> 标记删除区间（源片模式）-> 生成方案/决策（成片模式）-> 导出。
import { demux, type Movie } from "../core/mp4/demux.ts";
import { buildPlan, resolveSegment, type CutPlan, type Range } from "../core/edit/plan.ts";
import { buildOutput, type TranscodedSegment } from "../core/edit/export.ts";
import { PlanPlayer } from "./player.ts";
import { transcodeSegment } from "./transcode.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let movie: Movie | null = null;
let player: PlanPlayer | null = null;
let ranges: Range[] = [];
let draftStart: number | null = null;
let plan: CutPlan | null = null;
let mode: "edit" | "review" = "edit";
let isPlaying = false;
const transcodeCache = new Map<number, Promise<TranscodedSegment>>();

const fmt = (s: number): string => s.toFixed(3);

function setStatus(el: HTMLElement, html: string): void {
  el.innerHTML = html;
}

async function loadFile(file: File): Promise<void> {
  const buf = new Uint8Array(await file.arrayBuffer());
  movie = demux(buf);
  const vt = movie.tracks.find((t) => t.kind === "video");
  const at = movie.tracks.find((t) => t.kind === "audio");
  const durSec = movie.duration / movie.timescale;
  $("fileInfo").textContent =
    `${file.name} | ${fmt(durSec)}s | 视频 ${vt?.codec ?? "-"} ${vt?.width}x${vt?.height}` +
    ` | 音频 ${at?.codec ?? "无"} | 关键帧 ${vt?.samples.filter((s) => s.keyframe).length ?? 0}`;
  if (typeof VideoDecoder === "undefined") {
    alert("当前浏览器不支持 WebCodecs，预览与转码不可用（仍可无损导出）");
  }
  player?.dispose();
  player = new PlanPlayer(movie, $<HTMLCanvasElement>("screen"));
  player.onTime = (t, d) => {
    $("clock").textContent = `${fmt(t)} / ${fmt(d)}`;
    const seek = $("seek") as HTMLInputElement;
    if (document.activeElement !== seek) {
      seek.max = String(d);
      seek.value = String(t);
    }
    drawTimeline();
  };
  player.onEnded = () => { isPlaying = false; $("playBtn").textContent = "播放"; };
  player.startRenderLoop();
  ranges = [];
  draftStart = null;
  enterEditMode();
  $("app").hidden = false;
}

// 源片模式：整片可预览，便于标记删除区间
function enterEditMode(): void {
  if (!movie || !player) return;
  mode = "edit";
  plan = buildPlan(movie, []);
  player.setPlan(plan);
  player.seek(0);
  renderRanges();
  setStatus($("planSummary"), "源片模式：标记删除区间后点击「生成剪辑方案」");
  $("segments").innerHTML = "";
  ($("exportBtn") as HTMLButtonElement).disabled = true;
}

async function enterReviewMode(): Promise<void> {
  if (!movie || !player) return;
  mode = "review";
  transcodeCache.clear();
  plan = buildPlan(movie, ranges);
  player.setPlan(plan);
  player.seek(0);
  renderPlan();
}

function renderRanges(): void {
  const ul = $("ranges");
  ul.innerHTML = "";
  ranges.forEach((r, i) => {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "row";
    const s = document.createElement("input");
    s.type = "number"; s.step = "0.001"; s.min = "0"; s.value = fmt(r.start);
    const e = document.createElement("input");
    e.type = "number"; e.step = "0.001"; e.min = "0"; e.value = fmt(r.end);
    s.onchange = () => { r.start = Number(s.value); drawTimeline(); };
    e.onchange = () => { r.end = Number(e.value); drawTimeline(); };
    const del = document.createElement("button");
    del.textContent = "删除";
    del.className = "danger";
    del.onclick = () => { ranges.splice(i, 1); renderRanges(); drawTimeline(); };
    row.append(document.createTextNode("删 "), s, document.createTextNode(" → "), e, del);
    li.append(row);
    ul.append(li);
  });
  const hint = document.createElement("li");
  hint.textContent = draftStart !== null
    ? `草稿起点 ${fmt(draftStart)}s —— 移动到终点后点「在此刻结束删除区」`
    : "用播放头定位，点「在此刻开始删除区」";
  ul.append(hint);
}

function renderPlan(): void {
  if (!plan || !movie) return;
  const losslessHtml = plan.pendingCount > 0
    ? `<span class="lossy">有 ${plan.pendingCount} 处切点待决策</span>`
    : plan.fullyLossless
      ? `<span class="lossless">完全无损（不重编码）</span>`
      : `<span class="lossy">部分转码（仅标记段重编码）</span>`;
  setStatus(
    $("planSummary"),
    `最终时长 <b>${fmt(plan.finalDuration)}s</b>（共 ${plan.segments.filter((s) => !s.dropped).length} 段）<br>` +
      `状态：${losslessHtml}<br>` +
      `音画最大累计偏差：${(plan.avDriftMaxSec * 1000).toFixed(2)}ms` +
      (plan.notes.length ? `<br><span class="note">${plan.notes.join("<br>")}</span>` : ""),
  );
  const ul = $("segments");
  ul.innerHTML = "";
  for (const seg of plan.segments) {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "row";
    const badge = document.createElement("span");
    badge.className = "badge " + (seg.mode === "lossless" ? "ok" : seg.mode === "pending" ? "pending" : "transcode");
    badge.textContent = seg.dropped ? "已丢弃" : seg.mode === "lossless" ? "无损" : seg.mode === "pending" ? "待决策" : "转码";
    row.append(
      badge,
      document.createTextNode(` #${seg.index + 1}  ${fmt(seg.start)} → ${fmt(seg.end)}  (${fmt(seg.videoDurSec)}s)`),
    );
    li.append(row);
    for (const n of seg.notes) {
      const d = document.createElement("div");
      d.className = "note";
      d.textContent = n;
      li.append(d);
    }
    if (seg.mode === "pending" && seg.snapOptions) {
      const btns = document.createElement("div");
      btns.className = "row";
      const opts = seg.snapOptions;
      if (opts.prev !== null) {
        const b = document.createElement("button");
        b.textContent = `吸附到上一关键帧 ${fmt(opts.prev)}s`;
        b.onclick = () => { resolveSegment(movie!, plan!, seg.index, "snap-prev"); player!.setPlan(plan!); renderPlan(); };
        btns.append(b);
      }
      if (opts.next !== null) {
        const b = document.createElement("button");
        b.textContent = `吸附到下一关键帧 ${fmt(opts.next)}s`;
        b.onclick = () => { resolveSegment(movie!, plan!, seg.index, "snap-next"); player!.setPlan(plan!); renderPlan(); };
        btns.append(b);
      }
      const t = document.createElement("button");
      t.className = "warn";
      t.textContent = "转码该段（仅该段有损）";
      t.onclick = () => { resolveSegment(movie!, plan!, seg.index, "transcode"); player!.setPlan(plan!); renderPlan(); };
      btns.append(t);
      li.append(btns);
    }
    ul.append(li);
  }
  const activeSegs = plan.segments.filter((s) => !s.dropped).length;
  ($("exportBtn") as HTMLButtonElement).disabled = plan.pendingCount > 0 || activeSegs === 0;
}

// 时间轴：源片时间 + 关键帧刻度 + 删除区间 + 播放头
function drawTimeline(): void {
  const cv = $("timeline") as unknown as HTMLCanvasElement;
  if (!movie || !player) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth * dpr;
  const H = 64 * dpr;
  if (cv.width !== W) { cv.width = W; cv.height = H; }
  const g = cv.getContext("2d")!;
  const dur = movie.duration / movie.timescale;
  const x = (t: number): number => (t / dur) * W;
  g.clearRect(0, 0, W, H);
  g.fillStyle = "#0d0f12";
  g.fillRect(0, 0, W, H);
  // 删除区间
  g.fillStyle = "rgba(197,48,48,0.45)";
  for (const r of ranges) g.fillRect(x(r.start), 0, Math.max(1, x(r.end) - x(r.start)), H);
  if (draftStart !== null && mode === "edit") {
    g.fillStyle = "rgba(217,164,65,0.4)";
    const t = player.playhead();
    g.fillRect(x(Math.min(draftStart, t)), 0, Math.abs(x(t) - x(draftStart)), H);
  }
  // 关键帧刻度
  const vt = movie.tracks.find((t) => t.kind === "video")!;
  g.fillStyle = "#4a5568";
  for (const s of vt.samples) {
    if (!s.keyframe) continue;
    const kx = x(s.cts / vt.timescale);
    g.fillRect(kx, H * 0.55, Math.max(1, dpr), H * 0.45);
  }
  // 播放头
  const ph = mode === "edit" ? player.playhead() : sourceFromOutput(player.playhead());
  g.strokeStyle = "#68d391";
  g.lineWidth = dpr;
  g.beginPath();
  g.moveTo(x(ph), 0);
  g.lineTo(x(ph), H);
  g.stroke();
}

// 成片时间 -> 源片时间（用于在源片时间轴上显示播放头）
function sourceFromOutput(outT: number): number {
  if (!plan) return outT;
  let acc = 0;
  for (const seg of plan.segments) {
    if (seg.dropped || seg.mode === "pending") continue;
    if (outT <= acc + seg.videoDurSec) return seg.start + (outT - acc);
    acc += seg.videoDurSec;
  }
  return plan.segments.length ? plan.segments[plan.segments.length - 1].end : outT;
}

async function doExport(): Promise<void> {
  if (!movie || !plan) return;
  if (plan.pendingCount > 0) {
    alert("还有未确认的切点：请先选择吸附还是转码");
    return;
  }
  const kind = plan.fullyLossless ? "完全无损（不重编码）" : "含转码段";
  if (!confirm(`确认生成文件？\n最终时长 ${fmt(plan.finalDuration)}s，${kind}`)) return;
  const status = $("exportStatus");
  setStatus(status, "正在生成…");
  ($("exportBtn") as HTMLButtonElement).disabled = true;
  try {
    const provider = async (i: number): Promise<TranscodedSegment> => {
      let p = transcodeCache.get(i);
      if (!p) {
        setStatus(status, `正在转码第 ${i + 1} 段…`);
        p = transcodeSegment(movie!, plan!.segments[i]);
        transcodeCache.set(i, p);
      }
      return p;
    };
    const out = await buildOutput(movie, plan, provider);
    const blob = new Blob([out.data as BlobPart], { type: "video/mp4" });
    const name = `cut-${Date.now()}.mp4`;
    // 浏览器下载
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    // 可选：保存到服务器 exports/
    if (($("saveServer") as HTMLInputElement).checked) {
      const resp = await fetch(`/save?name=${encodeURIComponent(name)}`, { method: "POST", body: blob });
      const j = await resp.json();
      setStatus(status, `已保存：${j.file}`);
    }
    const video = $("result") as unknown as HTMLVideoElement;
    video.src = URL.createObjectURL(blob);
    video.hidden = false;
    setStatus(
      status,
      `已生成 ${name}（${(out.data.byteLength / 1048576).toFixed(1)}MB）\n` +
        `最终时长 ${fmt(out.finalDuration)}s | ${out.fullyLossless ? "完全无损" : "部分转码"} | ` +
        `音画偏差 ≤${(out.avDriftMaxSec * 1000).toFixed(2)}ms`,
    );
  } catch (e) {
    setStatus(status, `导出失败：${String(e)}`);
  } finally {
    ($("exportBtn") as HTMLButtonElement).disabled = plan.pendingCount > 0;
  }
}

// ---- 事件 ----
$("file").addEventListener("change", (ev) => {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (f) loadFile(f).catch((e) => alert(`加载失败：${String(e)}`));
});
$("playBtn").addEventListener("click", () => {
  if (!player) return;
  if (!isPlaying) {
    isPlaying = true;
    void player.play();
    $("playBtn").textContent = "暂停";
  } else {
    isPlaying = false;
    void player.pause();
    $("playBtn").textContent = "播放";
  }
});
$("seek").addEventListener("input", () => {
  player?.seek(Number(($("seek") as HTMLInputElement).value));
});
$("timeline").addEventListener("click", (ev) => {
  if (!movie || !player || mode !== "edit") return;
  const cv = ev.currentTarget as HTMLCanvasElement;
  const rect = cv.getBoundingClientRect();
  const dur = movie.duration / movie.timescale;
  player.seek(((ev.clientX - rect.left) / rect.width) * dur);
});
$("markStart").addEventListener("click", () => {
  if (!player || mode !== "edit") return;
  draftStart = player.playhead();
  renderRanges();
  drawTimeline();
});
$("markEnd").addEventListener("click", () => {
  if (!player || mode !== "edit" || draftStart === null) return;
  const t = player.playhead();
  ranges.push({ start: Math.min(draftStart, t), end: Math.max(draftStart, t) });
  draftStart = null;
  renderRanges();
  drawTimeline();
});
$("genPlan").addEventListener("click", () => void enterReviewMode());
$("exportBtn").addEventListener("click", () => void doExport());
$("backEdit").addEventListener("click", () => enterEditMode());
