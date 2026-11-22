import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from "./types.ts";
import type { CropFrame, Project, Shot } from "./types.ts";
import { shotIndexAt } from "./crop.ts";
import { wrapCaption } from "./subtitles.ts";
import type { Any2D } from "./draw-source.ts";

interface PortraitOptions {
  captions?: boolean;
  guides?: boolean;
  timecode?: boolean;
  chrome?: boolean;
}

function rounded(ctx: Any2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCaption(ctx: Any2D, text: string): void {
  const maxWidth = Math.round(OUTPUT_WIDTH * 0.86);
  const lines = wrapCaption(text, 15, 2);
  ctx.font = '700 51px "Droid Sans Fallback", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const widths = lines.map((line) => Math.min(maxWidth - 36, ctx.measureText(line).width));
  const boxW = Math.max(...widths) + 68;
  const lineH = 68;
  const boxH = lines.length * lineH + 30;
  const x = (OUTPUT_WIDTH - boxW) / 2;
  const y = OUTPUT_HEIGHT - 282 - boxH;
  ctx.fillStyle = "rgba(15, 14, 12, .78)";
  rounded(ctx, x, y, boxW, boxH, 18);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 226, 175, .24)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#fff7e8";
  lines.forEach((line, index) => {
    ctx.fillText(line, OUTPUT_WIDTH / 2, y + 39 + index * lineH);
  });
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function drawChrome(
  ctx: Any2D,
  project: Project,
  shot: Shot,
  time: number,
  showTimecode: boolean,
): void {
  const top = ctx.createLinearGradient(0, 0, 0, 270);
  top.addColorStop(0, "rgba(12, 11, 10, .65)");
  top.addColorStop(1, "rgba(12, 11, 10, 0)");
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, OUTPUT_WIDTH, 270);
  const bottom = ctx.createLinearGradient(0, OUTPUT_HEIGHT - 610, 0, OUTPUT_HEIGHT);
  bottom.addColorStop(0, "rgba(9, 9, 8, 0)");
  bottom.addColorStop(1, "rgba(9, 9, 8, .72)");
  ctx.fillStyle = bottom;
  ctx.fillRect(0, OUTPUT_HEIGHT - 610, OUTPUT_WIDTH, 610);

  ctx.fillStyle = "rgba(16, 15, 13, .68)";
  rounded(ctx, 40, 42, 468, 70, 35);
  ctx.fill();
  ctx.fillStyle = "#f2a652";
  ctx.beginPath();
  ctx.arc(76, 77, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 247, 231, .92)";
  ctx.font = '600 24px "Droid Sans Fallback", sans-serif';
  ctx.fillText(`${shot.speaker}  /  ${shot.role}`, 100, 86);

  if (showTimecode) {
    ctx.fillStyle = "rgba(255, 247, 231, .6)";
    ctx.font = '500 20px "Droid Sans Mono", monospace';
    const current = `${Math.floor(time / 60).toString().padStart(2, "0")}:${(time % 60).toFixed(2).padStart(5, "0")}`;
    ctx.fillText(current, OUTPUT_WIDTH - 154, 82);
  }

  ctx.fillStyle = "rgba(255, 247, 231, .36)";
  ctx.font = '500 18px "Droid Sans Fallback", sans-serif';
  ctx.fillText("PORTRAIT  9:16  ·  OFFLINE MASTER", 42, OUTPUT_HEIGHT - 58);
  ctx.textAlign = "right";
  ctx.fillText(project.title, OUTPUT_WIDTH - 42, OUTPUT_HEIGHT - 58);
  ctx.textAlign = "left";
}

