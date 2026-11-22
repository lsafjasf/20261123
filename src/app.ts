// UI 主控：文件选择 → 解码 → 特征 → 检测 → 证据图 + 结果表 + 片段试听。
import { decodeFile } from "./decode.ts";
import type { DecodedAudio } from "./decode.ts";
import { computeFeatures } from "./features.ts";
import type { FeatureSet } from "./features.ts";
import { detectBoundaries } from "./detect.ts";
import type { Boundary } from "./detect.ts";
import { renderEvidence, exportPng } from "./plots.ts";
import { ClipPlayer } from "./player.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>("file");
const sensInput = $<HTMLInputElement>("sensitivity");
const sensLabel = $("sensLabel");
const minVotesSel = $<HTMLSelectElement>("minVotes");
const canvas = $<HTMLCanvasElement>("evidence");
const player = new ClipPlayer();

let decoded: DecodedAudio | null = null;
let features: FeatureSet | null = null;
let hits: Boundary[] = [];

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

function sensName(v: number): string {
  return v < 25 ? "低（少报）" : v < 60 ? "中" : v < 85 ? "高" : "最高（排查用）";
}

function zThreshold(): number {
  return 7 - (Number(sensInput.value) / 100) * 4.5;
}

async function analyze(file: File): Promise<void> {
  $("summary").textContent = "解码中…";
  ["controls", "summary", "tableWrap", "canvasWrap"].forEach((id) => ($(id) as HTMLElement).hidden = false);
  decoded = await decodeFile(file);
  $("summary").textContent =
    `文件：${file.name}\n时长 ${decoded.duration.toFixed(1)}s · ${decoded.sampleRate} Hz · ${decoded.channels} 声道（已混单声道分析）\n特征计算中…`;
  await new Promise((r) => setTimeout(r, 30)); // 让状态先渲染
  features = computeFeatures(decoded.pcm, decoded.sampleRate);
  runDetect();
}

function runDetect(): void {
  if (!decoded || !features) return;
  hits = detectBoundaries(features, {
    sensitivity: Number(sensInput.value),
    minVotes: Number(minVotesSel.value),
  });
  renderTable();
  renderEvidence(canvas, decoded.pcm, decoded.sampleRate, features, hits, zThreshold());
  const high = hits.filter((h) => h.severity === "high" && !h.benign).length;
  const mid = hits.filter((h) => h.severity === "mid" && !h.benign).length;
  const benign = hits.filter((h) => h.benign).length;
  $("summary").textContent =
    `时长 ${decoded.duration.toFixed(1)}s · ${decoded.sampleRate} Hz\n` +
    `可疑边界：高 ${high} · 中 ${mid} · 良性事件（已注明，未判定）${benign}\n` +
    `判定规则：≥${minVotesSel.value} 项独立证据同时超阈（稳健 z ≥ ${zThreshold().toFixed(1)}）`;
}

function renderTable(): void {
  const tbody = $("hits").querySelector("tbody")!;
  tbody.innerHTML = "";
  for (const h of hits) {
    const tr = document.createElement("tr");
    const sevCls = h.benign ? "sev-low" : h.severity === "high" ? "sev-high" : h.severity === "mid" ? "sev-mid" : "sev-low";
    const sevTxt = h.benign ? "良性?" : h.severity === "high" ? "高度可疑" : h.severity === "mid" ? "中度可疑" : "弱";
    const cells = [
      fmtTime(h.time),
      sevTxt,
      h.scores.floor.toFixed(1),
      h.scores.phase.toFixed(1),
      h.scores.jump.toFixed(1),
      h.scores.repeat.toFixed(3),
      h.benign ?? "—",
    ];
    cells.forEach((txt, i) => {
      const td = document.createElement("td");
      td.textContent = txt;
      if (i === 1) td.className = sevCls;
      tr.appendChild(td);
    });
    const td = document.createElement("td");
    const btn = document.createElement("button");
    btn.textContent = "▶ ±2s";
    btn.onclick = () => {
      if (!decoded) return;
      player.play(decoded.pcm, decoded.sampleRate, h.time, 4);
    };
    td.appendChild(btn);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  if (hits.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
    td.textContent = "当前灵敏度下未发现满足多证据条件的边界。";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

fileInput.onchange = () => {
  const f = fileInput.files?.[0];
  if (f) analyze(f).catch((e) => { $("summary").textContent = `解码失败：${e}`; });
};
sensInput.oninput = () => { sensLabel.textContent = sensName(Number(sensInput.value)); };
sensInput.onchange = () => runDetect();
minVotesSel.onchange = () => runDetect();
$("exportBtn").onclick = () => exportPng(canvas, "evidence.png");
sensLabel.textContent = sensName(Number(sensInput.value));
