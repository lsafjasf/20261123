export type CameraId = 1 | 2 | 3 | 4 | 5 | 6;

export interface CameraSpec {
  id: CameraId;
  code: string;
  name: string;
  detail: string;
  color: string;
  role: "wide" | "main" | "left" | "right" | "net" | "reverse";
}

export const CAMERAS: readonly CameraSpec[] = [
  {
    id: 1,
    code: "CAM 1",
    name: "全景",
    detail: "高台 · 全场关系",
    color: "#9fb0c3",
    role: "wide",
  },
  {
    id: 2,
    code: "CAM 2",
    name: "主机位",
    detail: "正拍 · 战术线",
    color: "#ffd166",
    role: "main",
  },
  {
    id: 3,
    code: "CAM 3",
    name: "左底线",
    detail: "林野 · 近身声",
    color: "#ff8a4c",
    role: "left",
  },
  {
    id: 4,
    code: "CAM 4",
    name: "右底线",
    detail: "周川 · 近身声",
    color: "#58d6ff",
    role: "right",
  },
  {
    id: 5,
    code: "CAM 5",
    name: "网侧",
    detail: "低机位 · 击球点",
    color: "#b8f35b",
    role: "net",
  },
  {
    id: 6,
    code: "CAM 6",
    name: "反打",
    detail: "观众席 · 气氛",
    color: "#e891ff",
    role: "reverse",
  },
] as const;

export function getCamera(id: CameraId): CameraSpec {
  return CAMERAS[id - 1] ?? CAMERAS[0]!;
}

export type ChannelMetrics = {
  camera: CameraId;
  energyDb: number;
  onset: number;
};

export type EvidenceFrame = {
  t: number;
  channels: ChannelMetrics[];
  scores: number[];
  leader: CameraId;
  runnerUp: CameraId;
  leadMarginDb: number;
  candidate: CameraId;
};

export type EngineMode = "auto" | "assist";

export interface EngineConfig {
  minDwellMs: number;
  hysteresisDb: number;
  confirmMs: number;
  leaderMarginDb: number;
  onsetBoost: number;
  mode: EngineMode;
}

export const DEFAULT_CONFIG: EngineConfig = {
  minDwellMs: 2400,
  hysteresisDb: 4.5,
  confirmMs: 650,
  leaderMarginDb: 2.5,
  onsetBoost: 5,
  mode: "auto",
};

export type EnginePhase = "watching" | "confirming" | "dwell" | "ready" | "locked";

export interface EngineSnapshot {
  current: CameraId;
  candidate: CameraId | null;
  pendingMs: number;
  dwellRemainingMs: number;
  phase: EnginePhase;
  confidence: number;
  reason: string;
}

export interface SwitchDecision {
  id: string;
  t: number;
  from: CameraId;
  to: CameraId;
  kind: "auto" | "suggestion";
  confidence: number;
  sustainedMs: number;
  onsetPeak: number;
  reason: string;
  config: EngineConfig;
  frame: EvidenceFrame;
}

export type SessionEventKind = "auto-cut" | "suggestion" | "manual-cut" | "marker" | "undo";

export interface SessionEvent {
  id: string;
  t: number;
  kind: SessionEventKind;
  camera: CameraId;
  from?: CameraId;
  confidence?: number;
  reason?: string;
  label?: string;
  note?: string;
  undone?: boolean;
  evidence?: EvidenceFrame[];
  config?: EngineConfig;
}

export const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

export const lerp = (a: number, b: number, amount: number): number => a + (b - a) * amount;

export const easeInOut = (value: number): number => value * value * (3 - 2 * value);

export const dbToGain = (db: number): number => 10 ** (db / 20);

export const gainToDb = (gain: number): number => 20 * Math.log10(Math.max(gain, 1e-7));

export function formatDb(value: number, signed = true): string {
  if (!Number.isFinite(value)) return "−∞";
  return `${signed && value > 0 ? "+" : ""}${value.toFixed(1)} dB`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function eventId(prefix: string, now: number): string {
  return `${prefix}-${Math.floor(now).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
