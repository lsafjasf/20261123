// Entry point: wires loading, analysis, views, comp engine, project I/O.

import { buildPlan, renderPlan, provenance } from "../shared/comp.ts";
import { state, toProject, applyProject } from "./state.ts";
import { decodeAll, analyze, type NamedAudio } from "./analysis.ts";
import { GridView } from "./gridview.ts";
import { DetailView } from "./detailview.ts";
import { CompView } from "./compview.ts";
import { playRange, stopAll, isPlaying } from "./player.ts";
import { exportWav, exportAacDownload, auditionEncoded, exportAac } from "./exporter.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const statusEl = $("status");
const setStatus = (msg: string) => {
  statusEl.textContent = msg;
};

const grid = new GridView($("grid"), {
  onSelect: (s, t) => {
    state.selectedSentence = s;
    selectTake(s, t);
  },
  onHover: setStatus,
});
const detail = new DetailView($("detail"));
const comp = new CompView($("comp"), {
  onSeek: (sec) => {
    if (!state.compPcm) return;
    playRange(state.compPcm, state.sampleRate, sec, state.plan!.duration, (t) => comp.setPlayhead(t));
  },
});

function renderAll(): void {
  grid.render();
  detail.render();
  comp.render();
}

// Rebuild the comp from the current choices. Deterministic: changing one
// sentence's take only re-renders that segment ± one fade — everything else
// stays sample-identical (covered by test/comp.test.ts).
function rebuildComp(): void {
  if (state.segs.length === 0) return;
  state.plan = buildPlan(state.segs, state.aligned, state.refTake, state.choices, state.sampleRate, {
    fadeMs: state.fadeMs,
  });
  state.compPcm = renderPlan(state.pcm, state.plan);
}

function selectTake(sentence: number, take: number): void {
  state.choices[sentence] = take;
  rebuildComp();
  renderAll();
  // Audition the sentence from the chosen take, with breath handles.
  const srcIdx = state.aligned[take][sentence];
  if (srcIdx >= 0) {
    const seg = state.segs[take];
    playRange(state.pcm[take], state.sampleRate, seg.cutPoints[srcIdx], seg.cutPoints[srcIdx + 1]);
  }
  const m = state.metrics[take]?.[sentence];
  if (m) {
    setStatus(
      `S${sentence + 1} ← ${state.takeNames[take]} · 节奏 ${(m.rhythm * 100).toFixed(0)}% · ` +
        `噪声 ${m.noiseDb.toFixed(0)}dB · 情绪差 ${m.emotionDist.toFixed(2)}`,
    );
  }
}

async function loadTakes(files: NamedAudio[]): Promise<void> {
  if (files.length === 0) {
    setStatus("没有找到音频文件。");
    return;
  }
  setStatus("解码中…");
  await decodeAll(files, setStatus);
  await analyze(setStatus);
  rebuildComp();
  refreshRefSelect();
  enableButtons(true);
  renderAll();
  const prov = provenance(state.plan!)
    .map((p) => `S${p.sentence + 1}→T${p.take + 1}`)
    .join(" ");
  setStatus(`分析完成：${state.takeNames.length} 个 take × ${state.choices.length} 句。默认全部用参考 take：${prov}`);
}

function refreshRefSelect(): void {
  const sel = $("sel-ref") as HTMLSelectElement;
  sel.innerHTML = "";
  state.takeNames.forEach((n, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = n;
    sel.appendChild(opt);
  });
  sel.value = String(state.refTake);
}

function enableButtons(on: boolean): void {
  for (const id of ["btn-play-comp", "btn-stop", "btn-save", "btn-loadproj", "btn-export-wav", "btn-export-aac"]) {
    ($(id) as HTMLButtonElement).disabled = !on;
  }
}

// --- UI wiring ---

$("btn-load").addEventListener("click", async () => {
  try {
    const names: string[] = await (await fetch("/api/takes")).json();
    if (names.length === 0) {
      setStatus("takes/ 目录为空。放入音频文件，或改用「打开本地文件」。");
      return;
    }
    const files: NamedAudio[] = [];
    for (const n of names) {
      setStatus(`读取 ${n}…`);
      files.push({ name: n, data: await (await fetch(`/api/takes/${encodeURIComponent(n)}`)).arrayBuffer() });
    }
    await loadTakes(files);
  } catch (err) {
    setStatus(`加载失败：${err}`);
  }
});

