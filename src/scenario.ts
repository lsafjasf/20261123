import {
  CAMERAS,
  clamp,
  easeInOut,
  lerp,
  type CameraId,
  type ChannelMetrics,
} from "./domain.ts";

export const LOOP_MS = 36_000;
export const EXCHANGE_MS = 6_000;

export interface Exchange {
  index: number;
  startMs: number;
  focus: CameraId;
  winner: "left" | "right";
  label: string;
  hits: readonly number[];
}

export interface BallState {
  x: number;
  y: number;
  z: number;
  speed: number;
  hitPulse: number;
  lastHitSide: "left" | "right";
}

export interface SceneState {
  t: number;
  loopT: number;
  exchange: Exchange;
  ball: BallState;
  score: { left: number; right: number };
  pointPulse: number;
  winner: "left" | "right";
  playerLeftX: number;
  playerRightX: number;
  focus: CameraId;
}

const EXCHANGES: readonly Exchange[] = [
  {
    index: 0,
    startMs: 0,
    focus: 3,
    winner: "left",
    label: "林野反手拧拉得手",
    hits: [0.58, 1.27, 1.96, 2.65, 3.34, 4.03, 4.72],
  },
  {
    index: 1,
    startMs: 6_000,
    focus: 5,
    winner: "right",
    label: "周川网前抢攻",
    hits: [6.53, 7.19, 7.84, 8.51, 9.18, 9.86, 10.54],
  },
  {
    index: 2,
    startMs: 12_000,
    focus: 2,
    winner: "left",
    label: "林野正手变线",
    hits: [12.49, 13.14, 13.77, 14.42, 15.08, 15.72, 16.36],
  },
  {
    index: 3,
    startMs: 18_000,
    focus: 4,
    winner: "right",
    label: "周川侧身爆冲",
    hits: [18.55, 19.18, 19.82, 20.45, 21.09, 21.72, 22.34],
  },
  {
    index: 4,
    startMs: 24_000,
    focus: 6,
    winner: "left",
    label: "林野远台反拉",
    hits: [24.51, 25.16, 25.81, 26.47, 27.14, 27.8, 28.46],
  },
  {
    index: 5,
    startMs: 30_000,
    focus: 1,
    winner: "right",
    label: "周川发球抢攻",
    hits: [30.54, 31.18, 31.81, 32.44, 33.08, 33.71, 34.34],
  },
] as const;

const START_SCORE = { left: 8, right: 7 };

export function exchangeAt(t: number): Exchange {
  const loopT = ((t % LOOP_MS) + LOOP_MS) % LOOP_MS;
  return EXCHANGES[Math.floor(loopT / EXCHANGE_MS)] ?? EXCHANGES[0]!;
}

export function focusAt(t: number): CameraId {
  return exchangeAt(t).focus;
}

function hitAge(t: number, exchange: Exchange): { age: number; side: "left" | "right"; index: number } {
  const seconds = (((t % LOOP_MS) + LOOP_MS) % LOOP_MS) / 1000;
  let index = -1;
  for (let i = 0; i < exchange.hits.length; i += 1) {
    const hit = exchange.hits[i] ?? Number.POSITIVE_INFINITY;
    if (seconds >= hit) index = i;
  }
  if (index < 0) {
    return { age: 1, side: "left", index: -1 };
  }
  const hit = exchange.hits[index] ?? seconds;
  return { age: Math.max(0, seconds - hit), side: index % 2 === 0 ? "left" : "right", index };
}