function drawGuides(ctx: Any2D, frame: CropFrame, shot: Shot): void {
  ctx.save();
  ctx.strokeStyle = "rgba(241, 168, 84, .86)";
  ctx.fillStyle = "rgba(241, 168, 84, .9)";
  ctx.lineWidth = 3;
  ctx.setLineDash([12, 11]);
  const safeX = OUTPUT_WIDTH * 0.07;
  const safeTop = OUTPUT_HEIGHT * 0.07;
  const safeBottom = OUTPUT_HEIGHT * 0.915;
  ctx.strokeRect(safeX, safeTop, OUTPUT_WIDTH - safeX * 2, safeBottom - safeTop);
  ctx.setLineDash([]);

  const targetX = (shot.sourceBox.x + shot.sourceBox.w / 2 - frame.left) * frame.scale + frame.drawX;
  const targetY = (shot.sourceBox.y + shot.sourceBox.h / 2 - frame.top) * frame.scale + frame.drawY;
  ctx.beginPath();
  ctx.arc(targetX, targetY, 22, 0, Math.PI * 2);
  ctx.moveTo(targetX - 42, targetY);
  ctx.lineTo(targetX - 12, targetY);
  ctx.moveTo(targetX + 12, targetY);
  ctx.lineTo(targetX + 42, targetY);
  ctx.moveTo(targetX, targetY - 42);
  ctx.lineTo(targetX, targetY - 12);
  ctx.moveTo(targetX, targetY + 12);
  ctx.lineTo(targetX, targetY + 42);
  ctx.stroke();

  const gesture = shot.gesture.rect;
  const gx = (gesture.x - frame.left) * frame.scale + frame.drawX;
  const gy = (gesture.y - frame.top) * frame.scale + frame.drawY;
  ctx.strokeStyle = "rgba(127, 210, 183, .72)";
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 8]);
  ctx.strokeRect(gx, gy, gesture.w * frame.scale, gesture.h * frame.scale);
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(127, 210, 183, .86)";
  ctx.font = '500 18px "Droid Sans Fallback", sans-serif';
  ctx.fillText("GESTURE SAFE", gx + 5, Math.max(34, gy - 8));
  ctx.restore();
}

export class PortraitRenderer {
  draw(
    ctx: Any2D,
    project: Project,
    time: number,
    frame: CropFrame,
    source: HTMLCanvasElement,
    options: PortraitOptions = {},
  ): void {
    const index = shotIndexAt(project, time);
    const shot = project.shots[index];
    ctx.fillStyle = "#11100e";
    ctx.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);

    if (frame.letterbox) {
      ctx.save();
      ctx.filter = "blur(54px) brightness(.42) saturate(.72)";
      const bgScale = Math.max(
        OUTPUT_WIDTH / project.sourceWidth,
        OUTPUT_HEIGHT / project.sourceHeight,
      ) * 1.14;
      const bgW = project.sourceWidth * bgScale;
      const bgH = project.sourceHeight * bgScale;
      ctx.drawImage(source, (OUTPUT_WIDTH - bgW) / 2, (OUTPUT_HEIGHT - bgH) / 2, bgW, bgH);
      ctx.restore();
    }

    ctx.drawImage(
      source,
      frame.left,
      frame.top,
      Math.max(1, frame.width),
      Math.max(1, frame.height),
      frame.drawX,
      frame.drawY,
      frame.drawW,
      frame.drawH,
    );

    const vignette = ctx.createRadialGradient(
      OUTPUT_WIDTH / 2,
      OUTPUT_HEIGHT * 0.42,
      OUTPUT_WIDTH * 0.2,
      OUTPUT_WIDTH / 2,
      OUTPUT_HEIGHT * 0.48,
      OUTPUT_HEIGHT * 0.67,
    );
    vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
    vignette.addColorStop(0.72, "rgba(0, 0, 0, .08)");
    vignette.addColorStop(1, "rgba(0, 0, 0, .4)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);

    if (options.chrome !== false) drawChrome(ctx, project, shot, time, options.timecode !== false);
    if (options.captions !== false) drawCaption(ctx, shot.text);
    if (options.guides) drawGuides(ctx, frame, shot);
  }
}