$("file-input").addEventListener("change", async (ev) => {
  const list = (ev.target as HTMLInputElement).files;
  if (!list || list.length === 0) return;
  const files: NamedAudio[] = [];
  for (const f of Array.from(list).sort((a, b) => a.name.localeCompare(b.name))) {
    files.push({ name: f.name, data: await f.arrayBuffer() });
  }
  await loadTakes(files);
});

$("sel-ref").addEventListener("change", async () => {
  state.refTake = Number(($("sel-ref") as HTMLSelectElement).value);
  setStatus("参考 take 已更改，重新分析…");
  await analyze(setStatus);
  rebuildComp();
  renderAll();
  setStatus("已按新参考 take 重建时间线。");
});

$("inp-fade").addEventListener("change", () => {
  const v = Number(($("inp-fade") as HTMLInputElement).value);
  state.fadeMs = Math.max(2, Math.min(60, v || 12));
  ($("inp-fade") as HTMLInputElement).value = String(state.fadeMs);
  rebuildComp();
  comp.render();
  setStatus(`交叉淡化 ${state.fadeMs} ms。`);
});

$("btn-play-comp").addEventListener("click", () => {
  if (!state.compPcm || !state.plan) return;
  playRange(state.compPcm, state.sampleRate, 0, state.plan.duration, (t) => comp.setPlayhead(t));
});

$("btn-stop").addEventListener("click", () => {
  stopAll();
  comp.setPlayhead(-1);
});

$("btn-save").addEventListener("click", async () => {
  const proj = toProject();
  try {
    await fetch("/api/project", { method: "POST", body: JSON.stringify(proj, null, 2) });
    setStatus("工程已保存到 project.json（含每句来源 take 与淡化参数）。");
  } catch {
    // Offline without server: fall back to file download.
    const blob = new Blob([JSON.stringify(proj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "project.json";
    a.click();
    setStatus("服务器不可用，工程已下载为 project.json。");
  }
});

$("btn-loadproj").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/project");
    if (!res.ok) throw new Error("没有已保存的工程");
    const proj = await res.json();
    // Reference take must be set before re-analysis; choices are applied
    // after, because analyze() resets them to the reference take.
    state.refTake = Math.min(proj.refTake ?? 0, Math.max(0, state.takeNames.length - 1));
    state.fadeMs = proj.fadeMs ?? 12;
    await analyze(setStatus);
    const warnings = applyProject(proj);
    ($("sel-ref") as HTMLSelectElement).value = String(state.refTake);
    ($("inp-fade") as HTMLInputElement).value = String(state.fadeMs);
    rebuildComp();
    renderAll();
    setStatus(warnings.length ? warnings.join(" ") : "工程已读取，选择已恢复。");
  } catch (err) {
    setStatus(`读取失败：${err}`);
  }
});

$("btn-export-wav").addEventListener("click", () => {
  if (state.compPcm) exportWav(state.compPcm, state.sampleRate);
});

$("btn-export-aac").addEventListener("click", async () => {
  if (!state.compPcm) return;
  setStatus("AAC 编码中（WebCodecs）…");
  try {
    const blob = await exportAac(state.compPcm, state.sampleRate);
    exportAacDownload(blob);
    auditionEncoded(blob, "audio/aac"); // MediaSource 试听编码结果
    setStatus("AAC 已导出并开始试听（MediaSource）。");
  } catch (err) {
    setStatus(`AAC 导出失败：${err}`);
  }
});

// Spacebar: play/stop the comp.
window.addEventListener("keydown", (ev) => {
  if (ev.code !== "Space" || (ev.target as HTMLElement).tagName === "INPUT") return;
  ev.preventDefault();
  if (!state.compPcm || !state.plan) return;
  if (isPlaying()) {
    stopAll();
    comp.setPlayhead(-1);
  } else {
    playRange(state.compPcm, state.sampleRate, 0, state.plan.duration, (t) => comp.setPlayhead(t));
  }
});

renderAll();
