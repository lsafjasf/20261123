import { CAMERAS, clamp, lerp, type CameraId } from "./domain.ts";
import { sceneAt, type SceneState } from "./scenario.ts";

type Vec3 = readonly [number, number, number];

interface CameraView {
  eye: Vec3;
  target: Vec3;
  fov: number;
  grade: string;
}

const VIEWS: Record<CameraId, CameraView> = {
  1: { eye: [0, 3.6, 4.9], target: [0, 1.02, 0], fov: 43, grade: "#b9c9d4" },
  2: { eye: [-5.2, 2.75, 1.82], target: [0.15, 1.06, 0], fov: 40, grade: "#ffcf93" },
  3: { eye: [-3.9, 1.62, -2.08], target: [-0.18, 1.0, 0], fov: 45, grade: "#ffb890" },
  4: { eye: [3.9, 1.62, -2.08], target: [0.18, 1.0, 0], fov: 45, grade: "#a9e6ff" },
  5: { eye: [0.05, 1.12, -2.7], target: [0, 1.0, 0.08], fov: 50, grade: "#d8ff9e" },
  6: { eye: [0, 2.7, -4.65], target: [0, 0.98, 0], fov: 42, grade: "#efc2ff" },
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (value: Vec3): Vec3 => {
  const length = Math.hypot(value[0], value[1], value[2]) || 1;
  return [value[0] / length, value[1] / length, value[2] / length];
};

interface Projected {
  x: number;
  y: number;
  depth: number;
}

function makeProjector(view: CameraView, width: number, height: number) {
  const forward = norm(sub(view.target, view.eye));
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const focal = height / (2 * Math.tan((view.fov * Math.PI) / 360));
  return (point: Vec3): Projected | null => {
    const relative = sub(point, view.eye);
    const depth = dot(relative, forward);
    if (depth <= 0.12) return null;
    return {
      x: width / 2 + (dot(relative, right) * focal) / depth,
      y: height / 2 - (dot(relative, up) * focal) / depth,
      depth,
    };
  };
}

export function fitCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; width: number; height: number; dpr: number } {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || canvas.clientWidth || 640));
  const height = Math.max(1, Math.round(rect.height || canvas.clientHeight || 360));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height, dpr };
}

