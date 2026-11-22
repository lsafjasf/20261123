import type { SegmentDescriptor } from "./types.js";

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface FrameOptions {
  segment: SegmentDescriptor;
  segmentIndex: number;
  segmentCount: number;
  localMs: number;
  accent: string;
}

const WIDTH = 960;
const HEIGHT = 540;
const FONT = '"Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "Ubuntu Sans", sans-serif';
const MONO = '"DejaVu Sans Mono", "Noto Sans Mono", monospace';

function roundRectPath(ctx: Canvas2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function alphaColor(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function drawBackground(ctx: Canvas2D, accent: string, localMs: number): void {
  const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  background.addColorStop(0, "#07111f");
  background.addColorStop(0.58, "#0a1628");
  background.addColorStop(1, "#101b2f");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const glow = ctx.createRadialGradient(790, 90, 0, 790, 90, 370);
  glow.addColorStop(0, alphaColor(accent, 0.22));
  glow.addColorStop(0.55, alphaColor(accent, 0.06));
  glow.addColorStop(1, alphaColor(accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.strokeStyle = "rgba(148, 184, 220, 0.055)";
  ctx.lineWidth = 1;
  for (let x = 40; x < WIDTH; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, HEIGHT);
    ctx.stroke();
  }
  for (let y = 40; y < HEIGHT; y += 48) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WIDTH, y);
    ctx.stroke();
  }

  const scanY = 82 + ((localMs * 0.075) % 410);
  const scan = ctx.createLinearGradient(0, scanY, WIDTH, scanY);
  scan.addColorStop(0, alphaColor(accent, 0));
  scan.addColorStop(0.5, alphaColor(accent, 0.18));
  scan.addColorStop(1, alphaColor(accent, 0));
  ctx.fillStyle = scan;
  ctx.fillRect(0, scanY, WIDTH, 1);
}

function drawChrome(ctx: Canvas2D, segment: SegmentDescriptor, count: number, accent: string): void {
  ctx.fillStyle = accent;
  roundRectPath(ctx, 54, 38, 34, 34, 10);
  ctx.fill();
  ctx.fillStyle = "#07111f";
  ctx.font = `800 18px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText("N", 71, 61);

  ctx.textAlign = "left";
  ctx.fillStyle = "#dbeafe";
  ctx.font = `700 14px ${MONO}`;
  ctx.fillText("NIMBUS / OFFLINE ACADEMY", 102, 60);

  ctx.fillStyle = "rgba(219, 234, 254, 0.48)";
  ctx.font = `500 12px ${MONO}`;
  ctx.fillText("CONTROLLED PLAYBACK", 102, 78);

  const badge = `SEGMENT ${String(segment.ordinal).padStart(2, "0")} / ${String(count).padStart(2, "0")}`;
  ctx.font = `600 12px ${MONO}`;
  const badgeWidth = ctx.measureText(badge).width + 26;
  ctx.strokeStyle = alphaColor(accent, 0.5);
  ctx.fillStyle = alphaColor(accent, 0.09);
  roundRectPath(ctx, WIDTH - 54 - badgeWidth, 44, badgeWidth, 28, 14);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.textAlign = "center";
  ctx.fillText(badge, WIDTH - 54 - badgeWidth / 2, 62);
}

function drawMetric(ctx: Canvas2D, segment: SegmentDescriptor, accent: string, localMs: number): void {
  const x = 690;
  const y = 138;
  const size = 214;
  const pulse = 0.5 + Math.sin(localMs / 280) * 0.5;
  ctx.strokeStyle = alphaColor(accent, 0.22);
  ctx.lineWidth = 1;
  roundRectPath(ctx, x, y, size, size, 24);
  ctx.stroke();

  ctx.fillStyle = alphaColor(accent, 0.06);
  roundRectPath(ctx, x + 1, y + 1, size - 2, size - 2, 23);
  ctx.fill();

  ctx.strokeStyle = alphaColor(accent, 0.3 + pulse * 0.45);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + 94, 68, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ((localMs % 4000) / 4000));
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.fillStyle = accent;
  ctx.font = `700 42px ${MONO}`;
  ctx.fillText(segment.visual.metric, x + size / 2, y + 110);
  ctx.fillStyle = "rgba(219, 234, 254, 0.58)";
  ctx.font = `500 11px ${MONO}`;
  ctx.fillText(segment.visual.metricLabel, x + size / 2, y + 138);

  for (let index = 0; index < 15; index += 1) {
    const amplitude = 7 + Math.abs(Math.sin(localMs / 170 + index * 0.8)) * 18;
    ctx.fillStyle = alphaColor(accent, 0.28 + index * 0.025);
    ctx.fillRect(x + 44 + index * 8.5, y + 177 - amplitude / 2, 4, amplitude);
  }
}

function drawCopy(ctx: Canvas2D, segment: SegmentDescriptor, accent: string, localMs: number): void {
  ctx.textAlign = "left";
  ctx.fillStyle = accent;
  ctx.font = `600 12px ${MONO}`;
  ctx.fillText(segment.visual.kicker, 58, 132);
  ctx.fillStyle = "rgba(219, 234, 254, 0.52)";
  ctx.fillText(segment.chapter, 58, 153);

  ctx.fillStyle = "#f3f7fb";
  ctx.font = `700 43px ${FONT}`;
  ctx.fillText(segment.title, 56, 205);

  ctx.fillStyle = "rgba(203, 221, 239, 0.72)";
  ctx.font = `400 17px ${FONT}`;
  ctx.fillText(segment.summary, 58, 242);

  segment.visual.bullets.forEach((bullet, index) => {
    const reveal = Math.min(1, Math.max(0, (localMs - 420 - index * 500) / 280));
    if (reveal <= 0) {
      return;
    }
    const rowY = 294 + index * 42;
    ctx.globalAlpha = reveal;
    ctx.fillStyle = alphaColor(accent, 0.15);
    roundRectPath(ctx, 58, rowY - 17, 386, 31, 9);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(75, rowY - 1, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#d6e3f1";
    ctx.font = `500 15px ${FONT}`;
    ctx.fillText(bullet, 90, rowY + 4);
    ctx.globalAlpha = 1;
  });

  if (segment.rotation === "rotated") {
    const blink = 0.55 + Math.sin(localMs / 180) * 0.35;
    ctx.fillStyle = alphaColor(accent, 0.12 * blink + 0.08);
    roundRectPath(ctx, 58, 420, 212, 31, 15);
    ctx.fill();
    ctx.strokeStyle = alphaColor(accent, 0.45);
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.font = `600 11px ${MONO}`;
    ctx.fillText("KEY ROTATION · EPOCH 02", 72, 440);
  }
}

function drawTimeline(ctx: Canvas2D, segment: SegmentDescriptor, count: number, localMs: number, accent: string): void {
  const startX = 58;
  const available = 844;
  const gap = 7;
  const blockWidth = (available - gap * (count - 1)) / count;
  const progress = Math.min(1, localMs / segment.durationMs);
  for (let index = 0; index < count; index += 1) {
    const x = startX + index * (blockWidth + gap);
    ctx.fillStyle = index < segment.ordinal - 1 ? "rgba(148, 184, 220, 0.32)" : "rgba(148, 184, 220, 0.12)";
    roundRectPath(ctx, x, 493, blockWidth, 5, 3);
    ctx.fill();
    if (index === segment.ordinal - 1) {
      ctx.fillStyle = accent;
      roundRectPath(ctx, x, 493, blockWidth * progress, 5, 3);
      ctx.fill();
    }
  }
  ctx.fillStyle = "rgba(219, 234, 254, 0.42)";
  ctx.font = `500 10px ${MONO}`;
  ctx.textAlign = "left";
  ctx.fillText("WALL-CLOCK LICENSE", 58, 520);
  ctx.textAlign = "right";
  ctx.fillText(`${(localMs / 1000).toFixed(1)}s / ${(segment.durationMs / 1000).toFixed(1)}s`, 902, 520);
}

export function drawTrainingFrame(
  context: Canvas2D,
  options: FrameOptions,
): void {
  const { segment, segmentIndex, segmentCount, localMs, accent } = options;
  context.save();
  context.clearRect(0, 0, WIDTH, HEIGHT);
  drawBackground(context, accent, localMs + segmentIndex * 800);
  drawChrome(context, segment, segmentCount, accent);
  drawCopy(context, segment, accent, localMs);
  drawMetric(context, segment, accent, localMs);
  drawTimeline(context, segment, segmentCount, localMs, accent);
  context.restore();
}

export const VIDEO_WIDTH = WIDTH;
export const VIDEO_HEIGHT = HEIGHT;
