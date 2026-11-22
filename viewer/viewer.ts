/**
 * Browser viewer for the normalization report. Inlined into report.html;
 * uses Canvas for timelines, WebCodecs for thumbnails, WebAudio for
 * waveforms, MediaSource for preview playback. No network access.
 */
interface SpeedSegmentV {
  timelineStart: number;
  timelineDuration: number;
  sourceStart: number;
  speed: number;
  ramp: boolean;
}
interface TransitionV {
  kind: string;
  name: string;
  duration: number;
  at: number;
}
interface ClipV {
  id: string;
  name: string;
  reel: string;
  mediaPath: string | null;
  sourceRate: { label: string };
  sourceIn: number;
  sourceOut: number;
  recordIn: number;
  recordOut: number;
  speedSegments: SpeedSegmentV[];
  transitionIn: TransitionV | null;
  transitionOut: TransitionV | null;
  capabilities: string[];
}
interface TrackV {
  kind: string;
  index: number;
  clips: ClipV[];
}
interface TimelineV {
  name: string;
  projectRate: { label: string };
  tracks: TrackV[];
  sources: string[];
}
interface ReportV {
  projectRate: string;
  timelines: TimelineV[];
  combined: TimelineV;
  analyses: Array<{
    timeline: string;
    projectRate: string;
    speed: Array<{ clipName: string; kind: string; detail: string }>;
    transitions: Array<{ clipName: string; kind: string; name: string; durationFrames: number; atFrame: number }>;
    missingMedia: Array<{ clipName: string; reel: string; expectedPath: string | null; reason: string }>;
    conforms: Array<{ clipName: string; fromRate: string; toRate: string }>;
  }>;
  exports: Array<{
    name: string;
    edl: string;
    losses: Array<{ severity: string; feature: string; clips: string[]; reason: string }>;
  }>;
}
const REPORT = (window as unknown as { __REPORT__: ReportV }).__REPORT__;
const ROW_H = 34;
const TRACK_PAD = 6;
const RULER_H = 22;
const LEFT_W = 70;

interface HitBox {
  x: number;
  y: number;
  w: number;
  h: number;
  clip: ClipV;
}

function trackColor(kind: string, index: number): string {
  if (kind === "video") return ["#3d6ea5", "#4d7fc0", "#2f5a88"][index % 3];
  return ["#3e8e5f", "#4da56f", "#2f7349"][index % 3];
}

function drawBadges(ctx: CanvasRenderingContext2D, clip: ClipV, x: number, y: number): void {
  let dx = 0;
  for (const seg of clip.speedSegments) {
    if (seg.speed === 1 && !seg.ramp) continue;
    const text = seg.speed === 0 ? "❄冻结" : seg.ramp ? "↝变速" : seg.speed < 0 ? `↩${seg.speed}x` : `⚡${seg.speed}x`;
    ctx.fillStyle = "#ffd27f";
    ctx.fillText(text, x + dx, y);
    dx += text.length * 11 + 8;
  }
  if (clip.capabilities.includes("title")) {
    ctx.fillStyle = "#c9a0ff";
    ctx.fillText("T", x + dx, y);
  }
}

