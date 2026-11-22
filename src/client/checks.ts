import { activeCueAt, formatTimecode } from "../shared/cues.js";
import { layoutSubtitle } from "../shared/layout.js";
import type {
  Aspect,
  LayoutCheck,
  LayoutStyle,
  PlacementPreference,
  Rect,
  SubjectBox,
  SubtitleCue,
  VideoPreset
} from "../shared/types.js";
import { createCanvas, createMeasure, drawComposite, drawSubtitleLayer, foregroundRect } from "./renderer.js";

export interface CheckRequest {
  preset: VideoPreset;
  style: LayoutStyle;
  cues: SubtitleCue[];
  subjectBox: SubjectBox | null;
  placement: PlacementPreference;
  timeUs: number;
  source?: CanvasImageSource;
  sourceWidth?: number;
  sourceHeight?: number;
}

export interface CheckOutput {
  aspect: Aspect;
  blob: Blob;
  metrics: LayoutCheck;
}

function dashedRect(ctx: OffscreenCanvasRenderingContext2D, rect: Rect, color: string, width = 2, dash: number[] = [10, 8]) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function label(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  size = 18,
  align: CanvasTextAlign = "left"
) {
  ctx.save();
  ctx.font = `600 ${size}px "Noto Sans Mono", "DejaVu Sans Mono", monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(4,9,13,0.82)";
  const metrics = ctx.measureText(text);
  const width = metrics.width + 14;
  const left = align === "right" ? x - width : align === "center" ? x - width / 2 : x;
  ctx.fillRect(left, y - size * 0.8, width, size * 1.6);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawSyntheticScene(ctx: OffscreenCanvasRenderingContext2D, preset: VideoPreset) {
  ctx.fillStyle = "#071019";
  ctx.fillRect(0, 0, preset.width, preset.height);
  const glow = ctx.createRadialGradient(preset.width * 0.66, preset.height * 0.25, 10, preset.width * 0.66, preset.height * 0.25, preset.width * 0.7);
  glow.addColorStop(0, "rgba(41, 101, 128, 0.38)");
  glow.addColorStop(1, "rgba(7, 16, 25, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, preset.width, preset.height);

  ctx.save();
  ctx.strokeStyle = "rgba(132, 180, 196, 0.07)";
  ctx.lineWidth = 1;
  const step = Math.round(preset.width / 16);
  for (let x = 0; x <= preset.width; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, preset.height);
    ctx.stroke();
  }
  for (let y = 0; y <= preset.height; y += Math.round(step * 0.75)) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(preset.width, y);
    ctx.stroke();
  }
  ctx.restore();

  const card = preset.aspect === "16:9"
    ? { x: preset.width * 0.38, y: preset.height * 0.19, width: preset.width * 0.5, height: preset.height * 0.52 }
    : { x: preset.width * 0.18, y: preset.height * 0.16, width: preset.width * 0.64, height: preset.height * 0.25 };
  ctx.save();
  ctx.fillStyle = "rgba(12, 26, 37, 0.62)";
  ctx.strokeStyle = "rgba(130, 182, 197, 0.13)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(card.x, card.y, card.width, card.height, 18);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  const faceX = preset.aspect === "16:9" ? preset.width * 0.22 : preset.width * 0.23;
  const faceY = preset.aspect === "16:9" ? preset.height * 0.48 : preset.height * 0.28;
  const faceR = preset.aspect === "16:9" ? preset.height * 0.075 : preset.width * 0.055;
  ctx.fillStyle = "#c88d5b";
  ctx.beginPath();
  ctx.arc(faceX, faceY, faceR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#233643";
  ctx.beginPath();
  ctx.arc(faceX - faceR * 0.12, faceY - faceR * 1.04, faceR * 0.74, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(faceX, faceY + faceR * 2.1, faceR * 1.8, faceR * 1.65, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#f4bd54";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(faceX - faceR * 1.2, faceY + faceR * 2.35);
  ctx.lineTo(faceX + faceR * 1.2, faceY + faceR * 2.35);
  ctx.stroke();

  ctx.save();
  ctx.fillStyle = "#f2efe6";
  ctx.font = `700 ${preset.aspect === "16:9" ? 62 : 42}px "Noto Sans CJK SC", sans-serif`;
  ctx.fillText("把复杂问题拆成", card.x + card.width * 0.12, card.y + card.height * 0.34);
  ctx.fillText("可验证的步骤", card.x + card.width * 0.12, card.y + card.height * 0.34 + (preset.aspect === "16:9" ? 90 : 60));
  ctx.fillStyle = "#e9b55a";
  ctx.font = `500 ${preset.aspect === "16:9" ? 24 : 18}px "Noto Sans Mono", monospace`;
  ctx.fillText("SECTION 04  /  EVIDENCE", card.x + card.width * 0.12, card.y + card.height * 0.12);
  ctx.restore();
}

function margins(rect: Rect, preset: VideoPreset) {
  return {
    top: Math.round(rect.y),
    right: Math.round(preset.width - rect.x - rect.width),
    bottom: Math.round(preset.height - rect.y - rect.height),
    left: Math.round(rect.x)
  };
}

export async function renderLayoutCheck(request: CheckRequest): Promise<CheckOutput> {
  const { preset, style, cues, subjectBox, placement, timeUs } = request;
  const canvas = createCanvas(preset.width, preset.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D 不可用");
  const measure = createMeasure(ctx, style);
  const cue = activeCueAt(cues, timeUs);
  const layout = layoutSubtitle({ preset, style, subjectBox, placement, timeUs, cue }, measure);
  const subtitleCanvas = createCanvas(preset.width, preset.height);
  const subtitleCtx = subtitleCanvas.getContext("2d");
  if (!subtitleCtx) throw new Error("Canvas 2D 不可用");
  drawSubtitleLayer(subtitleCtx, layout, style, preset);

  if (request.source && request.sourceWidth && request.sourceHeight) {
    drawComposite(ctx, request.source, request.sourceWidth, request.sourceHeight, subtitleCanvas, preset);
  } else {
    drawSyntheticScene(ctx, preset);
    ctx.drawImage(subtitleCanvas, 0, 0);
  }

  ctx.save();
  ctx.fillStyle = "rgba(3, 8, 12, 0.56)";
  ctx.fillRect(0, 0, preset.width, preset.height);
  ctx.restore();

  dashedRect(ctx, preset.safe, "rgba(94, 214, 170, 0.95)", 2.5, [14, 10]);
  dashedRect(ctx, layout.backgroundBox, "rgba(94, 200, 236, 0.95)", 2, [8, 7]);
  if (subjectBox) {
    const subject: Rect = {
      x: subjectBox.x * preset.width,
      y: subjectBox.y * preset.height,
      width: subjectBox.width * preset.width,
      height: subjectBox.height * preset.height
    };
    dashedRect(ctx, subject, "rgba(242, 143, 64, 0.95)", 2, [10, 7]);
    label(ctx, "SUBJECT 主体避让区", subject.x + 10, subject.y + 24, "#f28f40", 16);
  }
  if (preset.aspect === "9:16") {
    dashedRect(ctx, foregroundRect(preset), "rgba(124, 207, 255, 0.35)", 1.5, [5, 7]);
    label(ctx, "FOREGROUND  FORMAT FIT", 24, foregroundRect(preset).y - 20, "#7ccfff", 15);
  }

  const darkBand = ctx.createLinearGradient(0, 0, 0, 130);
  darkBand.addColorStop(0, "rgba(3,7,11,0.95)");
  darkBand.addColorStop(1, "rgba(3,7,11,0)");
  ctx.fillStyle = darkBand;
  ctx.fillRect(0, 0, preset.width, 130);
  label(ctx, `LAYOUT CHECK  ${preset.aspect}  ${preset.width} × ${preset.height}`, 34, 36, "#f4bd54", 20);
  label(ctx, `SAFE ${(preset.safe.x / preset.width * 100).toFixed(1)}%  /  FONT ${layout.fontSize}px  /  LINES ${layout.lines.length}`, preset.width - 34, 36, "#9fd7c4", 16, "right");
  label(ctx, `FRAME ${formatTimecode(timeUs, true)}  ·  ${cue?.id ?? "NO CUE"}`, preset.width - 34, 72, "#cbd5d8", 15, "right");
  label(ctx, `TEXT ${Math.round(layout.textBox.width)} × ${Math.round(layout.textBox.height)}  /  ${layout.placement.toUpperCase()}`, 34, 72, "#7ccfff", 15);
  label(ctx, `TOP ${margins(layout.backgroundBox, preset).top}px   BOTTOM ${margins(layout.backgroundBox, preset).bottom}px`, preset.width / 2, preset.height - 32, "#9fd7c4", 15, "center");
  label(ctx, "SAFE AREA", preset.safe.x, preset.safe.y - 22, "#5ed6aa", 14);
  label(ctx, "TEXT BOX", layout.backgroundBox.x, layout.backgroundBox.y - 18, "#5ec8ec", 14);

  const metrics: LayoutCheck = {
    aspect: preset.aspect,
    width: preset.width,
    height: preset.height,
    safe: preset.safe,
    subject: subjectBox,
    textBox: layout.textBox,
    backgroundBox: layout.backgroundBox,
    fontSize: layout.fontSize,
    lineCount: layout.lines.length,
    lineWidths: layout.lines.map((line) => Math.round(line.width)),
    lineCharacters: layout.lines.map((line) => [...line.text].length),
    placement: layout.placement,
    margins: margins(layout.backgroundBox, preset),
    insideSafeArea:
      layout.backgroundBox.x >= preset.safe.x &&
      layout.backgroundBox.y >= preset.safe.y &&
      layout.backgroundBox.x + layout.backgroundBox.width <= preset.safe.x + preset.safe.width + 0.5 &&
      layout.backgroundBox.y + layout.backgroundBox.height <= preset.safe.y + preset.safe.height + 0.5,
    subjectOverlap: layout.subjectOverlap,
    frameTime: timeUs / 1_000_000,
    frameIndex: Math.round((timeUs / 1_000_000) * 30)
  };
  return { aspect: preset.aspect, blob: await canvas.convertToBlob({ type: "image/png" }), metrics };
}
