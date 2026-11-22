/**
 * Builds the self-contained HTML report: unified timeline vs. per-source
 * views, findings, loss report, and the interactive canvas viewer.
 * The viewer is authored in TypeScript (viewer/viewer.ts) and type-stripped
 * at report-build time using Node's built-in module API - no dependencies.
 */

import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Timeline } from "./core/model.ts";
import type { AnalysisReport } from "./analyze/analyze.ts";
import type { EdlExportResult } from "./export/edl.ts";

export interface ReportData {
  readonly projectRate: string;
  readonly timelines: Timeline[];
  readonly combined: Timeline;
  readonly analyses: AnalysisReport[];
  readonly exports: Array<EdlExportResult & { name: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));

function loadViewerJs(): string {
  const tsPath = join(here, "..", "viewer", "viewer.ts");
  const source = readFileSync(tsPath, "utf8");
  return stripTypeScriptTypes(source, { mode: "strip" });
}

function loadViewerCss(): string {
  return readFileSync(join(here, "..", "viewer", "viewer.css"), "utf8");
}

export function buildReportHtml(data: ReportData): string {
  const js = loadViewerJs();
  const css = loadViewerCss();
  const json = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v)).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Timeline Normalizer Report</title>
<style>
${css}
</style>
</head>
<body>
<header>
  <h1>Timeline Normalizer 对照报告</h1>
  <p>项目帧率: <strong>${data.projectRate}</strong> · 输入 ${data.timelines.length} 个文件 · 全部处理在本机完成</p>
</header>
<main>
  <section id="combined-section">
    <h2>统一逐帧时间线（项目网格）</h2>
    <canvas id="combined-canvas"></canvas>
    <div id="clip-detail" class="detail">点击片段查看详情</div>
  </section>
  <section id="sources-section">
    <h2>输入 / 导出对照</h2>
    <div id="source-panels"></div>
  </section>
  <section id="findings-section">
    <h2>检测结果（变速 / 转场 / 缺失素材 / 帧率转换）</h2>
    <div id="findings"></div>
  </section>
  <section id="loss-section">
    <h2>导回 EDL 将丢失的能力</h2>
    <div id="losses"></div>
  </section>
  <section id="preview-section">
    <h2>素材预览（WebCodecs / WebAudio / MediaSource）</h2>
    <p class="hint">选择本地媒体文件以解码缩略图与波形；文件不离开本机。</p>
    <input type="file" id="media-picker" multiple>
    <div id="preview-output"></div>
  </section>
</main>
<script>
window.__REPORT__ = ${json};
${js}
</script>
</body>
</html>
`;
}
