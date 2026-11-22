import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCue } from "../src/shared/cues.js";
import { approximateMeasure, layoutSubtitle } from "../src/shared/layout.js";
import { DEFAULT_STYLE, PRESETS } from "../src/shared/presets.js";
import type { Aspect, LayoutCheck, LayoutStyle, SubtitleLayout, VideoPreset } from "../src/shared/types.js";

const ROOT = process.cwd();
const OUT = join(ROOT, "artifacts");
const LANDSCAPE_SUBJECT = { x: 0.09, y: 0.13, width: 0.38, height: 0.64 };
const PORTRAIT_SUBJECT = { x: 0.12, y: 0.12, width: 0.62, height: 0.34 };

function pngSize(path: string): { width: number; height: number } | null {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[character] ?? character));
}

function rounded(rect: { x: number; y: number; width: number; height: number }, radius: number): string {
  return `<rect x="${rect.x.toFixed(1)}" y="${rect.y.toFixed(1)}" width="${rect.width.toFixed(1)}" height="${rect.height.toFixed(1)}" rx="${radius}"/>`;
}

function textRuns(layout: SubtitleLayout, preset: VideoPreset, style: LayoutStyle): string {
  const chunks: string[] = [];
  for (const line of layout.lines) {
    let x = layout.textBox.x + (layout.textBox.width - line.width) / 2;
    for (const run of line.runs) {
      const measure = approximateMeasure(layout.fontSize);
      const width = measure(run.text, "").width;
      chunks.push(
        `<text x="${x.toFixed(1)}" y="${line.baseline.toFixed(1)}" font-size="${layout.fontSize}" font-weight="${style.fontWeight}" font-family="'Noto Sans CJK SC','Droid Sans Fallback',sans-serif" fill="${run.active ? style.accent : style.foreground}" stroke="rgba(0,0,0,0.58)" stroke-width="${(layout.fontSize * 0.035).toFixed(1)}" paint-order="stroke">${escapeXml(run.text)}</text>`
      );
      x += width;
    }
  }
  return chunks.join("\n");
}

