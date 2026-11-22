import { SOURCE_HEIGHT, SOURCE_WIDTH } from "./types.ts";
import type { Project, Shot } from "./types.ts";
import { shotIndexAt } from "./crop.ts";

export type Any2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function roundRect(
  ctx: Any2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawStudio(ctx: Any2D): void {
  const wall = ctx.createLinearGradient(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);
  wall.addColorStop(0, "#b99b7c");
  wall.addColorStop(0.45, "#d1b391");
  wall.addColorStop(1, "#9f8067");
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);

  const glow = ctx.createRadialGradient(730, 280, 20, 730, 280, 740);
  glow.addColorStop(0, "rgba(255, 236, 191, .7)");
  glow.addColorStop(0.5, "rgba(255, 218, 162, .18)");
  glow.addColorStop(1, "rgba(255, 218, 162, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);

  ctx.fillStyle = "rgba(76, 52, 39, .24)";
  for (let x = 60; x < SOURCE_WIDTH; x += 148) {
    ctx.fillRect(x, 0, 3, 780);
  }
  ctx.fillStyle = "rgba(255, 245, 217, .1)";
  for (let x = 72; x < SOURCE_WIDTH; x += 148) {
    ctx.fillRect(x, 0, 2, 780);
  }

  ctx.fillStyle = "#30453f";
  ctx.fillRect(80, 90, 510, 590);
  const windowGlow = ctx.createLinearGradient(95, 95, 575, 670);
  windowGlow.addColorStop(0, "#9ec9bd");
  windowGlow.addColorStop(0.55, "#648e84");
  windowGlow.addColorStop(1, "#c3d6c1");
  ctx.fillStyle = windowGlow;
  ctx.fillRect(100, 110, 470, 550);
  ctx.strokeStyle = "rgba(34, 56, 50, .85)";
  ctx.lineWidth = 12;
  ctx.strokeRect(100, 110, 470, 550);
  ctx.beginPath();
  ctx.moveTo(335, 110);
  ctx.lineTo(335, 660);
  ctx.moveTo(100, 385);
  ctx.lineTo(570, 385);
  ctx.stroke();
  ctx.fillStyle = "rgba(225, 239, 220, .28)";
  ctx.beginPath();
  ctx.moveTo(125, 620);
  ctx.lineTo(335, 150);
  ctx.lineTo(335, 620);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#5e4532";
  ctx.fillRect(1570, 168, 230, 370);
  ctx.fillStyle = "#785d43";
  ctx.fillRect(1584, 182, 202, 342);
  ctx.fillStyle = "#d7b985";
  for (let row = 0; row < 5; row += 1) {
    const count = 3 + (row % 2);
    for (let col = 0; col < count; col += 1) {
      ctx.fillRect(1596 + col * 62, 196 + row * 62, 45, 48);
    }
  }

  const floor = ctx.createLinearGradient(0, 760, 0, SOURCE_HEIGHT);
  floor.addColorStop(0, "rgba(91, 63, 47, .18)");
  floor.addColorStop(1, "rgba(42, 28, 22, .78)");
  ctx.fillStyle = floor;
  ctx.fillRect(0, 760, SOURCE_WIDTH, 320);

  ctx.fillStyle = "rgba(247, 231, 201, .12)";
  ctx.font = '600 28px "Droid Sans Fallback", sans-serif';
  ctx.letterSpacing = "8px";
  ctx.fillText("STUDIO 04  /  OFF AIR", 86, 770);
  ctx.letterSpacing = "0px";
}

function drawPlant(ctx: Any2D, x: number, y: number): void {
  ctx.fillStyle = "#3d3028";
  ctx.beginPath();
  ctx.moveTo(x - 55, y);
  ctx.lineTo(x + 55, y);
  ctx.lineTo(x + 42, y + 116);
  ctx.lineTo(x - 42, y + 116);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#486546";
  ctx.lineWidth = 8;
  const leaves = [
    [-52, -100, -110, -158],
    [18, -120, 70, -210],
    [-8, -150, -34, -258],
    [48, -78, 126, -116],
    [-42, -52, -112, -58],
  ];
  for (const [sx, sy, ex, ey] of leaves) {
    ctx.beginPath();
    ctx.moveTo(x + sx, y + sy);
    ctx.quadraticCurveTo(x + (sx + ex) / 2 + 20, y + (sy + ey) / 2, x + ex, y + ey);
    ctx.stroke();
  }
}

function drawChair(ctx: Any2D, x: number): void {
  ctx.fillStyle = "rgba(38, 27, 23, .42)";
  roundRect(ctx, x - 205, 620, 410, 280, 80);
  ctx.fill();
  ctx.strokeStyle = "rgba(235, 204, 153, .2)";
  ctx.lineWidth = 6;
  ctx.stroke();
}

function drawPerson(
  ctx: Any2D,
  shot: Shot,
  localTime: number,
  shotPhase: number,
): void {
  const isLin = shot.person === "lin";
  const bob = Math.sin(localTime * 1.7 + shotPhase) * 2.2;
  const gestureStrength = 0.55 + 0.45 * Math.sin(localTime * 2.1 + shotPhase * 2);
  const armLift = 8 + gestureStrength * 22;
  ctx.save();
  ctx.translate(
    shot.sourceBox.x + shot.sourceBox.w / 2,
    shot.sourceBox.y + bob,
  );
  ctx.scale(shot.sourceBox.w / 420, shot.sourceBox.h / 610);

  if (!isLin) {
    ctx.fillStyle = "#43312b";
    ctx.beginPath();
    ctx.ellipse(0, 253, 222, 246, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const jacket = ctx.createLinearGradient(-210, 320, 210, 580);
  jacket.addColorStop(0, isLin ? "#283f4c" : "#5b463b");
  jacket.addColorStop(0.5, isLin ? "#38586a" : "#81614d");
  jacket.addColorStop(1, isLin ? "#20343f" : "#44342d");
  ctx.fillStyle = jacket;
  ctx.beginPath();
  ctx.moveTo(-54, 286);
  ctx.bezierCurveTo(-128, 294, -184, 340, -204, 430);
  ctx.quadraticCurveTo(-218, 548, -205, 606);
  ctx.lineTo(205, 606);
  ctx.quadraticCurveTo(218, 512, 200, 416);
  ctx.bezierCurveTo(176, 338, 126, 294, 54, 286);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 231, 194, .18)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-43, 296);
  ctx.lineTo(0, 410);
  ctx.lineTo(43, 296);
  ctx.stroke();

  const skin = ctx.createLinearGradient(-100, 60, 110, 260);
  skin.addColorStop(0, isLin ? "#d8a77f" : "#e4b793");
  skin.addColorStop(1, isLin ? "#b57b5d" : "#c88f6f");
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(0, 172, 98, 124, 0, 0, Math.PI * 2);
  ctx.fill();
  const neck = ctx.createLinearGradient(0, 232, 0, 322);
  neck.addColorStop(0, isLin ? "#b77d5e" : "#c98f6e");
  neck.addColorStop(1, isLin ? "#ca9472" : "#d9a582");
  ctx.fillStyle = neck;
  ctx.beginPath();
  ctx.moveTo(-32, 232);
  ctx.lineTo(-39, 318);
  ctx.quadraticCurveTo(0, 335, 39, 318);
  ctx.lineTo(32, 232);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(85, 53, 42, .15)";
  ctx.beginPath();
  ctx.ellipse(0, 257, 45, 12, 0, 0, Math.PI);
  ctx.fill();

  if (isLin) {
    ctx.fillStyle = "#27231f";
    ctx.beginPath();
    ctx.ellipse(0, 96, 103, 70, 0, Math.PI, Math.PI * 2);
    ctx.lineTo(93, 135);
    ctx.quadraticCurveTo(65, 82, 0, 74);
    ctx.quadraticCurveTo(-76, 82, -96, 143);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-84, 164, 18, 31, 0, 0, Math.PI * 2);
    ctx.ellipse(84, 164, 18, 31, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(57, 42, 34, .25)";
    ctx.fillRect(-54, 260, 108, 7);
  } else {
    ctx.fillStyle = "#332720";
    ctx.beginPath();
    ctx.ellipse(0, 103, 121, 104, 0, Math.PI, Math.PI * 2);
    ctx.lineTo(112, 246);
    ctx.quadraticCurveTo(135, 193, 105, 132);
    ctx.quadraticCurveTo(46, 67, -38, 76);
    ctx.quadraticCurveTo(-121, 92, -116, 228);
    ctx.lineTo(-97, 277);
    ctx.quadraticCurveTo(-81, 170, 0, 159);
    ctx.quadraticCurveTo(83, 169, 98, 268);
    ctx.lineTo(113, 217);
    ctx.quadraticCurveTo(104, 126, 54, 91);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#c99754";
    ctx.beginPath();
    ctx.arc(-91, 211, 9, 0, Math.PI * 2);
    ctx.arc(91, 211, 9, 0, Math.PI * 2);
    ctx.fill();
  }

  const blink = Math.sin(localTime * 1.3 + shotPhase * 4) > 0.985 ? 0.18 : 1;
  ctx.fillStyle = "#30231f";
  ctx.beginPath();
  ctx.ellipse(-36, 168, 8, 7 * blink, 0, 0, Math.PI * 2);
  ctx.ellipse(36, 168, 8, 7 * blink, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#544035";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-52, 145);
  ctx.quadraticCurveTo(-34, 138, -18, 145);
  ctx.moveTo(18, 145);
  ctx.quadraticCurveTo(34, 138, 52, 145);
  ctx.stroke();
  ctx.strokeStyle = "rgba(106, 68, 54, .7)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, 184);
  ctx.quadraticCurveTo(-5, 207, 7, 211);
  ctx.stroke();
  const mouthOpen = Math.max(0, Math.sin(localTime * 7.4 + shotPhase)) * 4;
  ctx.strokeStyle = isLin ? "#7b463f" : "#92554c";
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(-23, 230);
  ctx.quadraticCurveTo(0, 238 + mouthOpen, 23, 230);
  ctx.stroke();
  if (mouthOpen > 1.2) {
    ctx.fillStyle = "rgba(94, 48, 45, .62)";
    ctx.beginPath();
    ctx.ellipse(0, 233.5, 17, 2 + mouthOpen * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const handsY = 384 + armLift;
  ctx.strokeStyle = isLin ? "#253b47" : "#6b5041";
  ctx.lineWidth = 46;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-160, 416);
  ctx.quadraticCurveTo(-198, 458, -173, handsY + 54);
  ctx.moveTo(160, 416);
  ctx.quadraticCurveTo(205, 454, 176, handsY + 46);
  ctx.stroke();

  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(-173, handsY + 62, 28, 34, -0.35, 0, Math.PI * 2);
  ctx.ellipse(176, handsY + 54, 27, 33, 0.34, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(112, 72, 54, .38)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i += 1) {
    ctx.beginPath();
    ctx.moveTo(-190 + i * 11, handsY + 45);
    ctx.lineTo(-187 + i * 11, handsY + 72);
    ctx.moveTo(163 + i * 11, handsY + 41);
    ctx.lineTo(166 + i * 11, handsY + 68);
    ctx.stroke();
  }
  ctx.restore();
}

function drawForeground(ctx: Any2D, time: number): void {
  const desk = ctx.createLinearGradient(0, 824, 0, 980);
  desk.addColorStop(0, "#6f503c");
  desk.addColorStop(0.18, "#543b2e");
  desk.addColorStop(1, "#2a1e19");
  ctx.fillStyle = desk;
  ctx.beginPath();
  ctx.moveTo(-40, 864);
  ctx.lineTo(SOURCE_WIDTH + 40, 842);
  ctx.lineTo(SOURCE_WIDTH + 40, SOURCE_HEIGHT + 20);
  ctx.lineTo(-40, SOURCE_HEIGHT + 20);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(238, 205, 153, .16)";
  ctx.fillRect(0, 860, SOURCE_WIDTH, 4);

  ctx.fillStyle = "#d9c6a2";
  roundRect(ctx, 1510, 813, 142, 52, 5);
  ctx.fill();
  ctx.fillStyle = "#c4ad87";
  for (let i = 0; i < 8; i += 1) {
    ctx.fillRect(1522 + i * 15, 813, 3, 52);
  }
  ctx.strokeStyle = "#937b59";
  ctx.lineWidth = 2;
  for (let i = 0; i < 8; i += 1) {
    ctx.beginPath();
    ctx.moveTo(1522 + i * 15, 817);
    ctx.lineTo(1522 + i * 15, 860);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(245, 222, 178, .1)";
  ctx.beginPath();
  ctx.ellipse(420 + Math.sin(time * 0.6) * 4, 862, 230, 16, 0, 0, Math.PI * 2);
  ctx.fill();
}

export class SourceRenderer {
  private background: HTMLCanvasElement;

  constructor() {
    this.background = makeCanvas(SOURCE_WIDTH, SOURCE_HEIGHT);
    const ctx = this.background.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    drawStudio(ctx);
    drawPlant(ctx, 1465, 760);
    drawPlant(ctx, 1770, 710);
  }

  draw(ctx: Any2D, project: Project, time: number): void {
    const index = shotIndexAt(project, time);
    const shot = project.shots[index];
    const localTime = Math.max(0, time - shot.start);
    const phase = (index + 1) * 1.73;
    ctx.drawImage(this.background, 0, 0);
    drawChair(ctx, shot.sourceBox.x + shot.sourceBox.w / 2);
    if (index > 0) {
      const neighbor = project.shots[index - 1];
      ctx.save();
      ctx.globalAlpha = 0.72;
      drawPerson(ctx, neighbor, time - neighbor.start, phase - 0.8);
      ctx.restore();
    }
    drawPerson(ctx, shot, localTime, phase);
    drawForeground(ctx, time);

    ctx.fillStyle = "rgba(18, 16, 14, .62)";
    roundRect(ctx, 54, 48, 318, 58, 8);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 244, 220, .88)";
    ctx.font = '600 24px "Droid Sans Fallback", sans-serif';
    ctx.fillText(`CAM A  ·  ${shot.person === "lin" ? "林越" : "周岚"}`, 78, 86);
    ctx.fillStyle = "#f0a955";
    ctx.beginPath();
    ctx.arc(334, 77, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 244, 220, .7)";
    ctx.font = '500 22px "Droid Sans Mono", monospace';
    const stamp = `${Math.floor(time / 60).toString().padStart(2, "0")}:${(time % 60).toFixed(2).padStart(5, "0")}`;
    ctx.fillText(stamp, 1660, 86);
  }
}