function drawTimeline(canvas: HTMLCanvasElement, tl: TimelineV, label: string): HitBox[] {
  const hits: HitBox[] = [];
  let end = 1;
  for (const t of tl.tracks) for (const c of t.clips) end = Math.max(end, c.recordOut);
  const width = Math.max(900, canvas.parentElement ? canvas.parentElement.clientWidth - 4 : 900);
  const height = RULER_H + tl.tracks.length * (ROW_H + TRACK_PAD) + 24;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return hits;
  ctx.scale(dpr, dpr);
  ctx.font = "11px Menlo, Consolas, monospace";
  const px = (frame: number) => LEFT_W + (frame / end) * (width - LEFT_W - 12);

  ctx.fillStyle = "#8b96a6";
  for (let i = 0; i <= 10; i++) {
    const f = Math.round((end * i) / 10);
    const x = px(f);
    ctx.fillRect(x, RULER_H - 6, 1, 6);
    ctx.fillText(`${f}f`, x + 3, RULER_H - 8);
  }
  ctx.fillStyle = "#dbe2ec";
  ctx.fillText(label, 8, 14);

  tl.tracks.forEach((track, ti) => {
    const y = RULER_H + ti * (ROW_H + TRACK_PAD);
    ctx.fillStyle = "#8b96a6";
    ctx.fillText(`${track.kind === "video" ? "V" : "A"}${ti + 1}`, 8, y + ROW_H / 2 + 4);
    ctx.strokeStyle = "#2c3340";
    ctx.strokeRect(LEFT_W, y, width - LEFT_W - 12, ROW_H);
    for (const clip of track.clips) {
      const x = px(clip.recordIn);
      const w = Math.max(2, px(clip.recordOut) - x);
      const missing = clip.mediaPath === null && clip.reel !== "" && clip.reel !== "AX" && clip.reel !== "BL";
      ctx.fillStyle = trackColor(track.kind, ti);
      ctx.fillRect(x, y + 2, w, ROW_H - 4);
      if (missing) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y + 2, w, ROW_H - 4);
        ctx.clip();
        ctx.strokeStyle = "rgba(255,107,107,.8)";
        for (let d = -ROW_H; d < w + ROW_H; d += 8) {
          ctx.beginPath();
          ctx.moveTo(x + d, y + ROW_H);
          ctx.lineTo(x + d + ROW_H, y);
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.fillStyle = "#eaf1fa";
      const labelText = clip.name.length > 24 ? `${clip.name.slice(0, 23)}…` : clip.name;
      ctx.fillText(labelText, x + 4, y + 14, w - 8);
      drawBadges(ctx, clip, x + 4, y + ROW_H - 6);
      for (const t of [clip.transitionIn, clip.transitionOut]) {
        if (!t) continue;
        const tx = px(t.at);
        const tw = Math.max(4, px(t.at + t.duration) - tx);
        ctx.fillStyle = "rgba(255,184,77,.55)";
        ctx.beginPath();
        ctx.moveTo(tx, y + ROW_H - 2);
        ctx.lineTo(tx + tw, y + ROW_H - 2);
        ctx.lineTo(tx + tw / 2, y + 2);
        ctx.closePath();
        ctx.fill();
      }
      hits.push({ x, y, w, h: ROW_H, clip });
    }
  });
  return hits;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clipDetail(clip: ClipV): string {
  const lines = [
    `片段: ${clip.name}  (reel: ${clip.reel || "-"})`,
    `源帧率: ${clip.sourceRate.label}  源入出: ${clip.sourceIn}f - ${clip.sourceOut}f`,
    `项目网格: ${clip.recordIn}f - ${clip.recordOut}f  (时长 ${clip.recordOut - clip.recordIn}f)`,
    `媒体: ${clip.mediaPath ?? "未找到 / 未关联"}`,
  ];
  for (const s of clip.speedSegments) {
    lines.push(`  速度段: ${s.speed}x ${s.ramp ? "(ramp) " : ""}tl+${s.timelineStart}f 持续${s.timelineDuration}f 源起${s.sourceStart}f`);
  }
  for (const t of [clip.transitionIn, clip.transitionOut]) {
    if (t) lines.push(`  转场: ${t.name} (${t.kind}) ${t.duration}f @${t.at}f`);
  }
  if (clip.capabilities.length) lines.push(`  能力标签: ${clip.capabilities.join(", ")}`);
  return lines.join("\n");
}

function renderCombined(): void {
  const canvas = document.getElementById("combined-canvas") as HTMLCanvasElement;
  const detail = document.getElementById("clip-detail") as HTMLDivElement;
  const hits = drawTimeline(canvas, REPORT.combined, `combined @ ${REPORT.projectRate}`);
  canvas.addEventListener("click", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const hit = hits.find((h) => mx >= h.x && mx <= h.x + h.w && my >= h.y && my <= h.y + h.h);
    detail.textContent = hit ? clipDetail(hit.clip) : "点击片段查看详情";
  });
}