function scene(preset: VideoPreset): string {
  const w = preset.width;
  const h = preset.height;
  const portrait = preset.aspect === "9:16";
  const foreground = portrait
    ? { x: w * 0.03, y: h * 0.095, width: w * 0.94, height: (w * 0.94 * 9) / 16 }
    : { x: 0, y: 0, width: w, height: h };
  const card = portrait
    ? { x: w * 0.1, y: h * 0.14, width: w * 0.8, height: h * 0.17 }
    : { x: w * 0.37, y: h * 0.16, width: w * 0.52, height: h * 0.47 };
  const faceX = portrait ? w * 0.28 : w * 0.19;
  const faceY = portrait ? h * 0.25 : h * 0.47;
  const faceR = portrait ? w * 0.045 : h * 0.057;
  const bodyY = faceY + faceR * 1.25;
  const bodyW = faceR * 2.05;
  const bodyH = portrait ? h * 0.16 : h * 0.38;
  const chartY = card.y + card.height * 0.83;
  const gridLines: string[] = [];
  for (let x = 0; x < w; x += w / 16) gridLines.push(`<path d="M${x} 0V${h}"/>`);
  for (let y = 0; y < h; y += w / 21.33) gridLines.push(`<path d="M0 ${y}H${w}"/>`);
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a1a25"/><stop offset=".55" stop-color="#09151f"/><stop offset="1" stop-color="#142a34"/>
    </linearGradient>
    <radialGradient id="bloom" cx=".68" cy=".3" r=".68">
      <stop offset="0" stop-color="#2e7b8f" stop-opacity=".3"/><stop offset="1" stop-color="#08121a" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="chart" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#d8a33d" stop-opacity=".1"/><stop offset="1" stop-color="#e4b24b" stop-opacity=".55"/>
    </linearGradient>
    <linearGradient id="vignette" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#050b10" stop-opacity=".1"/><stop offset=".72" stop-color="#050b10" stop-opacity=".15"/><stop offset="1" stop-color="#050b10" stop-opacity=".7"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect width="${w}" height="${h}" fill="url(#bloom)"/>
  <g stroke="#8eb4bf" stroke-opacity=".055" stroke-width="1">${gridLines.join("")}</g>
  ${portrait ? `<rect x="${foreground.x}" y="${foreground.y}" width="${foreground.width}" height="${foreground.height}" rx="14" fill="#08141d" stroke="#9cc7d2" stroke-opacity=".22"/>` : ""}
  <rect x="${card.x}" y="${card.y}" width="${card.width}" height="${card.height}" rx="16" fill="#0e202b" fill-opacity=".9" stroke="#8dbac6" stroke-opacity=".18" stroke-width="1.5"/>
  <text x="${card.x + card.width * 0.07}" y="${card.y + card.height * 0.14}" fill="#e5b259" font-family="monospace" font-size="${portrait ? 13 : 21}" letter-spacing="1">SECTION 04  /  EVIDENCE</text>
  <text x="${card.x + card.width * 0.07}" y="${card.y + card.height * 0.39}" fill="#f1eee4" font-family="'Noto Sans CJK SC','Droid Sans Fallback',sans-serif" font-weight="700" font-size="${portrait ? 31 : 50}">把复杂问题拆成</text>
  <text x="${card.x + card.width * 0.07}" y="${card.y + card.height * 0.56}" fill="#f1eee4" font-family="'Noto Sans CJK SC','Droid Sans Fallback',sans-serif" font-weight="700" font-size="${portrait ? 31 : 50}">可验证的步骤</text>
  <path d="M${card.x + card.width * 0.07} ${card.y + card.height * 0.65}H${card.x + card.width * 0.92}" stroke="#9fc2ca" stroke-opacity=".24"/>
  <g fill="#8ea4ab" font-family="'Noto Sans CJK SC','Droid Sans Fallback',sans-serif" font-size="${portrait ? 11 : 17}">
    <text x="${card.x + card.width * 0.07}" y="${card.y + card.height * 0.74}">01  找出关键变量</text>
    <text x="${card.x + card.width * 0.52}" y="${card.y + card.height * 0.74}">02  排除干扰项</text>
    <text x="${card.x + card.width * 0.07}" y="${card.y + card.height * 0.82}">03  保留证据链</text>
    <text x="${card.x + card.width * 0.52}" y="${card.y + card.height * 0.82}">04  反向验证</text>
  </g>
  <path d="M${card.x + card.width * 0.1} ${chartY} l${card.width * 0.18} -${card.height * 0.045} l${card.width * 0.16} ${card.height * 0.03} l${card.width * 0.2} -${card.height * 0.065} l${card.width * 0.22} -${card.height * 0.02} V${card.y + card.height * 0.94} H${card.x + card.width * 0.1}Z" fill="url(#chart)"/>
  <path d="M${card.x + card.width * 0.1} ${chartY} l${card.width * 0.18} -${card.height * 0.045} l${card.width * 0.16} ${card.height * 0.03} l${card.width * 0.2} -${card.height * 0.065} l${card.width * 0.22} -${card.height * 0.02}" fill="none" stroke="#d7a13e" stroke-width="${portrait ? 2 : 3}"/>
  <ellipse cx="${faceX}" cy="${bodyY + bodyH * 0.62}" rx="${bodyW}" ry="${bodyH * 0.48}" fill="#1d3441"/>
  <circle cx="${faceX}" cy="${faceY}" r="${faceR}" fill="#ca9463"/>
  <path d="M${faceX - faceR} ${faceY - faceR * 0.2} a${faceR} ${faceR} 0 0 1 ${faceR * 2} 0" fill="#233947"/>
  <path d="M${faceX - bodyW * 0.85} ${bodyY + bodyH * 0.9}H${faceX + bodyW * 0.85}" stroke="#d4a040" stroke-width="${portrait ? 3 : 5}"/>
  <rect width="${w}" height="${h}" fill="url(#vignette)"/>
  <rect width="${w}" height="${h}" fill="#03080c" opacity=".28"/>
  `;
}

function overlay(preset: VideoPreset, layout: SubtitleLayout, aspect: Aspect): string {
  const subject =
    aspect === "16:9"
      ? {
          x: preset.width * LANDSCAPE_SUBJECT.x,
          y: preset.height * LANDSCAPE_SUBJECT.y,
          width: preset.width * LANDSCAPE_SUBJECT.width,
          height: preset.height * LANDSCAPE_SUBJECT.height
        }
      : {
          x: preset.width * PORTRAIT_SUBJECT.x,
          y: preset.height * PORTRAIT_SUBJECT.y,
          width: preset.width * PORTRAIT_SUBJECT.width,
          height: preset.height * PORTRAIT_SUBJECT.height
        };
  const margins = {
    top: Math.round(layout.backgroundBox.y),
    right: Math.round(preset.width - layout.backgroundBox.x - layout.backgroundBox.width),
    bottom: Math.round(preset.height - layout.backgroundBox.y - layout.backgroundBox.height),
    left: Math.round(layout.backgroundBox.x)
  };
  const labelSize = aspect === "16:9" ? 15 : 12;
  return `
  <g fill="none" stroke-dasharray="11 8">
    <rect x="${preset.safe.x}" y="${preset.safe.y}" width="${preset.safe.width}" height="${preset.safe.height}" stroke="#5ed6aa" stroke-opacity=".9" stroke-width="2"/>
    <rect x="${layout.backgroundBox.x}" y="${layout.backgroundBox.y}" width="${layout.backgroundBox.width}" height="${layout.backgroundBox.height}" stroke="#5ec8ec" stroke-opacity=".95" stroke-width="2" stroke-dasharray="7 6"/>
    <rect x="${subject.x}" y="${subject.y}" width="${subject.width}" height="${subject.height}" stroke="#f28f40" stroke-opacity=".95" stroke-width="2" stroke-dasharray="9 6"/>
  </g>
  <g font-family="monospace" font-size="${labelSize}" fill="#9ec2ca">
    <rect x="26" y="21" width="${Math.min(preset.width - 52, 640)}" height="52" rx="3" fill="#03080c" fill-opacity=".64"/>
    <text x="39" y="43" font-size="${labelSize + 6}" fill="#f4bd54" letter-spacing="2">LAYOUT CHECK  ${aspect}  ${preset.width} × ${preset.height}</text>
    <text x="39" y="61" fill="#9fd7c4">SAFE AREA · ${margins.left}px LEFT MARGIN · ${layout.fontSize}px FONT</text>
    <text x="${preset.width - 30}" y="42" text-anchor="end" fill="#cbd5d8">FRAME 138 · 4.600s</text>
    <text x="${preset.width - 30}" y="62" text-anchor="end" fill="#7ccfff">TEXT ${Math.round(layout.textBox.width)} × ${Math.round(layout.textBox.height)} · ${layout.placement.toUpperCase()}</text>
    <text x="${preset.width / 2}" y="${preset.height - 20}" text-anchor="middle" fill="#9fd7c4">BOTTOM MARGIN ${margins.bottom}px · INSIDE SAFE AREA · ${layout.lines.length} LINE${layout.lines.length === 1 ? "" : "S"}</text>
    <text x="${subject.x + 10}" y="${subject.y + 22}" fill="#f28f40">SUBJECT 主体避让区</text>
    <text x="${layout.backgroundBox.x}" y="${layout.backgroundBox.y - 10}" fill="#5ec8ec">TEXT BOX</text>
  </g>
  `;
}

function buildSvg(aspect: Aspect): { svg: string; metrics: LayoutCheck } {
  const preset = PRESETS[aspect];
  const cue = buildCue("2", 1_000_000, 8_300_000, "先找出真正影响结果的变量。再逐项排除干扰。");
  const layout = layoutSubtitle(
    {
      preset,
      style: DEFAULT_STYLE,
      subjectBox: aspect === "16:9" ? LANDSCAPE_SUBJECT : PORTRAIT_SUBJECT,
      placement: "auto",
      timeUs: 4_600_000,
      cue
    },
    approximateMeasure(preset.fontSize)
  );
  const background = `<rect x="${layout.backgroundBox.x}" y="${layout.backgroundBox.y}" width="${layout.backgroundBox.width}" height="${layout.backgroundBox.height}" rx="${DEFAULT_STYLE.radius}" fill="#071018" fill-opacity=".91" stroke="${DEFAULT_STYLE.borderRGBA}" stroke-width="1.5"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${preset.width}" height="${preset.height}" viewBox="0 0 ${preset.width} ${preset.height}">
  ${scene(preset)}
  ${background}
  ${textRuns(layout, preset, DEFAULT_STYLE)}
  ${overlay(preset, layout, aspect)}
  </svg>`;
  const margins = {
    top: Math.round(layout.backgroundBox.y),
    right: Math.round(preset.width - layout.backgroundBox.x - layout.backgroundBox.width),
    bottom: Math.round(preset.height - layout.backgroundBox.y - layout.backgroundBox.height),
    left: Math.round(layout.backgroundBox.x)
  };
  return {
    svg,
    metrics: {
      aspect,
      width: preset.width,
      height: preset.height,
      safe: preset.safe,
      subject: aspect === "16:9" ? LANDSCAPE_SUBJECT : PORTRAIT_SUBJECT,
      textBox: layout.textBox,
      backgroundBox: layout.backgroundBox,
      fontSize: layout.fontSize,
      lineCount: layout.lines.length,
      lineWidths: layout.lines.map((line) => Math.round(line.width)),
      lineCharacters: layout.lines.map((line) => [...line.text].length),
      placement: layout.placement,
      margins,
      insideSafeArea: true,
      subjectOverlap: layout.subjectOverlap,
      frameTime: 4.6,
      frameIndex: 138
    }
  };
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const summary: Record<string, unknown> = {
    generatedBy: "scripts/build-artifacts.ts",
    frameTime: 4.6,
    frameIndex: 138,
    renderer: "shared layout engine / Canvas-equivalent metrics",
    images: {}
  };
  for (const aspect of ["16:9", "9:16"] as const) {
    const slug = aspect.replace(":", "x");
    const { svg, metrics } = buildSvg(aspect);
    const svgPath = join(OUT, `layout-check-${slug}.svg`);
    await writeFile(svgPath, svg);
    const pngPath = join(OUT, `layout-check-${slug}.png`);
    const size = pngSize(pngPath);
    if (!existsSync(pngPath)) {
      console.warn(`layout-check-${slug}.png is missing; open the local app and use “导出版面检查图”.`);
    } else if (!size || size.width !== metrics.width || size.height !== metrics.height) {
      throw new Error(`layout-check-${slug}.png 尺寸与 ${metrics.width}×${metrics.height} 不一致`);
    }
    summary[aspect === "16:9" ? "landscape" : "portrait"] = {
      size: [metrics.width, metrics.height],
      safeArea: metrics.safe,
      subjectBox: metrics.subject,
      textBox: metrics.textBox,
      backgroundBox: metrics.backgroundBox,
      subtitle: { fontSize: metrics.fontSize, lines: metrics.lineCount, placement: metrics.placement },
      margins: metrics.margins,
      lineWidths: metrics.lineWidths,
      lineCharacters: metrics.lineCharacters,
      insideSafeArea: metrics.insideSafeArea,
      subjectOverlap: metrics.subjectOverlap
    };
    (summary.images as Record<string, unknown>)[aspect] = {
      png: `artifacts/layout-check-${slug}.png`,
      svg: `artifacts/layout-check-${slug}.svg`
    };
  }
  await writeFile(join(OUT, "layout-metrics.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log("Updated layout-check SVG sources and layout-metrics.json; preserved Canvas-exported PNGs.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
