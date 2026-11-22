import { TearingDetector } from "../src/core/analyzer.ts";
import type { FrameAnalysis } from "../src/core/types.ts";

export interface DemoResult {
  frames: FrameAnalysis[];
  thumbnails: string[];
  images: string[];
  waveform: Float32Array;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
}

export interface DemoProgress {
  ratio: number;
  label: string;
}

const WIDTH = 960;
const HEIGHT = 540;
const FPS = 24;
const FRAME_COUNT = 168;

export async function generateDemo(
  onProgress: (progress: DemoProgress) => void,
): Promise<DemoResult> {
  const clean = document.createElement("canvas");
  clean.width = WIDTH;
  clean.height = HEIGHT;
  const cleanCtx = clean.getContext("2d", { willReadFrequently: true });
  const display = document.createElement("canvas");
  display.width = WIDTH;
  display.height = HEIGHT;
  const displayCtx = display.getContext("2d", { willReadFrequently: true });
  const thumb = document.createElement("canvas");
  thumb.width = 120;
  thumb.height = 68;
  const thumbCtx = thumb.getContext("2d");
  if (!cleanCtx || !displayCtx || !thumbCtx) {
    throw new Error("Canvas 2D context is unavailable.");
  }

  const detector = new TearingDetector({ analysisWidth: 384 });
  const frames: FrameAnalysis[] = [];
  const thumbnails: string[] = [];
  const images: string[] = [];
  for (let index = 0; index < FRAME_COUNT; index += 1) {
    const time = index / FPS;
    renderScene(cleanCtx, time, index);
    displayCtx.clearRect(0, 0, WIDTH, HEIGHT);
    displayCtx.drawImage(clean, 0, 0);
    applyDefect(displayCtx, clean, index);
    const image = displayCtx.getImageData(0, 0, WIDTH, HEIGHT);
    frames.push(detector.analyze({ width: WIDTH, height: HEIGHT, data: image.data }, time * 1000));
    thumbCtx.drawImage(display, 0, 0, thumb.width, thumb.height);
    thumbnails.push(thumb.toDataURL("image/jpeg", 0.7));
    images.push(display.toDataURL("image/jpeg", 0.84));
    if (index % 4 === 0 || index === FRAME_COUNT - 1) {
      onProgress({
        ratio: (index + 1) / FRAME_COUNT,
        label:
          index < 10
            ? "正在校准片段横线基线…"
            : index < FRAME_COUNT - 12
              ? "正在检查帧内水平断层与跨帧重复…"
              : "正在汇总分类与导出索引…",
      });
      await nextTask();
    }
  }

  return {
    frames,
    thumbnails,
    images,
    waveform: buildDemoWaveform(frames, FRAME_COUNT),
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    durationMs: ((FRAME_COUNT - 1) / FPS) * 1000,
  };
}

function applyDefect(
  ctx: CanvasRenderingContext2D,
  clean: HTMLCanvasElement,
  index: number,
): void {
  if (index === 44 || index === 45 || index === 46 || index === 121) {
    drawTear(ctx, clean, 180, 72);
    return;
  }
  if (index === 88 || index === 89) {
    drawBlockDamage(ctx, index);
    return;
  }
  if (index >= 137 && index <= 144) {
    drawGlitchVfx(ctx, clean, index);
  }
}

function drawTear(
  ctx: CanvasRenderingContext2D,
  clean: HTMLCanvasElement,
  seam: number,
  shift: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, seam, WIDTH, HEIGHT - seam);
  ctx.clip();
  ctx.fillStyle = "#080d12";
  ctx.fillRect(0, seam, WIDTH, HEIGHT - seam);
  ctx.drawImage(clean, shift, 0);
  ctx.restore();
  const gradient = ctx.createLinearGradient(0, seam - 3, 0, seam + 4);
  gradient.addColorStop(0, "rgba(255,125,104,0)");
  gradient.addColorStop(0.5, "rgba(255,125,104,0.28)");
  gradient.addColorStop(1, "rgba(255,125,104,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, seam - 3, WIDTH, 7);
}

