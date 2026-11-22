import { nearestFrame, type TapeConfig } from "./model.js";
import type { RenderResult } from "./synth.js";

interface Geometry {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  startX: number;
  impactX: number;
  endX: number;
  totalSec: number;
}

function setup(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; width: number; height: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(2, Math.round(rect.width));
  const height = Math.max(2, Math.round(rect.height));
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unavailable");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function geometry(result: RenderResult, width: number, height: number): Geometry {
  const left = 18;
  const right = width - 18;
  const top = 30;
  const bottom = height - 17;
  const totalSec = result.timing.totalSec;
  const xAt = (sec: number): number => left + (Math.max(0, Math.min(totalSec, sec)) / totalSec) * (right - left);
  return {
    width,
    height,
    left,
    right,
    top,
    bottom,
    startX: xAt(result.config.startSec),
    impactX: xAt(result.config.impactSec),
    endX: right,
    totalSec,
  };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  background: string,
): void {
  ctx.font = "700 9px ui-monospace, SFMono-Regular, Menlo, monospace";
  const width = ctx.measureText(text).width + 12;
  roundRect(ctx, x - width / 2, y - 8, width, 16, 3);
  ctx.fillStyle = background;
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 0.3);
}

export type TimelineHandle = "start" | "impact" | "scrub";

