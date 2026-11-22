import type { LayoutStyle, Rect, SubtitleLayout, VideoPreset } from "../shared/types.js";

export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
export type AnyContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function createCanvas(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(width, height);
}

export function createMeasure(ctx: AnyContext, style: LayoutStyle) {
  return (text: string, font: string) => {
    ctx.font = font;
    return { width: ctx.measureText(text).width };
  };
}

function roundedPath(ctx: AnyContext, rect: Rect, radius: number): void {
  const r = Math.min(radius, rect.width / 2, rect.height / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(rect.x, rect.y, rect.width, rect.height, r);
    return;
  }
  ctx.moveTo(rect.x + r, rect.y);
  ctx.lineTo(rect.x + rect.width - r, rect.y);
  ctx.quadraticCurveTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + r);
  ctx.lineTo(rect.x + rect.width, rect.y + rect.height - r);
  ctx.quadraticCurveTo(rect.x + rect.width, rect.y + rect.height, rect.x + rect.width - r, rect.y + rect.height);
  ctx.lineTo(rect.x + r, rect.y + rect.height);
  ctx.quadraticCurveTo(rect.x, rect.y + rect.height, rect.x, rect.y + rect.height - r);
  ctx.lineTo(rect.x, rect.y + r);
  ctx.quadraticCurveTo(rect.x, rect.y, rect.x + r, rect.y);
  ctx.closePath();
}

function drawBackground(ctx: AnyContext, layout: SubtitleLayout, style: LayoutStyle, preset: VideoPreset): void {
  if (style.background === "none" || !layout.visible) return;
  const rect = layout.backgroundBox;
  ctx.save();
  if (style.background === "outline") {
    roundedPath(ctx, rect, style.radius);
    ctx.lineWidth = Math.max(2, preset.fontSize / 24);
    ctx.strokeStyle = style.borderRGBA;
    ctx.stroke();
    ctx.restore();
    return;
  }

  const gradient = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.height);
  if (style.background === "glass") {
    gradient.addColorStop(0, "rgba(20, 33, 45, 0.68)");
    gradient.addColorStop(0.68, "rgba(9, 17, 26, 0.62)");
    gradient.addColorStop(1, "rgba(9, 17, 26, 0.76)");
  } else {
    gradient.addColorStop(0, style.backgroundRGBA);
    gradient.addColorStop(1, "rgba(5, 9, 14, 0.94)");
  }
  ctx.shadowColor = "rgba(0, 0, 0, 0.42)";
  ctx.shadowBlur = style.shadowBlur;
  ctx.shadowOffsetY = 6;
  roundedPath(ctx, rect, style.radius);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = style.borderRGBA;
  ctx.stroke();

  const shine = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.width, rect.y);
  shine.addColorStop(0, "rgba(255,255,255,0.04)");
  shine.addColorStop(0.45, "rgba(255,255,255,0.10)");
  shine.addColorStop(1, "rgba(255,255,255,0.02)");
  ctx.strokeStyle = shine;
  ctx.lineWidth = 1;
  roundedPath(
    ctx,
    { x: rect.x + 1, y: rect.y + 1, width: rect.width - 2, height: Math.min(rect.height - 2, 2) },
    style.radius
  );
  ctx.stroke();
  ctx.restore();
}