export function sceneAt(t: number): SceneState {
  const loopT = ((t % LOOP_MS) + LOOP_MS) % LOOP_MS;
  const exchange = exchangeAt(loopT);
  const localMs = loopT - exchange.startMs;
  const local = localMs / 1000;
  const hit = hitAge(loopT, exchange);
  const nextHit = exchange.hits[hit.index + 1] ?? exchange.hits[exchange.hits.length - 1] ?? local;
  const currentHit = exchange.hits[hit.index] ?? 0;
  const travel = Math.max(0.2, nextHit - currentHit);
  const progress = clamp((local - currentHit) / travel, 0, 1);
  const eased = easeInOut(progress);
  const startSide = hit.index % 2 === 0 ? -1 : 1;
  const x = lerp(startSide * 1.26, -startSide * 1.26, eased);
  const arc = Math.sin(Math.PI * progress);
  const z = 0.27 * Math.sin(progress * Math.PI * 2 + exchange.index * 0.7);
  const y = 0.785 + arc * (0.58 + 0.06 * Math.sin(exchange.index));
  const rallyEnded = local > 5.14;
  const pointPulse = rallyEnded ? Math.max(0, 1 - (local - 5.14) / 0.72) : 0;
  const hitPulse = Math.exp(-hit.age / 0.075);
  const ball = {
    x: rallyEnded ? lerp(x, exchange.winner === "left" ? 2.15 : -2.15, 0.15) : x,
    y: rallyEnded ? Math.max(0.05, y - (local - 5.14) * 2.4) : y,
    z: rallyEnded ? lerp(z, 0.5, 0.2) : z,
    speed: 12 + 7 * arc,
    hitPulse,
    lastHitSide: hit.side,
  } satisfies BallState;

  let left = START_SCORE.left;
  let right = START_SCORE.right;
  for (const done of EXCHANGES) {
    if (done.startMs >= exchange.startMs) break;
    if (done.winner === "left") left += 1;
    else right += 1;
  }

  return {
    t,
    loopT,
    exchange,
    ball,
    score: { left, right },
    pointPulse,
    winner: exchange.winner,
    playerLeftX: -2.08 + Math.sin(loopT / 900) * 0.12 - (hit.side === "left" ? 0.08 : 0),
    playerRightX: 2.08 + Math.sin(loopT / 1020 + 1) * 0.12 + (hit.side === "right" ? 0.08 : 0),
    focus: exchange.focus,
  };
}

const pulse = (t: number, center: number, width: number): number => {
  const delta = Math.abs(t - center);
  return delta > width ? 0 : 1 - delta / width;
};

export function syntheticChannels(t: number): ChannelMetrics[] {
  const scene = sceneAt(t);
  const focus = scene.exchange.focus;
  const loopSeconds = scene.loopT / 1000;
  const exchangeSeconds = (scene.loopT - scene.exchange.startMs) / 1000;
  const localHits = exchangeAt(t).hits;
  let transient = 0;
  for (const hit of localHits) {
    transient = Math.max(transient, pulse(exchangeSeconds, hit, 0.075));
  }

  return CAMERAS.map((camera) => {
    const id = camera.id;
    const phase = id * 1.71;
    const texture =
      0.75 * Math.sin(loopSeconds * 3.1 + phase) +
      0.45 * Math.sin(loopSeconds * 7.7 + phase * 0.61) +
      0.28 * Math.sin(loopSeconds * 17.3 + phase * 1.37);
    let energy = -43.5 + texture * 1.7;

    if (id === focus) energy += 13.4;
    else if (id === 1) energy += 2.4;
    else if (id === 5) energy += 1.1;
    else if (id === 6 && scene.pointPulse > 0.1) energy += 4.8 * scene.pointPulse;
    else if ((id === 3 || id === 4) && Math.abs(scene.ball.x) > 0.75) energy += 1.6;

    if (id === focus) energy += transient * 9.5 + scene.pointPulse * 5.5;
    else energy += transient * (id === 5 ? 2.6 : 0.8);

    const onset =
      transient * (id === focus ? 0.95 : id === 5 ? 0.42 : 0.12) +
      (scene.pointPulse > 0.8 ? 0.16 : 0);

    return {
      camera: id,
      energyDb: clamp(energy, -72, -6),
      onset: clamp(onset, 0, 1),
    };
  });
}

export function exchangeSummary(t: number): string {
  return sceneAt(t).exchange.label;
}
