// Canvas renderer for the parametric demo scene. Pure function of the
// frame index — scrubbing, stepping and fps changes all stay in sync.

import {
  walkerX,
  walkerPhase,
  ballSim,
  doorAngle,
  WALK_END,
  BOUNCE_START,
  BOUNCE_END,
  DOOR_START,
} from '../shared/scene.ts';

const FLOOR_RATIO = 0.78;

export function drawScene(canvas: HTMLCanvasElement, t: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const floorY = h * FLOOR_RATIO;

  ctx.fillStyle = '#101418';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#2a3138';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, floorY);
  ctx.lineTo(w, floorY);
  ctx.stroke();

  drawWalker(ctx, t, w, floorY);
  drawBall(ctx, t, w, h, floorY);
  drawDoor(ctx, t, w, floorY);
}

function drawWalker(ctx: CanvasRenderingContext2D, t: number, w: number, floorY: number): void {
  if (t > WALK_END + 0.4) return;
  const x = walkerX(t) * w * 0.9 + w * 0.05;
  const hipY = floorY - 46;
  const phase = walkerPhase(t);
  const walking = t >= 0 && t <= WALK_END;
  const swing = walking ? Math.sin(phase) : 0;
  const bob = walking ? Math.abs(Math.cos(phase)) * 3 : 0;

  ctx.strokeStyle = '#e8b64c';
  ctx.fillStyle = '#e8b64c';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  // head + torso
  ctx.beginPath();
  ctx.arc(x, hipY - 34 - bob, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, hipY - 26 - bob);
  ctx.lineTo(x, hipY - bob);
  ctx.stroke();
  // legs
  for (const side of [-1, 1]) {
    const a = swing * side * 0.6;
    const footX = x + Math.sin(a) * 26;
    const lift = Math.max(0, Math.cos(phase * 1 + (side > 0 ? 0 : Math.PI))) * (walking ? 8 : 0);
    ctx.beginPath();
    ctx.moveTo(x, hipY - bob);
    ctx.lineTo(footX, floorY - lift);
    ctx.stroke();
  }
}

function drawBall(ctx: CanvasRenderingContext2D, t: number, w: number, h: number, floorY: number): void {
  if (t < BOUNCE_START || t > BOUNCE_END) return;
  const sim = ballSim();
  const height = sim.heightAt(t);
  if (height === null) return;
  const r = 16;
  const x = w * 0.3;
  const y = floorY - r - height * (floorY - r - h * 0.08);
  // squash on contact
  const squash = height < 0.02 ? 1 - (0.02 - height) * 12 : 1;
  ctx.fillStyle = '#5ac8fa';
  ctx.beginPath();
  ctx.ellipse(x, y + r * (1 - squash), r / squash, r * squash, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawDoor(ctx: CanvasRenderingContext2D, t: number, w: number, floorY: number): void {
  if (t < DOOR_START - 0.5) return;
  const hingeX = w * 0.68;
  const doorH = 120;
  const doorW = 64;
  const topY = floorY - doorH;
  const angle = doorAngle(t);
  // frame
  ctx.strokeStyle = '#8a6d3b';
  ctx.lineWidth = 6;
  ctx.strokeRect(hingeX - 3, topY - 3, doorW + 6, doorH + 3);
  // door panel swinging around the hinge (fake perspective)
  const openW = Math.cos(angle) * doorW;
  const depth = Math.sin(angle) * 18;
  ctx.fillStyle = '#c08f4e';
  ctx.beginPath();
  ctx.moveTo(hingeX, topY);
  ctx.lineTo(hingeX + openW, topY + depth);
  ctx.lineTo(hingeX + openW, floorY + depth);
  ctx.lineTo(hingeX, floorY);
  ctx.closePath();
  ctx.fill();
  // knob
  ctx.fillStyle = '#f2d492';
  ctx.beginPath();
  ctx.arc(hingeX + openW * 0.85, topY + doorH * 0.55 + depth * 0.85, 4, 0, Math.PI * 2);
  ctx.fill();
}