export class TimelineRenderer {
  private readonly canvas: HTMLCanvasElement;
  private result: RenderResult | null = null;
  private playheadSec = 0;
  private lastGeometry: Geometry | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  draw(result: RenderResult, playheadSec: number): void {
    this.result = result;
    this.playheadSec = playheadSec;
    const { ctx, width, height } = setup(this.canvas);
    const geo = geometry(result, width, height);
    this.lastGeometry = geo;
    const { config, timing } = result;

    ctx.clearRect(0, 0, width, height);
    const background = ctx.createLinearGradient(0, 0, 0, height);
    background.addColorStop(0, "#0e1411");
    background.addColorStop(1, "#090d0b");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    const rulerY = 20;
    const frameStep = 1 / config.fps;
    const pxPerFrame = ((geo.right - geo.left) / geo.totalSec) * frameStep;
    const tickFrames = Math.max(1, Math.ceil(5 / Math.max(pxPerFrame, 0.1)));
    for (let frame = 0; frame <= config.fps * geo.totalSec; frame += tickFrames) {
      const x = geo.left + (frame / config.fps / geo.totalSec) * (geo.right - geo.left);
      const major = frame % Math.max(1, Math.round(config.fps / 2)) === 0;
      ctx.strokeStyle = major ? "rgba(220,235,218,0.16)" : "rgba(220,235,218,0.065)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, rulerY);
      ctx.lineTo(x + 0.5, major ? 27 : 24);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(239,244,226,0.45)";
    ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    for (let second = 0; second <= Math.ceil(geo.totalSec); second += 0.5) {
      const x = geo.left + (second / geo.totalSec) * (geo.right - geo.left);
      if (second === 0 || x > geo.left + 20) {
        ctx.fillText(`${second.toFixed(second % 1 ? 1 : 0)}s`, x + 3, 2);
      }
    }

    const centerY = geo.top + (geo.bottom - geo.top) * 0.62;
    const amplitude = Math.max(12, (geo.bottom - geo.top) * 0.25);
    const slowGradient = ctx.createLinearGradient(geo.startX, 0, geo.impactX, 0);
    slowGradient.addColorStop(0, "rgba(205,255,63,0.045)");
    slowGradient.addColorStop(1, "rgba(255,94,54,0.115)");
    ctx.fillStyle = slowGradient;
    ctx.fillRect(geo.startX, geo.top, geo.impactX - geo.startX, geo.bottom - geo.top);

    ctx.strokeStyle = "rgba(228,241,217,0.1)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(geo.left, centerY + 0.5);
    ctx.lineTo(geo.right, centerY + 0.5);
    ctx.stroke();

    const impactIndex = timing.impactSample;
    const pixelWidth = Math.max(1, geo.right - geo.left);
    ctx.strokeStyle = "rgba(202,255,83,0.65)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = geo.left; x <= geo.impactX; x += 1) {
      const from = Math.floor(((x - geo.left) / pixelWidth) * timing.totalSamples);
      const to = Math.floor(((x + 1 - geo.left) / pixelWidth) * timing.totalSamples);
      let peak = 0;
      const stride = Math.max(1, Math.floor((to - from) / 36));
      for (let sample = from; sample < Math.min(to, impactIndex); sample += stride) {
        peak = Math.max(peak, Math.abs(result.left[sample]), Math.abs(result.right[sample]));
      }
      const y = peak * amplitude;
      if (x === geo.left) ctx.moveTo(x, centerY - y);
      else ctx.lineTo(x, centerY - y);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(202,255,83,0.24)";
    ctx.beginPath();
    for (let x = geo.left; x <= geo.impactX; x += 1) {
      const from = Math.floor(((x - geo.left) / pixelWidth) * timing.totalSamples);
      const to = Math.floor(((x + 1 - geo.left) / pixelWidth) * timing.totalSamples);
      let peak = 0;
      const stride = Math.max(1, Math.floor((to - from) / 36));
      for (let sample = from; sample < Math.min(to, impactIndex); sample += stride) {
        peak = Math.max(peak, Math.abs(result.left[sample]), Math.abs(result.right[sample]));
      }
      const y = peak * amplitude;
      if (x === geo.left) ctx.moveTo(x, centerY + y);
      else ctx.lineTo(x, centerY + y);
    }
    ctx.stroke();

    ctx.strokeStyle = "#ff6a3e";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const curveTop = geo.top + 8;
    const curveBottom = centerY - amplitude - 7;
    ctx.moveTo(geo.startX, curveTop);
    for (let time = config.startSec; time <= config.impactSec; time += 0.008) {
      const rate = 1 - (time - config.startSec) / (config.impactSec - config.startSec);
      const x = geo.left + (time / geo.totalSec) * (geo.right - geo.left);
      const y = curveTop + (curveBottom - curveTop) * (1 - rate);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(geo.impactX, curveBottom);
    ctx.stroke();

    for (const crossing of result.crossings) {
      const x = geo.left + (crossing.timeSec / geo.totalSec) * (geo.right - geo.left);
      ctx.fillStyle = "#f3f5e8";
      ctx.beginPath();
      ctx.arc(x, centerY - amplitude - 10, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(243,245,232,0.22)";
      ctx.beginPath();
      ctx.moveTo(x, centerY - amplitude - 7);
      ctx.lineTo(x, centerY + amplitude);
      ctx.stroke();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(geo.impactX, geo.top, geo.endX - geo.impactX, geo.bottom - geo.top);
    ctx.clip();
    ctx.strokeStyle = "rgba(255,99,60,0.12)";
    ctx.lineWidth = 1;
    for (let x = geo.impactX - (geo.bottom - geo.top); x < geo.right; x += 9) {
      ctx.beginPath();
      ctx.moveTo(x, geo.bottom);
      ctx.lineTo(x + (geo.bottom - geo.top), geo.top);
      ctx.stroke();
    }
    ctx.restore();

    if (geo.impactX - geo.startX > 68) {
      label(ctx, "DECEL", (geo.startX + geo.impactX) / 2, geo.top + 13, "#d7ff3f", "rgba(28,39,24,0.95)");
    }
    if (geo.endX - geo.impactX > 82) {
      label(ctx, "0 / SILENCE", (geo.impactX + geo.endX) / 2, centerY, "#ff8b68", "rgba(44,24,18,0.95)");
    }

    ctx.strokeStyle = "#d7ff3f";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(geo.startX + 0.5, geo.top);
    ctx.lineTo(geo.startX + 0.5, geo.bottom);
    ctx.stroke();
    ctx.fillStyle = "#d7ff3f";
    ctx.beginPath();
    ctx.moveTo(geo.startX - 5, geo.top);
    ctx.lineTo(geo.startX + 6, geo.top);
    ctx.lineTo(geo.startX + 0.5, geo.top + 7);
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = "left";
    ctx.font = "700 9px ui-monospace, SFMono-Regular, Menlo, monospace";
    const startText = `START ${nearestFrame(config.startSec, config.fps)}f`;
    const startLabelX = Math.min(geo.startX + 8, geo.impactX - 56);
    ctx.fillStyle = "#d7ff3f";
    ctx.fillText(startText, startLabelX, geo.top - 4);

    ctx.strokeStyle = "#ff6a3e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(geo.impactX + 0.5, geo.top - 2);
    ctx.lineTo(geo.impactX + 0.5, geo.bottom);
    ctx.stroke();
    ctx.fillStyle = "#ff6a3e";
    ctx.fillRect(geo.impactX + 5, geo.top + 2, 2, 8);
    ctx.font = "800 9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#ff8a68";
    const narrow = geo.impactX - geo.startX < 145;
    const impactText = `MUTE ${nearestFrame(config.impactSec, config.fps)}f`;
    if (narrow) {
      ctx.textAlign = "left";
      ctx.fillText("MUTE", geo.impactX + 6, geo.top - 4);
    } else {
      ctx.textAlign = "right";
      ctx.fillText(impactText, geo.impactX - 7, geo.top - 9);
    }

    const playX = geo.left + (Math.min(geo.totalSec, Math.max(0, this.playheadSec)) / geo.totalSec) * (geo.right - geo.left);
    ctx.strokeStyle = "rgba(244,246,232,0.88)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playX + 0.5, geo.top - 4);
    ctx.lineTo(playX + 0.5, geo.bottom);
    ctx.stroke();
    ctx.fillStyle = "#f3f6e6";
    ctx.beginPath();
    ctx.arc(playX, geo.top - 4, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(240,246,225,0.1)";
    ctx.lineWidth = 1;
    ctx.strokeRect(geo.left - 0.5, geo.top - 0.5, geo.right - geo.left + 1, geo.bottom - geo.top + 1);
  }

  hitTest(clientX: number): TimelineHandle {
    if (!this.lastGeometry) return "scrub";
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const distanceStart = Math.abs(x - this.lastGeometry.startX);
    const distanceImpact = Math.abs(x - this.lastGeometry.impactX);
    if (distanceStart <= 9 && distanceStart <= distanceImpact) return "start";
    if (distanceImpact <= 9) return "impact";
    return "scrub";
  }

  timeAt(clientX: number): number {
    if (!this.lastGeometry) return 0;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const ratio = (x - this.lastGeometry.left) / (this.lastGeometry.right - this.lastGeometry.left);
    return Math.max(0, Math.min(this.lastGeometry.totalSec, ratio * this.lastGeometry.totalSec));
  }
}