function drawBlockDamage(
  ctx: CanvasRenderingContext2D,
  seed: number,
): void {
  const startX = 390;
  const startY = 158;
  const regionWidth = 320;
  const regionHeight = 192;
  const image = ctx.getImageData(startX, startY, regionWidth, regionHeight);
  const data = image.data;
  const block = 16;
  const colors = [
    [205, 54, 84],
    [39, 202, 181],
    [236, 180, 59],
    [61, 110, 224],
    [185, 70, 205],
  ];
  for (let by = 0; by < regionHeight; by += block) {
    for (let bx = 0; bx < regionWidth; bx += block) {
      if ((bx / block + by / block + seed) % 6 === 0) continue;
      const color = colors[(bx / block + by / block + seed) % colors.length];
      for (let y = 0; y < block; y += 1) {
        for (let x = 0; x < block; x += 1) {
          const target = ((by + y) * regionWidth + bx + x) * 4;
          const noise = ((x * 19 + y * 31 + seed * 7) % 27) - 13;
          data[target] = color[0] + noise;
          data[target + 1] = color[1] - noise * 0.6;
          data[target + 2] = color[2] + noise * 0.4;
        }
      }
    }
  }
  ctx.putImageData(image, startX, startY);
  ctx.strokeStyle = "rgba(255, 89, 72, 0.13)";
  ctx.lineWidth = 1;
  for (let x = startX; x < startX + regionWidth; x += block) {
    ctx.beginPath();
    ctx.moveTo(x, startY);
    ctx.lineTo(x, startY + regionHeight);
    ctx.stroke();
  }
}

function drawGlitchVfx(
  ctx: CanvasRenderingContext2D,
  clean: HTMLCanvasElement,
  seed: number,
): void {
  const phase = seed - 137;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 0.28;
  ctx.drawImage(clean, -7 - (phase % 3) * 2, 0);
  ctx.globalAlpha = 0.2;
  ctx.drawImage(clean, 7 + (phase % 4) * 2, 0);
  ctx.restore();
  for (let y = 8; y < HEIGHT; y += 9) {
    const offset = ((y * 13 + phase * 17) % 29) - 14;
    ctx.drawImage(clean, 0, y, WIDTH, 2, offset, y, WIDTH, 2);
    ctx.fillStyle = y % 18 === 8 ? "rgba(132, 242, 226, 0.18)" : "rgba(255, 100, 90, 0.1)";
    ctx.fillRect(0, y, WIDTH, 1);
  }
  for (let i = 0; i < 10; i += 1) {
    const y = (i * 71 + phase * 29) % HEIGHT;
    const x = (i * 137 + phase * 43) % 720;
    ctx.fillStyle = i % 2 === 0 ? "rgba(112, 240, 224, 0.15)" : "rgba(255, 86, 108, 0.13)";
    ctx.fillRect(x, y, 90 + ((i * 47) % 180), 2);
  }
  ctx.fillStyle = "rgba(6, 9, 13, 0.22)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function buildDemoWaveform(frames: FrameAnalysis[], count: number): Float32Array {
  const values = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const base = 0.12 + Math.sin(i * 0.37) * 0.045 + Math.sin(i * 0.09) * 0.03;
    const flagged = frames[i]?.classification !== "normal";
    values[i] = Math.min(1, base + (flagged ? 0.16 + Math.sin(i * 1.7) * 0.11 : 0));
  }
  return values;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function renderScene(ctx: CanvasRenderingContext2D, time: number, index: number): void {
  const horizon = 258;
  const pan = (time * 22) % 960;
  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, "#0a1020");
  sky.addColorStop(0.46, "#15223a");
  sky.addColorStop(0.78, "#40324a");
  sky.addColorStop(1, "#a8614f");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, WIDTH, horizon + 2);

  const glow = ctx.createRadialGradient(738, 218, 3, 738, 218, 150);
  glow.addColorStop(0, "rgba(255, 191, 133, 0.55)");
  glow.addColorStop(0.18, "rgba(250, 135, 103, 0.22)");
  glow.addColorStop(1, "rgba(232, 101, 89, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(560, 70, 360, 270);

  drawCloudBank(ctx, 30 - pan * 0.14, 64, 0.3, "#1d2941");
  drawCloudBank(ctx, 540 - pan * 0.2, 42, 0.38, "#252d43");
  drawCity(ctx, time, horizon, 0);
  drawCity(ctx, time, horizon + 9, 1);

  ctx.fillStyle = "#151a22";
  ctx.fillRect(0, horizon + 2, WIDTH, 12);
  drawRoad(ctx, time, horizon);
  drawBarrier(ctx, time, horizon);
  drawRain(ctx, time, index);
  drawCar(ctx, time);
  drawHud(ctx, time);

  ctx.fillStyle = "rgba(2, 7, 11, 0.055)";
  for (let y = 0; y < HEIGHT; y += 4) ctx.fillRect(0, y, WIDTH, 1);
}

