/**
 * Canvas 画面渲染：把统一时间线上的某个时刻画成一帧。
 * demo 素材用程序化画面（每段独立配色 + 段名 + 节拍闪点），
 * 本地导入素材则把视频帧画进同一画布。
 */

import type { Beat, Clip, CutPoint } from "../core/types.ts";

export const RENDER_WIDTH = 640;
export const RENDER_HEIGHT = 360;

const PALETTE: [number, number, number][] = [
  [42, 92, 170],
  [38, 140, 150],
  [184, 104, 48],
  [150, 64, 140],
  [214, 140, 60],
  [110, 48, 150],
  [200, 78, 72],
  [64, 120, 96],
];

export interface RenderContext {
  clips: Clip[];
  beats: Beat[];
  cuts: CutPoint[];
  /** 本地导入的视频元素（可选），key 为 sourceId。 */
  videoSources?: Map<string, HTMLVideoElement>;
}

function clipAtTime(clips: readonly Clip[], time: number): { clip: Clip; index: number } | null {
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    if (time >= clip.start && time < clip.start + clip.duration) {
      return { clip, index: i };
    }
  }
  const last = clips[clips.length - 1];
  return last ? { clip: last, index: clips.length - 1 } : null;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 渲染 time 秒处的一帧。 */
export function renderFrame(
  canvas: HTMLCanvasElement,
  time: number,
  context: RenderContext,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D 上下文不可用");
  const hit = clipAtTime(context.clips, time);
  const [r, g, b] = hit ? PALETTE[hit.index % PALETTE.length] : [20, 20, 24];

  // 渐变背景，颜色随片段切换。
  const gradient = ctx.createLinearGradient(0, 0, RENDER_WIDTH, RENDER_HEIGHT);
  gradient.addColorStop(0, `rgb(${r},${g},${b})`);
  gradient.addColorStop(1, `rgb(${Math.floor(r * 0.35)},${Math.floor(g * 0.35)},${Math.floor(b * 0.4)})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, RENDER_WIDTH, RENDER_HEIGHT);

  if (hit) {
    const video = context.videoSources?.get(hit.clip.source.sourceId);
    if (video && video.readyState >= 2) {
      ctx.drawImage(video, 0, 0, RENDER_WIDTH, RENDER_HEIGHT);
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.fillRect(0, RENDER_HEIGHT - 70, RENDER_WIDTH, 70);
    } else {
      drawProceduralMotif(ctx, hit.index, time);
    }
    drawClipLabel(ctx, hit.clip, hit.index + 1);
  }

  drawBeatFlash(ctx, time, context.beats);
  drawTimecode(ctx, time);
}

function drawProceduralMotif(ctx: CanvasRenderingContext2D, index: number, time: number): void {
  ctx.save();
  ctx.globalAlpha = 0.22;
  const drift = (time * 40 + index * 30) % (RENDER_WIDTH + 120) - 60;
  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < 4; i++) {
    const size = 40 + i * 22;
    ctx.beginPath();
    ctx.arc(drift + i * 130, 90 + i * 46, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawClipLabel(ctx: CanvasRenderingContext2D, clip: Clip, ordinal: number): void {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  roundRectPath(ctx, 28, RENDER_HEIGHT - 96, 300, 56, 12);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 15px system-ui, sans-serif";
  ctx.textBaseline = "top";
  const weightLabel = clip.weight === "strong" ? "强" : clip.weight === "weak" ? "弱" : "中";
  ctx.fillText(`片段 ${ordinal} · ${weightLabel}`, 44, RENDER_HEIGHT - 88);
  ctx.font = "700 22px system-ui, sans-serif";
  ctx.fillText(clip.name, 44, RENDER_HEIGHT - 66);
  ctx.restore();
}

function drawBeatFlash(ctx: CanvasRenderingContext2D, time: number, beats: readonly Beat[]): void {
  for (const beat of beats) {
    const delta = time - beat.time;
    if (delta >= 0 && delta < 0.12) {
      ctx.save();
      ctx.globalAlpha = (1 - delta / 0.12) * (beat.downbeat ? 0.5 : 0.25);
      ctx.fillStyle = beat.downbeat ? "#ffd166" : "#ffffff";
      ctx.beginPath();
      ctx.arc(RENDER_WIDTH - 44, 44, beat.downbeat ? 22 : 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
  }
}

function drawTimecode(ctx: CanvasRenderingContext2D, time: number): void {
  const total = Math.max(0, time);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(Math.floor(total % 60)).padStart(2, "0");
  const cs = String(Math.floor((total % 1) * 100)).padStart(2, "0");
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  roundRectPath(ctx, RENDER_WIDTH - 108, 16, 92, 30, 8);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 16px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  ctx.fillText(`${mm}:${ss}.${cs}`, RENDER_WIDTH - 98, 32);
  ctx.restore();
}