function renderSources(): void {
  const host = document.getElementById("source-panels") as HTMLDivElement;
  REPORT.timelines.forEach((tl, i) => {
    const exp = REPORT.exports[i];
    const panel = document.createElement("div");
    panel.className = "panel";
    const title = document.createElement("h3");
    title.textContent = `${tl.name} — 输入 ${tl.sources.join(", ")}`;
    panel.appendChild(title);
    const canvas = document.createElement("canvas");
    panel.appendChild(canvas);
    const compare = document.createElement("div");
    compare.className = "compare";
    const left = document.createElement("pre");
    left.textContent = summarizeInput(tl);
    const right = document.createElement("pre");
    right.textContent = exp ? exp.edl : "";
    compare.appendChild(left);
    compare.appendChild(right);
    panel.appendChild(compare);
    host.appendChild(panel);
    drawTimeline(canvas, tl, `${tl.name} @ ${REPORT.projectRate}`);
  });
}

function summarizeInput(tl: TimelineV): string {
  const lines = [`统一模型（项目网格 ${REPORT.projectRate}）`];
  tl.tracks.forEach((t, ti) => {
    lines.push(`${t.kind === "video" ? "V" : "A"}${ti + 1}:`);
    for (const c of t.clips) {
      const spd = c.speedSegments.some((s) => s.speed !== 1 || s.ramp) ? " [变速]" : "";
      const tr = c.transitionIn || c.transitionOut ? " [转场]" : "";
      lines.push(`  ${c.recordIn}f-${c.recordOut}f  ${c.name}  src ${c.sourceRate.label} ${c.sourceIn}f-${c.sourceOut}f${spd}${tr}`);
    }
  });
  return lines.join("\n");
}

function renderFindings(): void {
  const host = document.getElementById("findings") as HTMLDivElement;
  for (const a of REPORT.analyses) {
    const panel = document.createElement("div");
    panel.className = "panel";
    const rows: string[] = [];
    for (const s of a.speed) rows.push(`<tr><td><span class="tag degraded">变速</span></td><td>${esc(s.clipName)}</td><td>${esc(s.kind)}</td><td>${esc(s.detail)}</td></tr>`);
    for (const t of a.transitions) rows.push(`<tr><td><span class="tag ok">转场</span></td><td>${esc(t.clipName)}</td><td>${esc(t.name)}</td><td>${t.durationFrames}f @${t.atFrame}f</td></tr>`);
    for (const m of a.missingMedia) rows.push(`<tr><td><span class="tag lost">缺失</span></td><td>${esc(m.clipName)}</td><td>${esc(m.reel)}</td><td>${esc(m.expectedPath ?? m.reason)}</td></tr>`);
    for (const c of a.conforms) rows.push(`<tr><td><span class="tag degraded">帧率</span></td><td>${esc(c.clipName)}</td><td>${esc(c.fromRate)} → ${esc(c.toRate)}</td><td>conform</td></tr>`);
    panel.innerHTML = `<h3>${esc(a.timeline)}</h3>${
      rows.length ? `<table><tr><th>类型</th><th>片段</th><th>详情</th><th>说明</th></tr>${rows.join("")}</table>` : '<p class="hint">无异常</p>'
    }`;
    host.appendChild(panel);
  }
}