function pathProjected(
  ctx: CanvasRenderingContext2D,
  project: (point: Vec3) => Projected | null,
  points: Vec3[],
): boolean {
  const projected = points.map(project);
  if (projected.some((point) => point === null)) return false;
  ctx.beginPath();
  projected.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point!.x, point!.y);
    else ctx.lineTo(point!.x, point!.y);
  });
  ctx.closePath();
  return true;
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  project: (point: Vec3) => Projected | null,
  from: Vec3,
  to: Vec3,
): void {
  const a = project(from);
  const b = project(to);
  if (!a || !b) return;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawArena(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: CameraView,
  project: (point: Vec3) => Projected | null,
  scene: SceneState,
): void {
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#081118");
  sky.addColorStop(0.5, "#10232b");
  sky.addColorStop(1, "#071014");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(width * 0.52, height * 0.23, 4, width * 0.52, height * 0.23, height * 0.9);
  glow.addColorStop(0, `${view.grade}3c`);
  glow.addColorStop(0.34, "#4fb9c314");
  glow.addColorStop(1, "#00000000");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  for (let index = 0; index < 7; index += 1) {
    const x = width * (0.08 + index * 0.14);
    const beam = ctx.createLinearGradient(x, 0, x + width * 0.08, height * 0.6);
    beam.addColorStop(0, "rgba(206,245,255,0.10)");
    beam.addColorStop(1, "rgba(206,245,255,0)");
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + width * 0.035, 0);
    ctx.lineTo(x + width * 0.16, height * 0.72);
    ctx.lineTo(x + width * 0.02, height * 0.72);
    ctx.closePath();
    ctx.fill();
  }

  if (pathProjected(ctx, project, [
    [-7, 0, -6],
    [7, 0, -6],
    [7, 0, 6],
    [-7, 0, 6],
  ])) {
    const floor = ctx.createLinearGradient(0, height * 0.32, 0, height);
    floor.addColorStop(0, "#16323a");
    floor.addColorStop(1, "#071316");
    ctx.fillStyle = floor;
    ctx.fill();
  }

  ctx.strokeStyle = "rgba(156, 213, 221, 0.075)";
  ctx.lineWidth = 1;
  for (let x = -6; x <= 6; x += 1) drawLine(ctx, project, [x, 0.002, -5.5], [x, 0.002, 5.5]);
  for (let z = -5; z <= 5; z += 1) drawLine(ctx, project, [-6.5, 0.002, z], [6.5, 0.002, z]);

  const crowdBase = project([0, 0, -4.4]);
  if (crowdBase) {
    ctx.save();
    ctx.globalAlpha = 0.36;
    for (let index = 0; index < 80; index += 1) {
      const n = (index * 47) % 79;
      const world: Vec3 = [-6.2 + n * 0.158, 0.5 + (index % 5) * 0.18, -4.9 - (index % 3) * 0.18];
      const point = project(world);
      if (!point) continue;
      ctx.fillStyle = index % 9 === 0 ? view.grade : "#90a6aa";
      const radius = clamp(420 / point.depth, 0.5, 3.2);
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.fillStyle = "rgba(0,0,0,0.34)";
  if (pathProjected(ctx, project, [
    [-2.05, 0.018, -1.25],
    [2.05, 0.018, -1.25],
    [2.05, 0.018, 1.25],
    [-2.05, 0.018, 1.25],
  ])) ctx.fill();

  drawTable(ctx, project, width, height);
  drawNet(ctx, project);
  drawPlayers(ctx, project, scene);
  drawBall(ctx, project, scene);

  if (scene.pointPulse > 0) {
    const flash = ctx.createRadialGradient(width * 0.5, height * 0.45, 10, width * 0.5, height * 0.45, width * 0.7);
    flash.addColorStop(0, `rgba(190,255,183,${scene.pointPulse * 0.1})`);
    flash.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = flash;
    ctx.fillRect(0, 0, width, height);
  }
}

function drawTable(
  ctx: CanvasRenderingContext2D,
  project: (point: Vec3) => Projected | null,
  width: number,
  height: number,
): void {
  const top = 0.76;
  const corners: Vec3[] = [
    [-1.37, top, -0.7625],
    [1.37, top, -0.7625],
    [1.37, top, 0.7625],
    [-1.37, top, 0.7625],
  ];
  const legs: Array<[Vec3, Vec3]> = [
    [[-1.24, top, -0.63], [-1.24, 0.03, -0.63]],
    [[1.24, top, -0.63], [1.24, 0.03, -0.63]],
    [[1.24, top, 0.63], [1.24, 0.03, 0.63]],
    [[-1.24, top, 0.63], [-1.24, 0.03, 0.63]],
  ];

  ctx.save();
  ctx.strokeStyle = "#071014";
  ctx.lineWidth = Math.max(2, height * 0.011);
  ctx.lineCap = "round";
  for (const [from, to] of legs) drawLine(ctx, project, from, to);

  const sidePoints: Vec3[] = [
    [-1.37, 0.09, -0.7625],
    [1.37, 0.09, -0.7625],
    [-1.37, 0.09, 0.7625],
    [1.37, 0.09, 0.7625],
  ];
  if (pathProjected(ctx, project, [corners[0]!, corners[1]!, sidePoints[1]!, sidePoints[0]!])) {
    ctx.fillStyle = "#10221f";
    ctx.fill();
  }
  if (pathProjected(ctx, project, [corners[1]!, corners[2]!, sidePoints[3]!, sidePoints[1]!])) {
    ctx.fillStyle = "#0a1917";
    ctx.fill();
  }

  if (pathProjected(ctx, project, corners)) {
    const tableGradient = ctx.createLinearGradient(0, height * 0.2, 0, height * 0.9);
    tableGradient.addColorStop(0, "#1b6f66");
    tableGradient.addColorStop(0.52, "#10574f");
    tableGradient.addColorStop(1, "#0a3b36");
    ctx.fillStyle = tableGradient;
    ctx.fill();
    ctx.strokeStyle = "rgba(239,255,249,0.92)";
    ctx.lineWidth = Math.max(1.4, height * 0.005);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(232,255,248,0.64)";
  ctx.lineWidth = Math.max(0.8, height * 0.0022);
  drawLine(ctx, project, [-1.37, top + 0.002, 0], [1.37, top + 0.002, 0]);
  drawLine(ctx, project, [0, top + 0.002, -0.7625], [0, top + 0.002, 0.7625]);
  ctx.restore();
}

function drawNet(
  ctx: CanvasRenderingContext2D,
  project: (point: Vec3) => Projected | null,
): void {
  const bottom = 0.765;
  const top = 0.915;
  ctx.save();
  if (pathProjected(ctx, project, [
    [0, bottom, -0.86],
    [0, top, -0.86],
    [0, top, 0.86],
    [0, bottom, 0.86],
  ])) {
    ctx.fillStyle = "rgba(221, 241, 236, 0.13)";
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(225,244,239,0.3)";
  ctx.lineWidth = 0.8;
  for (let z = -0.82; z <= 0.82; z += 0.12) {
    drawLine(ctx, project, [0, bottom, z], [0, top, z]);
  }
  for (let y = bottom; y <= top; y += 0.035) {
    drawLine(ctx, project, [0, y, -0.86], [0, y, 0.86]);
  }
  ctx.strokeStyle = "rgba(250,255,252,0.94)";
  ctx.lineWidth = 2.4;
  drawLine(ctx, project, [0, top, -0.87], [0, top, 0.87]);
  drawLine(ctx, project, [0, bottom, -0.87], [0, bottom, -0.86]);
  drawLine(ctx, project, [0, bottom, 0.86], [0, bottom, 0.87]);
  ctx.restore();
}

interface Joints {
  head: Vec3;
  neck: Vec3;
  shoulderL: Vec3;
  shoulderR: Vec3;
  elbowL: Vec3;
  elbowR: Vec3;
  handL: Vec3;
  handR: Vec3;
  hipL: Vec3;
  hipR: Vec3;
  kneeL: Vec3;
  kneeR: Vec3;
  footL: Vec3;
  footR: Vec3;
}

function playerJoints(x: number, z: number, left: boolean, scene: SceneState): Joints {
  const attacking = (left && scene.ball.lastHitSide === "left") || (!left && scene.ball.lastHitSide === "right");
  const towardTable = left ? 1 : -1;
  const swing = attacking ? 0.36 : 0.12;
  const baseZ = z * 0.26;
  return {
    head: [x - towardTable * 0.08, 1.61, baseZ],
    neck: [x - towardTable * 0.07, 1.43, baseZ],
    shoulderL: [x, 1.36, baseZ - 0.21],
    shoulderR: [x, 1.36, baseZ + 0.21],
    elbowL: [x - towardTable * 0.1, 1.14, baseZ - 0.31],
    elbowR: [x + towardTable * 0.18, 1.18, baseZ + 0.28],
    handL: [x + towardTable * 0.18, 1.04, baseZ - 0.22],
    handR: [x + towardTable * (0.42 + swing), 1.22 - swing * 0.22, baseZ + 0.12],
    hipL: [x + towardTable * 0.03, 0.91, baseZ - 0.12],
    hipR: [x + towardTable * 0.03, 0.91, baseZ + 0.12],
    kneeL: [x + towardTable * 0.08, 0.48, baseZ - 0.22],
    kneeR: [x - towardTable * 0.06, 0.47, baseZ + 0.23],
    footL: [x + towardTable * 0.2, 0.03, baseZ - 0.29],
    footR: [x - towardTable * 0.12, 0.03, baseZ + 0.29],
  };
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  project: (point: Vec3) => Projected | null,
  joints: Joints,
  color: string,
  accent: string,
): void {
  const torso = [joints.shoulderL, joints.shoulderR, joints.hipR, joints.hipL].map(project);
  if (torso.every((point) => point !== null)) {
    const shoulderWidth = Math.hypot(torso[0]!.x - torso[1]!.x, torso[0]!.y - torso[1]!.y);
    const scale = clamp(shoulderWidth / 0.42, 5, 240);

    const leftFoot = project(joints.footL);
    if (leftFoot) {
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.36)";
      ctx.beginPath();
      ctx.ellipse(leftFoot.x, leftFoot.y + 2, scale * 0.52, scale * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const width = Math.max(1.2, 0.12 * scale);
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#11191d";
    ctx.lineWidth = width * 1.22;
    for (const [a, b, c] of [
      [joints.hipL, joints.kneeL, joints.footL],
      [joints.hipR, joints.kneeR, joints.footR],
    ] as Array<[Vec3, Vec3, Vec3]>) {
      const pa = project(a);
      const pb = project(b);
      const pc = project(c);
      if (!pa || !pb || !pc) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.lineTo(pc.x, pc.y);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(torso[0]!.x, torso[0]!.y);
    ctx.lineTo(torso[1]!.x, torso[1]!.y);
    ctx.lineTo(torso[2]!.x, torso[2]!.y);
    ctx.lineTo(torso[3]!.x, torso[3]!.y);
    ctx.closePath();
    const jersey = ctx.createLinearGradient(torso[0]!.x, torso[0]!.y, torso[2]!.x, torso[2]!.y);
    jersey.addColorStop(0, color);
    jersey.addColorStop(1, accent);
    ctx.fillStyle = jersey;
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth = width * 0.72;
    for (const [a, b, c] of [
      [joints.shoulderR, joints.elbowR, joints.handR],
      [joints.shoulderL, joints.elbowL, joints.handL],
    ] as Array<[Vec3, Vec3, Vec3]>) {
      const pa = project(a);
      const pb = project(b);
      const pc = project(c);
      if (!pa || !pb || !pc) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.lineTo(pc.x, pc.y);
      ctx.stroke();
    }

    const head = project(joints.head);
    const neck = project(joints.neck);
    if (head && neck) {
      const radius = Math.max(2, 0.135 * scale);
      ctx.strokeStyle = "#c9916c";
      ctx.lineWidth = width * 0.38;
      ctx.beginPath();
      ctx.moveTo(neck.x, neck.y);
      ctx.lineTo(head.x, head.y + radius * 0.7);
      ctx.stroke();
      ctx.fillStyle = "#dfb18d";
      ctx.beginPath();
      ctx.arc(head.x, head.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#182126";
      ctx.beginPath();
      ctx.arc(head.x, head.y - radius * 0.34, radius * 0.98, Math.PI, Math.PI * 2);
      ctx.fill();
    }

    const hand = project(joints.handR);
    if (hand) {
      ctx.fillStyle = "#f3d1b2";
      ctx.beginPath();
      ctx.arc(hand.x, hand.y, Math.max(1.2, width * 0.28), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#d84c45";
      ctx.lineWidth = Math.max(1.2, width * 0.24);
      ctx.beginPath();
      ctx.arc(hand.x + width * 0.18, hand.y - width * 0.27, Math.max(2.5, width * 0.55), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawPlayers(
  ctx: CanvasRenderingContext2D,
  project: (point: Vec3) => Projected | null,
  scene: SceneState,
): void {
  const left = playerJoints(scene.playerLeftX, scene.ball.z * 0.35, true, scene);
  const right = playerJoints(scene.playerRightX, scene.ball.z * -0.35, false, scene);
  const leftDepth = project(left.neck)?.depth ?? 99;
  const rightDepth = project(right.neck)?.depth ?? 99;
  const players =
    leftDepth > rightDepth
      ? [
          { joints: left, color: "#ff7b36", accent: "#b93822" },
          { joints: right, color: "#4ac8ed", accent: "#166481" },
        ]
      : [
          { joints: right, color: "#4ac8ed", accent: "#166481" },
          { joints: left, color: "#ff7b36", accent: "#b93822" },
        ];
  for (const player of players) drawPlayer(ctx, project, player.joints, player.color, player.accent);
}

function drawBall(
  ctx: CanvasRenderingContext2D,
  project: (point: Vec3) => Projected | null,
  scene: SceneState,
): void {
  const trail = [26, 18, 10].map((offset, index) => {
    const past = sceneAt(scene.t - offset);
    return { point: project([past.ball.x, past.ball.y, past.ball.z]), alpha: 0.12 + index * 0.08 };
  });
  for (const item of trail) {
    if (!item.point) continue;
    ctx.fillStyle = `rgba(247,255,215,${item.alpha})`;
    ctx.beginPath();
    ctx.arc(item.point.x, item.point.y, clamp(70 / item.point.depth, 1, 5), 0, Math.PI * 2);
    ctx.fill();
  }

  const shadow = project([scene.ball.x, 0.772, scene.ball.z]);
  if (shadow) {
    ctx.fillStyle = "rgba(0,0,0,0.38)";
    ctx.beginPath();
    ctx.ellipse(
      shadow.x,
      shadow.y,
      clamp(220 / shadow.depth, 1.5, 12),
      clamp(50 / shadow.depth, 0.7, 4),
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  const point = project([scene.ball.x, scene.ball.y, scene.ball.z]);
  if (!point) return;
  const radius = clamp(230 / point.depth, 1.6, 13);
  if (scene.ball.hitPulse > 0.08) {
    ctx.strokeStyle = `rgba(245,255,184,${scene.ball.hitPulse * 0.75})`;
    ctx.lineWidth = Math.max(1, radius * 0.35);
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius * (2.2 + scene.ball.hitPulse * 1.7), 0, Math.PI * 2);
    ctx.stroke();
  }
  const ballGlow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius * 2.5);
  ballGlow.addColorStop(0, "rgba(255,255,230,0.9)");
  ballGlow.addColorStop(0.4, "rgba(255,255,210,0.34)");
  ballGlow.addColorStop(1, "rgba(255,255,210,0)");
  ctx.fillStyle = ballGlow;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius * 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fffce3";
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

export function renderCamera(canvas: HTMLCanvasElement, camera: CameraId, timeMs: number): void {
  const { ctx, width, height } = fitCanvas(canvas);
  const view = VIEWS[camera] ?? VIEWS[1];
  const project = makeProjector(view, width, height);
  const scene = sceneAt(timeMs);

  ctx.save();
  drawArena(ctx, width, height, view, project, scene);

  const vignette = ctx.createRadialGradient(
    width * 0.5,
    height * 0.5,
    height * 0.12,
    width * 0.5,
    height * 0.5,
    width * 0.72,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(0.72, "rgba(0,0,0,0.08)");
  vignette.addColorStop(1, "rgba(0,0,0,0.54)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = "soft-light";
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = view.grade;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

export function renderCameraGrid(
  canvases: Map<CameraId, HTMLCanvasElement>,
  timeMs: number,
): void {
  for (const camera of CAMERAS) {
    const canvas = canvases.get(camera.id);
    if (canvas) renderCamera(canvas, camera.id, timeMs);
  }
}
