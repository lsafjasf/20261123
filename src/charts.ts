import { CAMERAS, clamp, type CameraId, type ChannelMetrics } from "./domain.ts";

export interface ChartFrame {
  t: number;
  channels: ChannelMetrics[];
}

export interface ChartOptions {
  highlight?: CameraId | null;
  cursor?: number | null;
  showOnsets?: boolean;
  minDb?: number;
  maxDb?: number;
}

function setup(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; width: number; height: number } {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || canvas.clientWidth || 320));
  const height = Math.max(1, Math.round(rect.height || canvas.clientHeight || 120));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

export function drawEnergyChart(
  canvas: HTMLCanvasElement,
  frames: ChartFrame[],
  options: ChartOptions = {},
): void {
  const { ctx, width, height } = setup(canvas);
  const minDb = options.minDb ?? -62;
  const maxDb = options.maxDb ?? -8;
  const top = 8;
  const bottom = height - 12;
  const left = 2;
  const right = width - 2;

  ctx.clearRect(0, 0, width, height);
  const background = ctx.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, "rgba(10,20,24,0.9)");
  background.addColorStop(1, "rgba(6,12,15,0.96)");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "left";
  for (let db = -60; db <= -20; db += 20) {
    const y = top + ((maxDb - db) / (maxDb - minDb)) * (bottom - top);
    ctx.strokeStyle = "rgba(139,185,191,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, Math.round(y) + 0.5);
    ctx.lineTo(right, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillStyle = "rgba(153,190,194,0.38)";
    ctx.fillText(`${db}`, 4, y - 3);
  }

  if (frames.length < 2) {
    ctx.fillStyle = "rgba(167,197,199,0.4)";
    ctx.textAlign = "center";
    ctx.fillText("等待声场采样", width / 2, height / 2);
    return;
  }

  const start = frames[0]?.t ?? 0;
  const end = frames[frames.length - 1]?.t ?? start + 1;
  const span = Math.max(1, end - start);
  const xOf = (t: number): number => left + ((t - start) / span) * (right - left);
  const yOf = (db: number): number => top + ((maxDb - clamp(db, minDb, maxDb)) / (maxDb - minDb)) * (bottom - top);

  if (options.highlight) {
    const spec = CAMERAS[options.highlight - 1];
    if (spec) {
      const glow = ctx.createLinearGradient(0, top, 0, bottom);
      glow.addColorStop(0, `${spec.color}00`);
      glow.addColorStop(0.8, `${spec.color}08`);
      glow.addColorStop(1, `${spec.color}0f`);
      ctx.fillStyle = glow;
      ctx.fillRect(left, top, right - left, bottom - top);
    }
  }

  for (const camera of CAMERAS) {
    const highlight = options.highlight === camera.id;
    ctx.strokeStyle = camera.color;
    ctx.globalAlpha = highlight ? 0.98 : 0.25;
    ctx.lineWidth = highlight ? 2 : 1;
    ctx.beginPath();
    let started = false;
    for (const frame of frames) {
      const channel = frame.channels.find((item) => item.camera === camera.id);
      if (!channel) continue;
      const x = xOf(frame.t);
      const y = yOf(channel.energyDb);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    if (highlight && options.showOnsets !== false) {
      for (const frame of frames) {
        const channel = frame.channels.find((item) => item.camera === camera.id);
        if (!channel || channel.onset < 0.18) continue;
        const x = xOf(frame.t);
        const amount = clamp(channel.onset, 0, 1);
        ctx.globalAlpha = 0.22 + amount * 0.6;
        ctx.fillStyle = camera.color;
        ctx.fillRect(x, bottom - 12 * amount, 1.4, 12 * amount);
      }
    }
  }
  ctx.globalAlpha = 1;

  if (options.cursor !== null && options.cursor !== undefined && options.cursor >= start && options.cursor <= end) {
    const x = xOf(options.cursor);
    ctx.strokeStyle = "rgba(245,250,220,0.75)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export function drawOnsetBars(canvas: HTMLCanvasElement, metrics: ChannelMetrics[]): void {
  const { ctx, width, height } = setup(canvas);
  ctx.clearRect(0, 0, width, height);
  const gap = 3;
  const barWidth = (width - gap * 5) / 6;
  for (const camera of CAMERAS) {
    const channel = metrics.find((item) => item.camera === camera.id);
    const x = (camera.id - 1) * (barWidth + gap);
    const level = clamp((((channel?.energyDb ?? -60) + 60) / 48), 0, 1);
    ctx.fillStyle = "rgba(255,255,255,0.055)";
    ctx.fillRect(x, 0, barWidth, height);
    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, `${camera.color}44`);
    gradient.addColorStop(1, camera.color);
    ctx.fillStyle = gradient;
    ctx.fillRect(x, height * (1 - level), barWidth, height * level);
    if ((channel?.onset ?? 0) > 0.16) {
      ctx.fillStyle = "#f5ffd4";
      ctx.globalAlpha = clamp(channel?.onset ?? 0, 0, 1);
      ctx.fillRect(x, 0, barWidth, 2);
      ctx.globalAlpha = 1;
    }
  }
}