function drawCloudBank(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  color: string,
): void {
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = color;
  for (let i = 0; i < 5; i += 1) {
    ctx.beginPath();
    ctx.ellipse(x + i * 39 * scale, y + Math.sin(i * 1.8) * 7, 58 * scale, 14 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawCity(
  ctx: CanvasRenderingContext2D,
  time: number,
  horizon: number,
  layer: number,
): void {
  const offset = (time * (layer === 0 ? 8 : 18)) % 140;
  const baseY = horizon - (layer === 0 ? 4 : 0);
  ctx.save();
  ctx.fillStyle = layer === 0 ? "#111828" : "#0c121d";
  for (let i = -2; i < 19; i += 1) {
    const seed = (i + layer * 31 + 90) * 7919;
    const width = 48 + (seed % 58);
    const height = 30 + ((seed >> 3) % (layer === 0 ? 92 : 62));
    const x = i * 67 - offset;
    ctx.fillRect(x, baseY - height, width, height + 4);
    if (layer === 1) {
      ctx.fillStyle = "rgba(235, 181, 120, 0.22)";
      for (let wy = 0; wy < height - 10; wy += 11) {
        for (let wx = 8; wx < width - 6; wx += 13) {
          if ((seed + wx * 7 + wy * 13) % 5 < 2) ctx.fillRect(x + wx, baseY - height + 7 + wy, 3, 4);
        }
      }
      ctx.fillStyle = "#0c121d";
    }
  }
  ctx.restore();
}

function drawRoad(ctx: CanvasRenderingContext2D, time: number, horizon: number): void {
  const road = ctx.createLinearGradient(0, horizon, 0, HEIGHT);
  road.addColorStop(0, "#24272c");
  road.addColorStop(0.5, "#171b21");
  road.addColorStop(1, "#0d1117");
  ctx.fillStyle = road;
  ctx.beginPath();
  ctx.moveTo(388, horizon);
  ctx.lineTo(572, horizon);
  ctx.lineTo(928, HEIGHT);
  ctx.lineTo(32, HEIGHT);
  ctx.closePath();
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(388, horizon);
  ctx.lineTo(572, horizon);
  ctx.lineTo(928, HEIGHT);
  ctx.lineTo(32, HEIGHT);
  ctx.closePath();
  ctx.clip();
  const scroll = (time * 2.7) % 1;
  for (let i = 0; i < 12; i += 1) {
    const z = (i + scroll) / 12;
    const y = horizon + z ** 1.75 * (HEIGHT - horizon);
    const nextY = horizon + Math.min(1, z + 0.035) ** 1.75 * (HEIGHT - horizon);
    const center = 480 + Math.sin(time * 0.38) * 30 * (1 - z);
    const width = 2 + z * 17;
    ctx.fillStyle = `rgba(221, 217, 192, ${0.18 + z * 0.55})`;
    ctx.fillRect(center - width / 2, y, width, Math.max(1.5, nextY - y));
  }
  ctx.strokeStyle = "rgba(203, 220, 224, 0.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 7; i += 1) {
    ctx.beginPath();
    ctx.moveTo(480 + (i - 3) * 28, horizon);
    ctx.lineTo(480 + (i - 3) * 130, HEIGHT);
    ctx.stroke();
  }
  ctx.restore();

  ctx.fillStyle = "#0a0e13";
  ctx.beginPath();
  ctx.moveTo(0, horizon - 2);
  ctx.lineTo(386, horizon);
  ctx.lineTo(28, HEIGHT);
  ctx.lineTo(0, HEIGHT);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(574, horizon);
  ctx.lineTo(960, horizon - 2);
  ctx.lineTo(960, HEIGHT);
  ctx.lineTo(932, HEIGHT);
  ctx.closePath();
  ctx.fill();
}

function drawBarrier(ctx: CanvasRenderingContext2D, time: number, horizon: number): void {
  ctx.save();
  for (let side = 0; side < 2; side += 1) {
    for (let i = 0; i < 8; i += 1) {
      const z = (i + ((time * 0.7) % 1)) / 8;
      const y = horizon + z ** 1.8 * (HEIGHT - horizon);
      const h = 5 + z ** 1.6 * 70;
      const x = side === 0 ? 154 - z * 116 : 806 + z * 116;
      ctx.fillStyle = i % 2 === 0 ? "rgba(124, 167, 168, 0.18)" : "rgba(239, 123, 90, 0.12)";
      ctx.fillRect(x, y - h, 2 + z * 5, h);
    }
  }
  ctx.restore();
}

function drawRain(ctx: CanvasRenderingContext2D, time: number, index: number): void {
  ctx.save();
  ctx.strokeStyle = "rgba(177, 211, 229, 0.16)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 65; i += 1) {
    const seed = i * 397 + index * 23;
    const x = (seed * 13 + time * 160) % (WIDTH + 80) - 40;
    const y = (seed * 7 + time * 540) % HEIGHT;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 5, y + 13);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCar(ctx: CanvasRenderingContext2D, time: number): void {
  const x = 530 + Math.sin(time * 0.82) * 22;
  const y = 382 + Math.sin(time * 1.7) * 2;
  ctx.save();
  ctx.translate(x, y);
  const body = ctx.createLinearGradient(0, 0, 0, 82);
  body.addColorStop(0, "#b3393b");
  body.addColorStop(0.4, "#7c202a");
  body.addColorStop(1, "#2b1219");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-96, 54);
  ctx.quadraticCurveTo(-82, 14, -42, 8);
  ctx.lineTo(37, 8);
  ctx.quadraticCurveTo(85, 15, 102, 56);
  ctx.lineTo(80, 78);
  ctx.lineTo(-78, 78);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#171a21";
  ctx.beginPath();
  ctx.moveTo(-44, 12);
  ctx.lineTo(-26, -19);
  ctx.lineTo(28, -19);
  ctx.lineTo(50, 12);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(99, 197, 212, 0.2)";
  ctx.beginPath();
  ctx.moveTo(-23, -14);
  ctx.lineTo(9, -14);
  ctx.lineTo(31, 9);
  ctx.lineTo(-37, 9);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#0b0d10";
  ctx.fillRect(-96, 63, 30, 13);
  ctx.fillRect(66, 63, 30, 13);
  ctx.shadowColor = "#ff463c";
  ctx.shadowBlur = 18;
  ctx.fillStyle = "#ff594e";
  ctx.fillRect(-80, 48, 42, 5);
  ctx.fillRect(38, 48, 42, 5);
  ctx.fillStyle = "rgba(255, 205, 129, 0.85)";
  ctx.fillRect(-72, 27, 5, 15);
  ctx.fillRect(67, 27, 5, 15);
  ctx.restore();
}

function drawHud(ctx: CanvasRenderingContext2D, time: number): void {
  ctx.save();
  ctx.lineWidth = 1;

  panel(ctx, 22, 20, 254, 76, "rgba(8, 17, 23, 0.8)", "rgba(111, 216, 208, 0.24)");
  ctx.fillStyle = "rgba(98, 227, 211, 0.78)";
  ctx.font = '600 8px "Cascadia Code", monospace';
  ctx.fillText("SECTOR 07 / NIGHT RUN", 36, 38);
  ctx.fillStyle = "rgba(235, 244, 245, 0.9)";
  ctx.font = '500 14px "Segoe UI", sans-serif';
  ctx.fillText("抵达检查点 A-3", 36, 59);
  ctx.fillStyle = "rgba(119, 145, 153, 0.85)";
  ctx.font = '500 8px "Segoe UI", sans-serif';
  ctx.fillText("距离 1,240 m", 36, 75);
  ctx.fillStyle = "#162a31";
  ctx.fillRect(36, 82, 222, 3);
  ctx.fillStyle = "#62e3d3";
  ctx.fillRect(36, 82, 152 + Math.sin(time * 0.7) * 3, 3);

  const dialX = 891;
  const dialY = 82;
  ctx.strokeStyle = "rgba(111, 216, 208, 0.3)";
  ctx.beginPath();
  ctx.arc(dialX, dialY, 48, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(111, 216, 208, 0.13)";
  ctx.beginPath();
  ctx.arc(dialX, dialY, 38, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(8, 17, 23, 0.73)";
  ctx.beginPath();
  ctx.arc(dialX, dialY, 46, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(108, 208, 202, 0.18)";
  for (let i = 0; i < 4; i += 1) {
    ctx.beginPath();
    ctx.moveTo(dialX - 28, dialY + 10 + i * 7);
    ctx.lineTo(dialX + 24, dialY + 10 + i * 7);
    ctx.stroke();
  }
  ctx.fillStyle = "#62e3d3";
  ctx.beginPath();
  ctx.arc(dialX + 8, dialY + 1, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(217, 239, 240, 0.75)";
  ctx.font = '600 7px "Cascadia Code", monospace';
  ctx.fillText("MINIMAP", dialX - 22, dialY + 5);

  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(238, 245, 245, 0.94)";
  ctx.font = '500 23px "Cascadia Code", monospace';
  ctx.fillText("238", 480, 46);
  ctx.fillStyle = "rgba(111, 216, 208, 0.75)";
  ctx.font = '600 7px "Cascadia Code", monospace';
  ctx.fillText("KM/H", 480, 57);
  ctx.fillStyle = "rgba(255, 147, 124, 0.9)";
  ctx.fillRect(436, 65, 88, 1);
  ctx.fillStyle = "rgba(187, 209, 211, 0.56)";
  ctx.font = '500 7px "Cascadia Code", monospace';
  ctx.fillText("GEAR 5  ·  03:42.118", 480, 80);

  panel(ctx, 34, 454, 210, 54, "rgba(8, 17, 23, 0.72)", "rgba(111, 216, 208, 0.18)");
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(111, 216, 208, 0.7)";
  ctx.font = '600 7px "Cascadia Code", monospace';
  ctx.fillText("LAP TIME", 48, 472);
  ctx.fillStyle = "rgba(239, 245, 245, 0.9)";
  ctx.font = '500 17px "Cascadia Code", monospace';
  ctx.fillText("03:42.118", 48, 492);
  ctx.fillStyle = "rgba(255, 143, 119, 0.85)";
  ctx.font = '600 7px "Cascadia Code", monospace';
  ctx.fillText("BEST 03:39.804", 48, 502);

  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(111, 216, 208, 0.72)";
  ctx.font = '600 7px "Cascadia Code", monospace';
  ctx.fillText("POSITION", 922, 472);
  ctx.fillStyle = "rgba(239, 245, 245, 0.94)";
  ctx.font = '500 22px "Cascadia Code", monospace';
  ctx.fillText("01", 908, 493);
  ctx.fillStyle = "rgba(130, 154, 160, 0.7)";
  ctx.font = '600 8px "Cascadia Code", monospace';
  ctx.fillText("/ 08", 924, 493);
  ctx.textAlign = "left";

  const tickX = 480;
  ctx.strokeStyle = "rgba(120, 218, 209, 0.2)";
  ctx.beginPath();
  ctx.moveTo(tickX - 160, 470);
  ctx.lineTo(tickX + 160, 470);
  ctx.stroke();
  for (let i = 0; i < 19; i += 1) {
    const x = tickX - 152 + i * 17;
    ctx.beginPath();
    ctx.moveTo(x, 466);
    ctx.lineTo(x, i % 3 === 0 ? 475 : 470);
    ctx.stroke();
  }
  ctx.fillStyle = "#ff7965";
  ctx.fillRect(tickX + 15, 463, 2, 14);

  ctx.fillStyle = "rgba(255, 121, 101, 0.7)";
  ctx.font = '600 7px "Cascadia Code", monospace';
  ctx.fillText("REPLAY  ●  CAPTURE", 42, 28);
  ctx.restore();
}

function panel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  stroke: string,
): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 3);
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.fillStyle = stroke;
  ctx.fillRect(x, y, 2, height);
}