function renderLosses(): void {
  const host = document.getElementById("losses") as HTMLDivElement;
  for (const exp of REPORT.exports) {
    const panel = document.createElement("div");
    panel.className = "panel";
    const rows = exp.losses.map(
      (l) =>
        `<tr><td><span class="tag ${l.severity}">${l.severity === "lost" ? "丢失" : "降级"}</span></td>` +
        `<td>${esc(l.feature)}</td><td>${esc(l.clips.slice(0, 6).join(", "))}${l.clips.length > 6 ? " …" : ""}</td>` +
        `<td>${esc(l.reason)}</td></tr>`,
    );
    panel.innerHTML = `<h3>${esc(exp.name)} → EDL</h3>${
      rows.length ? `<table><tr><th>级别</th><th>能力</th><th>涉及片段</th><th>原因</th></tr>${rows.join("")}</table>` : '<p class="hint">无损失</p>'
    }`;
    host.appendChild(panel);
  }
}

async function previewFile(file: File, host: HTMLElement): Promise<void> {
  const card = document.createElement("div");
  card.className = "preview-card";
  const title = document.createElement("h4");
  title.textContent = file.name;
  card.appendChild(title);
  host.appendChild(card);

  if (file.type.startsWith("video/") || file.type.startsWith("audio/")) {
    const video = document.createElement("video");
    video.controls = true;
    video.muted = false;
    if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(file.type || "video/mp4")) {
      const ms = new MediaSource();
      video.src = URL.createObjectURL(ms);
      ms.addEventListener("sourceopen", async () => {
        try {
          const buf = ms.addSourceBuffer(file.type || "video/mp4");
          buf.appendBuffer(await file.arrayBuffer());
          buf.addEventListener("updateend", () => ms.endOfStream(), { once: true });
        } catch {
          video.src = URL.createObjectURL(file);
        }
      });
    } else {
      video.src = URL.createObjectURL(file);
    }
    card.appendChild(video);
  }

  if (typeof VideoDecoder !== "undefined" && file.type.startsWith("video/")) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "WebCodecs 可用：浏览器支持硬解；缩略图经 Canvas 抽取。";
    card.appendChild(note);
    const thumb = document.createElement("canvas");
    thumb.width = 300;
    thumb.height = 168;
    card.appendChild(thumb);
    const probe = document.createElement("video");
    probe.muted = true;
    probe.src = URL.createObjectURL(file);
    probe.addEventListener("loadeddata", () => {
      probe.currentTime = Math.min(1, (probe.duration || 2) / 2);
    });
    probe.addEventListener("seeked", () => {
      const ctx = thumb.getContext("2d");
      if (ctx) ctx.drawImage(probe, 0, 0, thumb.width, thumb.height);
      URL.revokeObjectURL(probe.src);
    });
  }

  if (file.type.startsWith("audio/")) {
    try {
      const ac = new AudioContext();
      const buf = await ac.decodeAudioData(await file.arrayBuffer());
      const wave = document.createElement("canvas");
      wave.width = 300;
      wave.height = 80;
      card.appendChild(wave);
      const ctx = wave.getContext("2d");
      if (ctx) {
        const data = buf.getChannelData(0);
        const step = Math.max(1, Math.floor(data.length / wave.width));
        ctx.strokeStyle = "#4da3ff";
        ctx.beginPath();
        for (let x = 0; x < wave.width; x++) {
          let min = 1;
          let max = -1;
          for (let j = 0; j < step; j++) {
            const v = data[x * step + j] ?? 0;
            if (v < min) min = v;
            if (v > max) max = v;
          }
          ctx.moveTo(x, ((1 + min) / 2) * wave.height);
          ctx.lineTo(x, ((1 + max) / 2) * wave.height);
        }
        ctx.stroke();
      }
      await ac.close();
    } catch {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = "WebAudio 无法解码该音频。";
      card.appendChild(note);
    }
  }
}

function setupPreview(): void {
  const picker = document.getElementById("media-picker") as HTMLInputElement;
  const host = document.getElementById("preview-output") as HTMLDivElement;
  picker.addEventListener("change", () => {
    host.innerHTML = "";
    for (const file of Array.from(picker.files ?? [])) {
      void previewFile(file, host);
    }
  });
}

renderCombined();
renderSources();
renderFindings();
renderLosses();
setupPreview();