export function drawSubtitleLayer(ctx: AnyContext, layout: SubtitleLayout, style: LayoutStyle, preset: VideoPreset): void {
  ctx.clearRect(0, 0, preset.width, preset.height);
  if (!layout.visible) return;
  drawBackground(ctx, layout, style, preset);

  const font = `${style.fontWeight} ${layout.fontSize}px ${style.fontFamily}`;
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";

  for (let lineIndex = 0; lineIndex < layout.lines.length; lineIndex += 1) {
    const line = layout.lines[lineIndex];
    let x = layout.textBox.x + (layout.textBox.width - line.width) / 2;
    for (const run of line.runs) {
      const runWidth = ctx.measureText(run.text).width;
      ctx.save();
      ctx.font = font;
      ctx.lineJoin = "round";
      if (style.background === "outline" || style.background === "none") {
        ctx.lineWidth = Math.max(5, layout.fontSize * 0.13);
        ctx.strokeStyle = "rgba(0, 0, 0, 0.92)";
        ctx.shadowColor = "rgba(0, 0, 0, 0.86)";
        ctx.shadowBlur = 12;
        ctx.strokeText(run.text, x, line.baseline);
      } else {
        ctx.lineWidth = Math.max(2, layout.fontSize * 0.035);
        ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
        ctx.strokeText(run.text, x, line.baseline);
      }
      ctx.shadowColor = run.active ? "rgba(244, 189, 84, 0.35)" : "transparent";
      ctx.shadowBlur = run.active ? 16 : 0;
      ctx.fillStyle = run.active ? style.accent : style.foreground;
      ctx.fillText(run.text, x, line.baseline);
      ctx.restore();
      x += runWidth;
    }

    if (line.runs.some((run) => run.active) && style.background !== "outline") {
      let activeX = layout.textBox.x + (layout.textBox.width - line.width) / 2;
      let activeWidth = 0;
      for (const run of line.runs) {
        if (run.active) activeWidth += ctx.measureText(run.text).width;
        else if (activeWidth === 0) activeX += ctx.measureText(run.text).width;
      }
      if (activeWidth > 0) {
        const underlineWidth = Math.min(activeWidth, line.width);
        ctx.save();
        ctx.globalAlpha = 0.86;
        ctx.fillStyle = style.accent;
        ctx.beginPath();
        ctx.roundRect(activeX, line.baseline + layout.fontSize * 0.16, underlineWidth, 3, 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }
}

export function renderSubtitleLayer(
  layout: SubtitleLayout,
  style: LayoutStyle,
  preset: VideoPreset
): OffscreenCanvas {
  const canvas = createCanvas(preset.width, preset.height);
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("Canvas 2D 不可用");
  drawSubtitleLayer(ctx, layout, style, preset);
  return canvas;
}

export function foregroundRect(preset: VideoPreset): Rect {
  if (preset.aspect === "16:9") return { x: 0, y: 0, width: preset.width, height: preset.height };
  const width = Math.round(preset.width * 0.94);
  const height = Math.round((width * 9) / 16);
  return { x: Math.round((preset.width - width) / 2), y: Math.round(preset.height * 0.095), width, height };
}

function drawCover(
  ctx: AnyContext,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  rect: Rect
): void {
  const scale = Math.max(rect.width / sourceWidth, rect.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  ctx.drawImage(source, rect.x + (rect.width - width) / 2, rect.y + (rect.height - height) / 2, width, height);
}

function drawContain(
  ctx: AnyContext,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  rect: Rect
): void {
  const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  ctx.drawImage(source, rect.x + (rect.width - width) / 2, rect.y + (rect.height - height) / 2, width, height);
}

export function drawSource(
  ctx: AnyContext,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  preset: VideoPreset
): void {
  ctx.fillStyle = "#05090d";
  ctx.fillRect(0, 0, preset.width, preset.height);

  if (preset.aspect === "16:9") {
    drawContain(ctx, source, sourceWidth, sourceHeight, { x: 0, y: 0, width: preset.width, height: preset.height });
    return;
  }

  ctx.save();
  ctx.filter = "blur(34px) brightness(0.34) saturate(0.72)";
  drawCover(ctx, source, sourceWidth, sourceHeight, { x: -60, y: -60, width: preset.width + 120, height: preset.height + 120 });
  ctx.restore();
  const wash = ctx.createLinearGradient(0, 0, 0, preset.height);
  wash.addColorStop(0, "rgba(5, 10, 16, 0.24)");
  wash.addColorStop(0.55, "rgba(5, 10, 16, 0.50)");
  wash.addColorStop(1, "rgba(5, 10, 16, 0.88)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, preset.width, preset.height);

  const rect = foregroundRect(preset);
  ctx.save();
  roundedPath(ctx, rect, 18);
  ctx.clip();
  drawContain(ctx, source, sourceWidth, sourceHeight, rect);
  ctx.restore();
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth = 1.5;
  roundedPath(ctx, rect, 18);
  ctx.stroke();
}

export function drawComposite(
  ctx: AnyContext,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  subtitle: OffscreenCanvas,
  preset: VideoPreset
): void {
  drawSource(ctx, source, sourceWidth, sourceHeight, preset);
  ctx.drawImage(subtitle, 0, 0);
}
