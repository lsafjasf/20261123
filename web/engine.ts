/**
 * Browser-side verifier for migrated projects. Runs entirely locally:
 * fetches the migration outputs, renders the timeline with Canvas,
 * spot-checks audio durations at sample accuracy with WebAudio, and
 * probes decode capability with WebCodecs and MediaSource. Every API
 * is feature-detected; missing support degrades to a skipped check.
 */

interface ProjectV2 {
  id: string;
  name: string;
  frameRate: { num: number; den: number };
  audioSampleRate: number;
  media: {
    id: string; path: string; kind: string;
    durationFrames?: number; durationSamples?: number; sampleRate?: number;
  }[];
  sequences: {
    id: string; name: string; durationFrames: number; durationSamples: number;
    tracks: {
      id: string; kind: string;
      clips: {
        id: string; mediaId: string; timelineStart: number; duration: number;
        sampleRate?: number;
      }[];
    }[];
  }[];
}

interface Report {
  totals: Record<string, number>;
  durationChecks: {
    sequenceId: string; legacyDurationMs: number; migratedDurationMs: number;
    driftMs: number; toleranceMs: number; withinTolerance: boolean;
  }[];
  quarantined: { sequenceId: string; trackId: string; clipId: string; reason: string }[];
  approximate: { clipId: string; maxAbsErrorMs: number }[];
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function row(cells: string[], cls = ""): string {
  return `<tr class="${cls}">${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function drawTimeline(project: ProjectV2): void {
  const canvas = $("timeline") as unknown as HTMLCanvasElement;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = 220 * devicePixelRatio;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const width = canvas.clientWidth;
  const seq = project.sequences[0];
  if (!seq) return;
  const fps = project.frameRate.num / project.frameRate.den;
  const totalSec = Math.max(
    seq.durationFrames / fps,
    seq.durationSamples / project.audioSampleRate,
    1e-6,
  );
  const laneH = 40;
  ctx.font = "11px system-ui";
  seq.tracks.forEach((track, i) => {
    const y = 20 + i * (laneH + 12);
    ctx.fillStyle = "#555";
    ctx.fillText(`${track.id} (${track.kind})`, 4, y - 4);
    for (const clip of track.clips) {
      const rate = track.kind === "video"
        ? fps
        : (clip.sampleRate ?? project.audioSampleRate);
      const x = (clip.timelineStart / rate / totalSec) * (width - 80) + 70;
      const w = Math.max((clip.duration / rate / totalSec) * (width - 80), 1);
      ctx.fillStyle = track.kind === "video" ? "#3b82f6" : "#22a06b";
      ctx.fillRect(x, y, w, laneH - 10);
      ctx.fillStyle = "#111";
      ctx.fillText(clip.id, x + 3, y + 18);
    }
  });
  ctx.fillStyle = "#888";
  ctx.fillText(`总时长 ${totalSec.toFixed(3)}s`, 4, 14);
}

async function checkAudioDurations(project: ProjectV2): Promise<string[]> {
  const lines: string[] = [];
  const AC = (window as any).AudioContext ?? (window as any).webkitAudioContext;
  if (!AC) return ["WebAudio 不可用，跳过采样级抽查"];
  const ctx = new AC();
  for (const m of project.media.filter((m) => m.kind === "audio")) {
    try {
      const buf = await ctx.decodeAudioData(await (await fetch(`/media/${m.path}`)).arrayBuffer());
      const diff = Math.abs(buf.length - (m.durationSamples ?? 0));
      const ok = diff <= 1;
      lines.push(
        `<span class="${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"}</span> ` +
        `${m.id}: 解码 ${buf.length} 采样 @${buf.sampleRate}Hz，` +
        `工程记录 ${m.durationSamples} 采样（差 ${diff}）`,
      );
    } catch {
      lines.push(`<span class="warn">–</span> ${m.id}: 媒体文件不可读，跳过`);
    }
  }
  await ctx.close();
  return lines;
}

async function probeDecodeCapability(): Promise<string[]> {
  const lines: string[] = [];
  if (typeof (window as any).VideoDecoder !== "undefined") {
    const support = await (window as any).VideoDecoder.isConfigSupported({
      codec: "avc1.42001f", codedWidth: 1920, codedHeight: 1080,
    });
    lines.push(`WebCodecs H.264 解码：${support.supported ? "支持" : "不支持"}`);
  } else {
    lines.push("WebCodecs 不可用（需安全上下文/现代浏览器）");
  }
  if (typeof (window as any).MediaSource !== "undefined") {
    const ok = (window as any).MediaSource.isTypeSupported(
      'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
    );
    lines.push(`MediaSource MP4 回放：${ok ? "支持" : "不支持"}`);
  } else {
    lines.push("MediaSource 不可用");
  }
  return lines;
}

async function main(): Promise<void> {
  const [project, report] = (await Promise.all([
    fetchJson("/output/project.v2.json"),
    fetchJson("/output/report.json"),
  ])) as [ProjectV2, Report];

  drawTimeline(project);

  $("summary").innerHTML =
    `<h2>时长校验</h2><table><tr><th>序列</th><th>旧版 (ms)</th>` +
    `<th>新版 (ms)</th><th>漂移 (ms)</th><th>容差 (ms)</th><th>结论</th></tr>` +
    report.durationChecks
      .map((c) =>
        row(
          [c.sequenceId, c.legacyDurationMs.toFixed(3), c.migratedDurationMs.toFixed(3),
            c.driftMs.toFixed(6), c.toleranceMs.toFixed(6),
            c.withinTolerance ? "✓ 通过" : "✗ 超差"],
          c.withinTolerance ? "ok" : "bad",
        ),
      )
      .join("") +
    `</table><p>迁移 ${report.totals.clipsMigrated} 条，复用缓存 ` +
    `${report.totals.clipsReusedFromCache} 条，近似切点 ` +
    `${report.totals.clipsApproximate} 条，隔离 ${report.totals.clipsQuarantined} 条。</p>`;

  const caps = await probeDecodeCapability();
  const audio = await checkAudioDurations(project);
  $("checks").innerHTML =
    `<h2>环境能力</h2><ul>${caps.map((l) => `<li>${l}</li>`).join("")}</ul>` +
    `<h2>音频采样级抽查（WebAudio）</h2><ul>${audio.map((l) => `<li>${l}</li>`).join("")}</ul>`;

  $("quarantine").innerHTML =
    `<h2>隔离清单（需人工修复）</h2>` +
    (report.quarantined.length === 0
      ? "<p>无</p>"
      : `<table><tr><th>序列</th><th>轨道</th><th>镜头</th><th>原因</th></tr>` +
        report.quarantined
          .map((q) => row([q.sequenceId, q.trackId, q.clipId, q.reason], "warn"))
          .join("") +
        `</table>`);
}

main().catch((err) => {
  $("summary").innerHTML = `<p class="bad">加载失败：${err.message}。先运行
    <code>node src/cli.ts migrate examples/legacy-project.json</code>，
    再 <code>node web/serve.ts</code>。</p>`;
});
