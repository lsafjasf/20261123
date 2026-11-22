import {
  CAMERAS,
  DEFAULT_CONFIG,
  clamp,
  formatClock,
  getCamera,
  type CameraId,
  type ChannelMetrics,
  type EngineConfig,
  type EngineSnapshot,
  type EvidenceFrame,
  type SessionEvent,
  type SwitchDecision,
} from "./domain.ts";
import { RecommendationEngine } from "./engine.ts";
import { sceneAt, syntheticChannels } from "./scenario.ts";
import { AudioHub } from "./audio.ts";
import { drawEnergyChart } from "./charts.ts";
import { renderCamera, renderCameraGrid } from "./renderer.ts";

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function child<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element as T;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function formatDb(value: number, signed = true): string {
  if (!Number.isFinite(value)) return "−∞";
  return `${signed && value > 0 ? "+" : ""}${value.toFixed(1)} dB`;
}

function formatTimecode(ms: number): string {
  const safe = Math.max(0, ms);
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const tenths = Math.floor((safe % 1000) / 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

const startedAt = performance.now();
const nowMs = (): number => performance.now() - startedAt;
const STORAGE_KEY = "sixcue.guardrails.v1";

const programCanvas = must<HTMLCanvasElement>("program-canvas");
const replayCanvas = must<HTMLCanvasElement>("replay-canvas");
const energyCanvas = must<HTMLCanvasElement>("energy-chart");
const evidenceCanvas = must<HTMLCanvasElement>("evidence-chart");
const programFlash = must<HTMLElement>("program-flash");
const cueRing = must<HTMLElement>("cue-ring");
const cueIdle = must<HTMLElement>("cue-idle");
const cueLive = must<HTMLElement>("cue-live");
const takeoverRibbon = must<HTMLElement>("takeover-ribbon");
const reviewDialog = must<HTMLDialogElement>("review-dialog");
const markerDialog = must<HTMLDialogElement>("marker-dialog");
const markerForm = must<HTMLFormElement>("marker-form");
const markerNote = must<HTMLTextAreaElement>("marker-note");
const reviewList = must<HTMLElement>("review-list");
const cueTrack = must<HTMLElement>("cue-track");
const markerTrack = must<HTMLElement>("marker-track");
const audioToggle = must<HTMLButtonElement>("audio-toggle");
const audioToggleLabel = must<HTMLElement>("audio-toggle-label");
const takeoverButton = must<HTMLButtonElement>("takeover-btn");
const undoButton = must<HTMLButtonElement>("undo-btn");
const acceptButton = must<HTMLButtonElement>("accept-btn");
const dismissButton = must<HTMLButtonElement>("dismiss-btn");
const replayPlayButton = must<HTMLButtonElement>("replay-play");
const auditionButton = must<HTMLButtonElement>("audition-btn");

const cameraCanvases = new Map<CameraId, HTMLCanvasElement>();
const cameraCards = new Map<CameraId, HTMLButtonElement>();
document.querySelectorAll<HTMLCanvasElement>("[data-camera-canvas]").forEach((canvas) => {
  const id = Number(canvas.dataset.cameraCanvas) as CameraId;
  cameraCanvases.set(id, canvas);
});
document.querySelectorAll<HTMLButtonElement>("[data-camera]").forEach((card) => {
  const id = Number(card.dataset.camera) as CameraId;
  cameraCards.set(id, card);
});

function readConfig(): EngineConfig {
  let saved: Partial<EngineConfig> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) saved = JSON.parse(raw) as Partial<EngineConfig>;
  } catch {
    saved = {};
  }
  const numeric = (value: unknown, fallback: number, low: number, high: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? clamp(parsed, low, high) : fallback;
  };
  return {
    ...DEFAULT_CONFIG,
    minDwellMs: numeric(saved.minDwellMs, DEFAULT_CONFIG.minDwellMs, 1200, 5000),
    hysteresisDb: numeric(saved.hysteresisDb, DEFAULT_CONFIG.hysteresisDb, 1.5, 9),
    confirmMs: numeric(saved.confirmMs, DEFAULT_CONFIG.confirmMs, 200, 1500),
    mode: saved.mode === "assist" ? "assist" : "auto",
  };
}

let config = readConfig();
const audio = new AudioHub();
const engine = new RecommendationEngine(1, config);
let currentCamera: CameraId = 1;
let paused = false;
let activeCue: SwitchDecision | null = null;
let latestFrame: EvidenceFrame | null = null;
let latestChannels: ChannelMetrics[] = CAMERAS.map((camera) => ({
  camera: camera.id,
  energyDb: -48,
  onset: 0,
}));
let engineSnapshot: EngineSnapshot = engine.snapshot;
let evidenceRing: EvidenceFrame[] = [];
let events: SessionEvent[] = [];
let detectedOnsets = 0;
let lastOnsetAt = -1000;
let leader: CameraId | null = null;
let leaderSince = 0;
let audioStarting = false;
let lastAudioStartAt = -10_000;
let lastProgramRender = -1;
let lastPreviewRender = -1;
let lastUiUpdate = -1;
let lastChartDraw = -1;
let lastTimelineDraw = -1;
let lastScoreDraw = -1;
let markerAt = 0;
let markerCamera: CameraId = 1;
let eventSequence = 0;
let toastSequence = 0;
let selectedReview: SessionEvent | null = null;
let reviewPlaying = false;
let reviewPosition = 0;
let reviewStartPosition = 0;
let reviewStartedWall = 0;
let reviewWindowStart = 0;
let reviewWindowEnd = 0;

const minDwellInput = must<HTMLInputElement>("min-dwell");
const hysteresisInput = must<HTMLInputElement>("hysteresis");
const confirmInput = must<HTMLInputElement>("confirm");

function saveConfig(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Private browsing can reject storage; the session still runs.
  }
}

function syncConfigControls(): void {
  minDwellInput.value = String(config.minDwellMs);
  hysteresisInput.value = String(config.hysteresisDb);
  confirmInput.value = String(config.confirmMs);
  setText("min-dwell-value", `${(config.minDwellMs / 1000).toFixed(1)}s`);
  setText("hysteresis-value", `${config.hysteresisDb.toFixed(1)} dB`);
  setText("confirm-value", `${Math.round(config.confirmMs)}ms`);
  setText("idle-dwell", `${(config.minDwellMs / 1000).toFixed(1)}s`);
  setText("resume-auto-inline", config.mode === "auto" ? "恢复自动" : "恢复提示");
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
    const active = button.dataset.mode === config.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function toast(message: string, warn = false): void {
  const stack = must<HTMLElement>("toast-stack");
  const element = node("div", `toast${warn ? " is-warn" : ""}`, message);
  element.dataset.toast = String(++toastSequence);
  stack.append(element);
  window.setTimeout(() => {
    element.style.opacity = "0";
    window.setTimeout(() => element.remove(), 240);
  }, 2800);
}

function snapshotEvidence(center: number, before = 2400, after = 2400): EvidenceFrame[] {
  return evidenceRing
    .filter((frame) => frame.t >= center - before && frame.t <= center + after)
    .map((frame) => ({ ...frame, channels: frame.channels.map((channel) => ({ ...channel })) }));
}

function appendFutureEvidence(now: number): void {
  if (!latestFrame) return;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.t < now - 3000) break;
    if (!event.evidence || event.kind === "undo" || now > event.t + 2500) continue;
    const last = event.evidence[event.evidence.length - 1];
    if (!last || latestFrame.t > last.t + 1) {
      event.evidence.push({
        ...latestFrame,
        channels: latestFrame.channels.map((channel) => ({ ...channel })),
      });
    }
  }
}

function addEvent(
  kind: SessionEvent["kind"],
  camera: CameraId,
  extra: {
    t?: number;
    from?: CameraId;
    confidence?: number;
    reason?: string;
    label?: string;
    note?: string;
  } = {},
): SessionEvent {
  const t = extra.t ?? nowMs();
  const event: SessionEvent = {
    id: `event-${++eventSequence}`,
    t,
    kind,
    camera,
    from: extra.from,
    confidence: extra.confidence,
    reason: extra.reason,
    label: extra.label,
    note: extra.note,
    config: { ...config },
    evidence: snapshotEvidence(t),
  };
  events.push(event);
  if (events.length > 260) events.splice(0, events.length - 260);
  return event;
}

function eventKindName(event: SessionEvent): string {
  switch (event.kind) {
    case "suggestion":
      return "声场建议";
    case "auto-cut":
      return "自动切换";
    case "manual-cut":
      return "导播切换";
    case "marker":
      return "导播标记";
    case "undo":
      return "撤销";
  }
}

function eventTitle(event: SessionEvent): string {
  const camera = getCamera(event.camera);
  switch (event.kind) {
    case "suggestion":
      return `建议 ${camera.code} · ${camera.name}`;
    case "auto-cut":
      return `自动切至 ${camera.code} · ${camera.name}`;
    case "manual-cut":
      return event.label ?? `切至 ${camera.code} · ${camera.name}`;
    case "marker":
      return `${event.label ?? "精彩球"} · ${camera.code}`;
    case "undo":
      return `撤销回到 ${camera.code}`;
  }
}

function eventReason(event: SessionEvent): string {
  if (event.note) return event.note;
  if (event.reason) return event.reason;
  if (event.kind === "marker") return "导播手动固定了该时刻的六通道声场。";
  if (event.kind === "undo") return "已撤销上一次切换并进入手动接管。";
  return "手动切换，已记录当时声场。";
}

function flashProgram(): void {
  programFlash.classList.add("is-flashing");
  window.setTimeout(() => programFlash.classList.remove("is-flashing"), 90);
}

function updateAudioState(): void {
  const live = audio.live;
  const state = must<HTMLElement>("audio-state");
  state.classList.toggle("is-live", live);
  state.innerHTML = "";
  state.append(node("i"), document.createTextNode(live ? " LIVE · 6CH" : audioStarting ? " 接入中" : " 离线回退"));
  audioToggle.setAttribute("aria-pressed", String(live && audio.enabled));
  const label = live
    ? audio.enabled
      ? "现场声开启"
      : "现场声静音"
    : audioStarting
      ? "接入现场声…"
      : "启用现场声";
  audioToggleLabel.textContent = label;
  audioToggle.setAttribute("aria-label", label);
  setText("mix-mode", live ? "WEB AUDIO" : "OFFLINE");
}

async function ensureAudio(): Promise<void> {
  if (audio.live || audioStarting) return;
  audioStarting = true;
  updateAudioState();
  const started = await audio.start(nowMs());
  audioStarting = false;
  updateAudioState();
  if (started) {
    lastAudioStartAt = nowMs();
    toast("六路现场声已接入，分析在本机完成");
  } else {
    toast("浏览器未允许音频启动，继续使用离线声学模型", true);
  }
}

function setTakeover(value: boolean, announce = true): void {
  paused = value;
  engine.setPaused(value);
  takeoverRibbon.hidden = !value;
  const label = child<HTMLElement>(takeoverButton, "span:last-child");
  label.textContent = value ? (config.mode === "auto" ? "恢复自动" : "恢复提示") : "接管";
  takeoverButton.classList.toggle("is-active", value);
  if (value) activeCue = null;
  if (announce) {
    toast(value ? "导播已接管，声场建议仅提示" : `已恢复${config.mode === "auto" ? "自动" : "提示"}建议`);
  }
}

function takeCamera(camera: CameraId, source = "manual"): void {
  void ensureAudio();
  const t = nowMs();
  const from = currentCamera;
  if (camera !== currentCamera) {
    engine.manualTake(camera, t);
    currentCamera = camera;
    const spec = getCamera(camera);
    addEvent("manual-cut", camera, {
      t,
      from,
      label: source === "accepted" ? "采纳声场建议" : `手动切至 ${spec.code}`,
      reason:
        source === "accepted"
          ? `导播采纳声场建议，从 ${getCamera(from).code} 切至 ${spec.code}。`
          : `导播手动接管并切至 ${spec.code} · ${spec.name}。`,
    });
    flashProgram();
    toast(`已切至 ${spec.code} · ${spec.name}`);
  }
  if (!paused && source !== "accepted") setTakeover(true);
  activeCue = null;
}

function handleDecision(decision: SwitchDecision): void {
  if (decision.onsetPeak < 0.05 && !audio.live) {
    const modeled = modeledOnsetPeak(decision.to, decision.t);
    if (modeled > decision.onsetPeak) {
      decision.onsetPeak = modeled;
      decision.reason = decision.reason.replace(/起音\s+\d+%/, `起音 ${Math.round(modeled * 100)}%`);
    }
  }
  activeCue = decision;
  const target = getCamera(decision.to);
  if (decision.kind === "auto") {
    currentCamera = decision.to;
    addEvent("auto-cut", decision.to, {
      t: decision.t,
      from: decision.from,
      confidence: decision.confidence,
      reason: decision.reason,
      label: `自动切至 ${target.code}`,
    });
    flashProgram();
    toast(`自动切换 ${target.code} · ${target.name}，置信度 ${Math.round(decision.confidence * 100)}%`);
  } else {
    addEvent("suggestion", decision.to, {
      t: decision.t,
      from: decision.from,
      confidence: decision.confidence,
      reason: decision.reason,
      label: `建议切至 ${target.code}`,
    });
    toast(`声场建议 ${target.code} · ${target.name}，等待导播采纳`);
  }
}

function sampleMetrics(t: number): ChannelMetrics[] {
  const live = audio.read();
  if (live && Math.max(...live.map((channel) => channel.energyDb)) > -80) return live;
  return syntheticChannels(t);
}

function processEngineTick(t: number): void {
  latestChannels = sampleMetrics(t);
  const result = engine.tick(latestChannels, t);
  latestFrame = result.frame;
  engineSnapshot = result.snapshot;
  currentCamera = engine.programCamera;
  evidenceRing.push(result.frame);

  if (result.frame.leader !== leader) {
    leader = result.frame.leader;
    leaderSince = t;
  }
  if (Math.max(...result.frame.channels.map((channel) => channel.onset)) > 0.46 && t - lastOnsetAt > 160) {
    detectedOnsets += 1;
    lastOnsetAt = t;
  }
  appendFutureEvidence(t);
  if (evidenceRing.length > 2300) {
    evidenceRing = evidenceRing.filter((frame) => frame.t >= t - 96_000);
  }
  if (result.decision) handleDecision(result.decision);
}

interface DisplayCue {
  camera: CameraId;
  confidence: number;
  reason: string;
  frame: EvidenceFrame;
  autoApplied: boolean;
  fromDecision: boolean;
  onsetPeak: number;
  sustainedMs: number;
}

function recentOnsetPeak(camera: CameraId, t: number): number {
  let peak = 0;
  for (let index = evidenceRing.length - 1; index >= 0; index -= 1) {
    const frame = evidenceRing[index]!;
    if (frame.t < t - 1800) break;
    const channel = frame.channels.find((item) => item.camera === camera);
    if (channel && channel.onset > peak) peak = channel.onset;
  }
  return peak;
}

const modelOnsetCache = new Map<string, number>();
function modeledOnsetPeak(camera: CameraId, t: number): number {
  const bucket = Math.floor(t / 250);
  const key = `${camera}:${bucket}`;
  const cached = modelOnsetCache.get(key);
  if (cached !== undefined) return cached;
  let peak = 0;
  for (let offset = 0; offset <= 1800; offset += 30) {
    const channel = syntheticChannels(t - offset).find((item) => item.camera === camera);
    if (channel && channel.onset > peak) peak = channel.onset;
  }
  if (modelOnsetCache.size > 80) modelOnsetCache.clear();
  modelOnsetCache.set(key, peak);
  return peak;
}

function currentDisplayCue(t: number): DisplayCue | null {
  if (activeCue?.kind === "auto" && t - activeCue.t > 5200) activeCue = null;
  const candidate = engineSnapshot.candidate;
  if (activeCue && (!candidate || candidate === activeCue.to)) {
    return {
      camera: activeCue.to,
      confidence: activeCue.confidence,
      reason: activeCue.reason,
      frame: activeCue.frame,
      autoApplied: activeCue.kind === "auto" && currentCamera === activeCue.to,
      fromDecision: true,
      onsetPeak: activeCue.onsetPeak,
      sustainedMs: activeCue.sustainedMs,
    };
  }
  if (!candidate || !latestFrame) return null;
  return {
    camera: candidate,
    confidence: engineSnapshot.confidence,
    reason: engineSnapshot.reason,
    frame: latestFrame,
    autoApplied: false,
    fromDecision: false,
    onsetPeak: Math.max(
      recentOnsetPeak(candidate, t),
      audio.live ? 0 : modeledOnsetPeak(candidate, t),
    ),
    sustainedMs: engineSnapshot.pendingMs,
  };
}

function leadFor(frame: EvidenceFrame, camera: CameraId): number {
  const channel = frame.channels.find((item) => item.camera === camera);
  if (!channel) return 0;
  const other = Math.max(
    ...frame.channels.filter((item) => item.camera !== camera).map((item) => item.energyDb),
  );
  return channel.energyDb - other;
}

function updateCuePanel(t: number): void {
  const cue = currentDisplayCue(t);
  cueIdle.hidden = Boolean(cue);
  cueLive.hidden = !cue;
  if (!cue) {
    setText(
      "idle-reason",
      paused ? "导播已接管，声场建议仅保留在时间线" : engineSnapshot.reason,
    );
    setText("idle-dwell", `${(config.minDwellMs / 1000).toFixed(1)}s`);
    cameraCards.forEach((card, id) => card.classList.toggle("is-suggested", false));
    return;
  }

  const spec = getCamera(cue.camera);
  const lead = leadFor(cue.frame, cue.camera);
  const confidence = Math.round(cue.confidence * 100);
  setText("cue-kicker", cue.autoApplied ? "已自动切至" : "建议切至");
  setText("cue-camera-code", spec.code);
  setText("cue-camera-name", spec.name);
  setText("cue-confidence", String(confidence));
  cueRing.style.setProperty("--confidence", `${confidence}%`);
  setText("cue-reason", cue.reason);
  setText("cue-lead", formatDb(lead));
  setText("cue-onset", `${Math.round(cue.onsetPeak * 100)}%`);
  setText("cue-sustain", `${Math.max(0, cue.sustainedMs / 1000).toFixed(1)}s`);

  let phaseLabel = "稳定确认";
  let fill = 0;
  if (cue.autoApplied) {
    phaseLabel = "切换完成";
    fill = 100;
    setText("cue-state", "ON AIR");
  } else if (paused) {
    phaseLabel = "手动接管";
    setText("cue-state", "仅提示");
  } else if (engineSnapshot.phase === "dwell") {
    phaseLabel = "最短停留";
    fill = 100 - (engineSnapshot.dwellRemainingMs / Math.max(1, config.minDwellMs)) * 100;
    setText("cue-state", "等待停留");
  } else if (engineSnapshot.phase === "confirming") {
    phaseLabel = "稳定确认";
    fill = (engineSnapshot.pendingMs / Math.max(1, config.confirmMs)) * 100;
    setText("cue-state", "确认中");
  } else {
    phaseLabel = "可以切换";
    fill = 100;
    setText("cue-state", cue.fromDecision ? "待采纳" : "可切换");
  }
  setText("dwell-label", phaseLabel);
  setText(
    "dwell-value",
    cue.autoApplied
      ? "已满足条件"
      : `${Math.max(0, engineSnapshot.pendingMs / 1000).toFixed(1)} / ${(config.confirmMs / 1000).toFixed(2)}s`,
  );
  const dwellFill = document.getElementById("dwell-fill");
  if (dwellFill) dwellFill.style.width = `${clamp(fill, 0, 100)}%`;

  acceptButton.textContent = "";
  acceptButton.append(document.createTextNode(cue.autoApplied ? "回看证据" : "采纳切换 "), node("span", undefined, "↵"));
  dismissButton.hidden = cue.autoApplied;
  setText(
    "cue-footnote",
    cue.autoApplied
      ? "自动模式：满足护栏后已直接切换"
      : paused
        ? "手动接管中：建议不会自动执行"
        : config.mode === "assist"
          ? "提示模式：导播确认后才会切换"
          : "自动模式：满足条件后直接切换",
  );
  cameraCards.forEach((card, id) => card.classList.toggle("is-suggested", id === cue.camera && id !== currentCamera));
}

function updateProgramChrome(t: number): void {
  const scene = sceneAt(t);
  const spec = getCamera(currentCamera);
  setText("session-clock", formatClock(t));
  setText("score-left", String(scene.score.left));
  setText("score-right", String(scene.score.right));
  setText("program-camera-code", spec.code);
  setText("program-camera-name", spec.name);
  setText("program-scene-label", scene.exchange.label);
  setText("transport-camera", `${spec.code} · ${spec.name}`);
  setText("transport-tag", scene.exchange.label);
  setText("latency-readout", String(34 + Math.round((Math.sin(t / 1700) + 1) * 3)));

  const cue = currentDisplayCue(t);
  const focus = cue?.camera ?? engineSnapshot.candidate ?? latestFrame?.leader ?? currentCamera;
  const focusSpec = getCamera(focus);
  const focusLead = latestFrame ? leadFor(latestFrame, focus) : 0;
  setText("focus-chip-camera", focusSpec.code);
  setText("focus-chip-db", formatDb(focusLead));
  setText("program-cue-text", cue && cue.camera !== currentCamera ? `${focusSpec.code} 为声场焦点 · ${cue.autoApplied ? "已切换" : "建议待定"}` : "焦点稳定 · 无需切换");

  if (paused) {
    setText("program-cue-text", "手动接管 · 声场建议仅提示");
  } else if (engineSnapshot.phase === "dwell") {
    setText("program-cue-text", `最短停留剩余 ${(engineSnapshot.dwellRemainingMs / 1000).toFixed(1)}s`);
  } else if (engineSnapshot.phase === "confirming") {
    setText("program-cue-text", `确认 ${focusSpec.code} 的持续领先`);
  }
}

function updateCameraCards(): void {
  for (const camera of CAMERAS) {
    const card = cameraCards.get(camera.id);
    const channel = latestChannels.find((item) => item.camera === camera.id);
    const energy = channel?.energyDb ?? -60;
    const level = clamp(((energy + 58) / 48) * 100, 3, 100);
    if (card) {
      card.classList.toggle("is-live", camera.id === currentCamera);
      const onAir = card.querySelector<HTMLElement>(".camera-on-air");
      if (onAir) onAir.textContent = "ON AIR";
    }
    setText(`meter-${camera.id}`, energy.toFixed(1).replace("-", "−"));
    const bar = document.getElementById(`bar-${camera.id}`);
    if (bar) {
      bar.style.width = `${level}%`;
      bar.style.background = `linear-gradient(90deg, ${camera.color}, var(--amber))`;
    }
  }
}

function buildLegend(): void {
  const legend = must<HTMLElement>("channel-legend");
  legend.replaceChildren();
  for (const camera of CAMERAS) {
    const item = node("div", "legend-channel");
    const dot = node("i");
    dot.style.background = camera.color;
    const label = node("span", undefined, `${camera.code.replace("CAM ", "C")} ${camera.name}`);
    const level = node("b", undefined, "−42.0");
    level.id = `legend-db-${camera.id}`;
    item.append(dot, label, level);
    legend.append(item);
  }
}

function updateAudioPanel(t: number): void {
  updateAudioState();
  const focus = engineSnapshot.candidate ?? latestFrame?.leader ?? currentCamera;
  if (t - lastChartDraw > 110) {
    const frames = evidenceRing.filter((frame) => frame.t >= t - 8500);
    drawEnergyChart(energyCanvas, frames, {
      highlight: focus,
      showOnsets: true,
    });
    lastChartDraw = t;
  }
  for (const camera of CAMERAS) {
    const channel = latestChannels.find((item) => item.camera === camera.id);
    setText(`legend-db-${camera.id}`, (channel?.energyDb ?? -60).toFixed(1).replace("-", "−"));
    const legend = document.getElementById(`legend-db-${camera.id}`)?.parentElement;
    legend?.classList.toggle("is-focus", camera.id === focus);
  }
  setText("detected-count", String(detectedOnsets));
  setText("lead-duration", `${(leader ? Math.max(0, t - leaderSince) / 1000 : 0).toFixed(1)}s`);
  const loudest = Math.max(...latestChannels.map((channel) => channel.energyDb));
  setText("master-db", loudest.toFixed(1).replace("-", "−"));
  const master = document.querySelector<HTMLElement>(".master-meter i");
  if (master) master.style.width = `${clamp(((loudest + 60) / 48) * 100, 2, 100)}%`;
}

function undoableEvent(): SessionEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if ((event.kind === "auto-cut" || event.kind === "manual-cut") && !event.undone) return event;
  }
  return undefined;
}

function buildTimelineAxis(): void {
  const ticks = must<HTMLElement>("axis-ticks");
  ticks.replaceChildren();
  for (let index = 0; index < 6; index += 1) {
    const seconds = 90 - index * 15;
    const tick = node("span", undefined, `−${seconds}s`);
    tick.style.left = `${(index / 6) * 100}%`;
    ticks.append(tick);
  }
}

function renderTimeline(t: number): void {
  const windowMs = 90_000;
  cueTrack.replaceChildren();
  markerTrack.replaceChildren();
  for (const event of events) {
    if (event.t < t - windowMs - 1000) continue;
    const percent = clamp(100 - ((t - event.t) / windowMs) * 100, 0.7, 99.3);
    const button = node("button", `timeline-event kind-${event.kind}`);
    button.type = "button";
    button.style.left = `${percent}%`;
    button.dataset.eventId = event.id;
    button.title = `${formatClock(event.t)} · ${eventTitle(event)}`;
    button.setAttribute("aria-label", `${formatClock(event.t)} ${eventTitle(event)}`);
    (event.kind === "marker" ? markerTrack : cueTrack).append(button);
  }
  const suggestionCount = events.filter(
    (event) => event.kind === "suggestion" || event.kind === "auto-cut",
  ).length;
  const cutCount = events.filter(
    (event) => event.kind === "auto-cut" || event.kind === "manual-cut",
  ).length;
  const markerCount = events.filter((event) => event.kind === "marker").length;
  setText("count-suggestions", String(suggestionCount));
  setText("count-cuts", String(cutCount));
  setText("count-markers", String(markerCount));
  undoButton.disabled = !undoableEvent();

  const latest = [...events].reverse().find((event) => event.t >= t - windowMs);
  if (latest) {
    const readout = must<HTMLElement>("timeline-readout");
    const time = child<HTMLElement>(readout, ".readout-time");
    const text = child<HTMLElement>(readout, ".readout-text");
    time.textContent = formatClock(latest.t);
    text.textContent = `${eventTitle(latest)} · ${eventReason(latest)}`;
  } else {
    const readout = must<HTMLElement>("timeline-readout");
    child<HTMLElement>(readout, ".readout-time").textContent = "--:--";
    child<HTMLElement>(readout, ".readout-text").textContent = "等待第一条声场建议";
  }
}

function evidenceEventList(): SessionEvent[] {
  return [...events]
    .filter((event) => event.kind !== "undo" && (event.evidence?.length ?? 0) > 0)
    .sort((a, b) => b.t - a.t);
}

function renderReviewList(): void {
  const list = evidenceEventList();
  setText("review-count", String(list.length));
  reviewList.replaceChildren();
  for (const event of list) {
    const button = node("button", "review-item");
    button.type = "button";
    button.dataset.eventId = event.id;
    button.classList.toggle("is-active", selectedReview?.id === event.id);
    const head = node("div", "review-item-head");
    head.append(
      node("span", undefined, formatClock(event.t)),
      node(
        "span",
        undefined,
        event.confidence !== undefined
          ? `${Math.round(event.confidence * 100)}%`
          : event.kind === "marker"
            ? "MARK"
            : "手动",
      ),
    );
    const title = node("strong", undefined, eventTitle(event));
    const detail = node("p", undefined, eventReason(event));
    button.append(head, title, detail);
    reviewList.append(button);
  }
}

function setEvidenceLegend(camera: CameraId): void {
  const legend = must<HTMLElement>("evidence-legend");
  legend.replaceChildren();
  for (const item of CAMERAS) {
    const channel = node("div", `legend-channel${item.id === camera ? " is-focus" : ""}`);
    const dot = node("i");
    dot.style.background = item.color;
    channel.append(dot, node("span", undefined, `${item.code} ${item.name}`));
    legend.append(channel);
  }
}

function closestEvidenceFrame(event: SessionEvent): EvidenceFrame | undefined {
  return event.evidence?.reduce((best, frame) =>
    Math.abs(frame.t - event.t) < Math.abs(best.t - event.t) ? frame : best,
  event.evidence[0]!);
}

function evidenceWindowText(event: SessionEvent): string {
  const frames = event.evidence ?? [];
  if (frames.length < 2) return "窗口 0.0s";
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  return `窗口 ${((last.t - first.t) / 1000).toFixed(1)}s`;
}

function selectReviewEvent(event: SessionEvent): void {
  selectedReview = event;
  reviewPlaying = false;
  replayPlayButton.textContent = "播放";
  reviewPosition = event.t;
  reviewWindowStart = event.t - 2400;
  reviewWindowEnd = event.t + 2400;
  reviewStartPosition = reviewPosition;
  setText("review-title", `${eventKindName(event)} · ${eventTitle(event)}`);
  setText("replay-camera", `${getCamera(event.camera).code} · ${getCamera(event.camera).name}`);
  setText("replay-window-label", "−2.4s / +2.4s");
  setText("evidence-confidence", event.confidence !== undefined ? `${Math.round(event.confidence * 100)}%` : "—");
  setText("evidence-reason", eventReason(event));
  setEvidenceLegend(event.camera);
  const verdictLabel = child<HTMLElement>(must<HTMLElement>("evidence-verdict"), "span");
  verdictLabel.textContent = event.confidence !== undefined ? "置信度" : event.kind === "marker" ? "标记" : "来源";
  replayPlayButton.disabled = false;
  auditionButton.disabled = false;

  const facts = must<HTMLElement>("evidence-facts");
  facts.replaceChildren();
  const frame = closestEvidenceFrame(event);
  const lead = frame ? leadFor(frame, event.camera) : 0;
  const onsetPeak = (event.evidence ?? []).reduce((peak, item) => {
    const channel = item.channels.find((entry) => entry.camera === event.camera);
    return Math.max(peak, channel?.onset ?? 0);
  }, 0);
  const factsList = [
    evidenceWindowText(event),
    `领先次席 ${formatDb(lead)}`,
    `峰值起音 ${Math.round(onsetPeak * 100)}%`,
    `确认窗 ${Math.round(event.config?.confirmMs ?? config.confirmMs)}ms`,
    `最短停留 ${((event.config?.minDwellMs ?? config.minDwellMs) / 1000).toFixed(1)}s`,
    `迟滞 ${(event.config?.hysteresisDb ?? config.hysteresisDb).toFixed(1)} dB`,
    `6 CH · LOCAL`,
  ];
  factsList.forEach((fact, index) => {
    const item = node("span", "evidence-fact", fact);
    if (index === 0) item.id = "evidence-window-fact";
    facts.append(item);
  });
  renderReviewList();
  drawReview();
}

function drawReview(): void {
  if (!selectedReview) return;
  const event = selectedReview;
  renderCamera(replayCanvas, event.camera, reviewPosition);
  setText("evidence-window-fact", evidenceWindowText(event));
  setText("replay-time", formatTimecode(reviewPosition));
  setText("replay-camera", `${getCamera(event.camera).code} · ${getCamera(event.camera).name}`);
  const progress = clamp(
    (reviewPosition - reviewWindowStart) / Math.max(1, reviewWindowEnd - reviewWindowStart),
    0,
    1,
  );
  const fill = document.getElementById("replay-progress");
  if (fill) fill.style.width = `${progress * 100}%`;
  drawEnergyChart(evidenceCanvas, event.evidence ?? [], {
    highlight: event.camera,
    cursor: reviewPosition,
    showOnsets: true,
  });
}

function openReview(eventId?: string): void {
  void ensureAudio();
  reviewPlaying = false;
  replayPlayButton.textContent = "播放";
  const available = evidenceEventList();
  renderReviewList();
  const chosen = eventId
    ? available.find((event) => event.id === eventId)
    : available[0];
  if (chosen) {
    selectReviewEvent(chosen);
  } else {
    selectedReview = null;
    setText("review-title", "建议回放与音频证据");
    setText("evidence-confidence", "—");
    setText("evidence-reason", "本场还没有可回放的记录。声场建议、自动/手动切换和导播标记都会自动保存证据。");
    setText("replay-camera", `${getCamera(currentCamera).code} · ${getCamera(currentCamera).name}`);
    setText("replay-time", formatTimecode(nowMs()));
    setText("replay-window-label", "暂无记录");
    renderCamera(replayCanvas, currentCamera, nowMs());
    drawEnergyChart(evidenceCanvas, evidenceRing.filter((frame) => frame.t >= nowMs() - 8000), {
      highlight: latestFrame?.leader,
      showOnsets: true,
    });
    must<HTMLElement>("evidence-facts").replaceChildren();
    must<HTMLElement>("evidence-legend").replaceChildren();
    replayPlayButton.disabled = true;
    auditionButton.disabled = true;
  }
  if (!reviewDialog.open) reviewDialog.showModal();
}

function toggleReviewPlay(): void {
  if (!selectedReview) return;
  if (reviewPlaying) {
    reviewPosition = Math.min(
      reviewWindowEnd,
      reviewStartPosition + (performance.now() - reviewStartedWall),
    );
    reviewPlaying = false;
    replayPlayButton.textContent = "继续";
    drawReview();
    return;
  }
  if (reviewPosition >= reviewWindowEnd - 20) reviewPosition = reviewWindowStart;
  reviewStartPosition = reviewPosition;
  reviewStartedWall = performance.now();
  reviewPlaying = true;
  replayPlayButton.textContent = "暂停";
  drawReview();
}

function stepReviewPlayback(): void {
  if (!reviewPlaying || !selectedReview) return;
  reviewPosition = reviewStartPosition + (performance.now() - reviewStartedWall);
  if (reviewPosition >= reviewWindowEnd) {
    reviewPosition = reviewWindowEnd;
    reviewPlaying = false;
    replayPlayButton.textContent = "重播";
  }
  drawReview();
}

async function auditionEvidence(): Promise<void> {
  if (!selectedReview) return;
  await ensureAudio();
  if (!audio.live) {
    toast("本地音频证据暂时无法播放", true);
    return;
  }
  auditionButton.disabled = true;
  auditionButton.textContent = "试听中…";
  const started = await audio.playEvidence(selectedReview.t - 2400, 4800, () => {
    auditionButton.disabled = false;
    auditionButton.textContent = "试听证据";
  });
  updateAudioState();
  if (!started) {
    auditionButton.disabled = false;
    auditionButton.textContent = "试听证据";
    toast("本地音频证据暂时无法播放", true);
  }
}

function openMarker(): void {
  if (reviewDialog.open) return;
  void ensureAudio();
  markerAt = nowMs();
  markerCamera = currentCamera;
  markerNote.value = "";
  const defaultType = markerForm.querySelector<HTMLInputElement>(
    'input[name="marker-type"][value="精彩球"]',
  );
  if (defaultType) defaultType.checked = true;
  if (!markerDialog.open) markerDialog.showModal();
  window.setTimeout(() => markerNote.focus(), 40);
}

function saveMarker(): void {
  const formData = new FormData(markerForm);
  const type = String(formData.get("marker-type") ?? "精彩球");
  const note = String(formData.get("marker-note") ?? markerNote.value).trim();
  addEvent("marker", markerCamera, {
    t: markerAt,
    label: type,
    note: note || undefined,
    reason: note || `导播在 ${getCamera(markerCamera).code} 标记了 ${type}。`,
  });
  flashProgram();
  toast(`已补标记：${type}${note ? ` · ${note}` : ""}`);
  renderTimeline(nowMs());
  if (reviewDialog.open) renderReviewList();
}

function undoLastCut(): void {
  const targetEvent = undoableEvent();
  if (!targetEvent) {
    toast("没有可撤销的切换", true);
    return;
  }
  const t = nowMs();
  const destination = targetEvent.from ?? currentCamera;
  targetEvent.undone = true;
  currentCamera = destination;
  engine.rollback(destination, t);
  activeCue = null;
  setTakeover(true, false);
  addEvent("undo", destination, {
    t,
    from: targetEvent.camera,
    label: `撤销 ${eventTitle(targetEvent)}`,
    reason: `撤销 ${formatClock(targetEvent.t)} 的切换，回到 ${getCamera(destination).code}，已进入手动接管。`,
  });
  flashProgram();
  toast(`已撤销，回到 ${getCamera(destination).code} · ${getCamera(destination).name}`);
  renderTimeline(t);
}

function setMode(mode: EngineConfig["mode"]): void {
  config = { ...config, mode };
  engine.setMode(mode);
  engine.setPaused(false);
  paused = false;
  takeoverRibbon.hidden = true;
  takeoverButton.classList.remove("is-active");
  child<HTMLElement>(takeoverButton, "span:last-child").textContent = "接管";
  activeCue = null;
  syncConfigControls();
  saveConfig();
  toast(mode === "auto" ? "自动模式已开启" : "提示模式已开启，不会自动切换");
}

function applyConfig(): void {
  const next: EngineConfig = {
    ...config,
    minDwellMs: Number(minDwellInput.value),
    hysteresisDb: Number(hysteresisInput.value),
    confirmMs: Number(confirmInput.value),
  };
  config = engine.updateConfig(next);
  syncConfigControls();
  saveConfig();
}

function resetConfig(): void {
  config = engine.updateConfig({
    minDwellMs: DEFAULT_CONFIG.minDwellMs,
    hysteresisDb: DEFAULT_CONFIG.hysteresisDb,
    confirmMs: DEFAULT_CONFIG.confirmMs,
  });
  syncConfigControls();
  saveConfig();
  toast("切换护栏已恢复默认");
}

function toggleTakeover(): void {
  if (paused) setTakeover(false);
  else setTakeover(true);
}

function bindEvents(): void {
  for (const [camera, card] of cameraCards) {
    card.addEventListener("click", () => takeCamera(camera));
  }
  takeoverButton.addEventListener("click", toggleTakeover);
  must<HTMLButtonElement>("resume-auto-inline").addEventListener("click", () => setTakeover(false));
  undoButton.addEventListener("click", undoLastCut);
  must<HTMLButtonElement>("marker-btn").addEventListener("click", openMarker);
  must<HTMLButtonElement>("review-btn").addEventListener("click", () => openReview());
  must<HTMLButtonElement>("review-top").addEventListener("click", () => openReview());
  must<HTMLButtonElement>("review-close").addEventListener("click", () => {
    reviewPlaying = false;
    reviewDialog.close();
  });
  reviewDialog.addEventListener("close", () => {
    reviewPlaying = false;
  });
  replayPlayButton.addEventListener("click", toggleReviewPlay);
  auditionButton.addEventListener("click", () => void auditionEvidence());

  reviewList.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-event-id]");
    if (!target) return;
    const found = events.find((item) => item.id === target.dataset.eventId);
    if (found) selectReviewEvent(found);
  });
  for (const track of [cueTrack, markerTrack]) {
    track.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-event-id]");
      if (target?.dataset.eventId) openReview(target.dataset.eventId);
    });
  }

  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode === "assist" ? "assist" : "auto"));
  });
  minDwellInput.addEventListener("input", applyConfig);
  hysteresisInput.addEventListener("input", applyConfig);
  confirmInput.addEventListener("input", applyConfig);
  must<HTMLButtonElement>("reset-config").addEventListener("click", resetConfig);

  acceptButton.addEventListener("click", () => {
    const cue = currentDisplayCue(nowMs());
    if (!cue) return;
    if (cue.autoApplied) {
      const latestCut = [...events].reverse().find((event) => event.kind === "auto-cut");
      openReview(latestCut?.id);
      return;
    }
    takeCamera(cue.camera, "accepted");
    toast(`已采纳建议，切至 ${getCamera(cue.camera).code}`);
  });
  dismissButton.addEventListener("click", () => {
    engine.dismiss(nowMs());
    engineSnapshot = engine.snapshot;
    activeCue = null;
    toast("已忽略本次建议，焦点转移前不再提示");
  });

  audioToggle.addEventListener("click", async () => {
    if (!audio.live) {
      await ensureAudio();
      if (!audio.live) return;
      if (nowMs() - lastAudioStartAt < 1200) {
        audio.setMonitor(true);
        updateAudioState();
        return;
      }
    }
    if (nowMs() - lastAudioStartAt < 1200) {
      audio.setMonitor(true);
      updateAudioState();
      return;
    }
    audio.setMonitor(!audio.enabled);
    updateAudioState();
    toast(audio.enabled ? "现场声监看已开启" : "现场声监看已静音");
  });

  must<HTMLButtonElement>("fullscreen-btn").addEventListener("click", () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen().catch(() => toast("浏览器未允许全屏", true));
    }
  });

  markerForm.addEventListener("submit", (event) => {
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value === "save") saveMarker();
  });

  document.addEventListener(
    "pointerdown",
    () => {
      if (!audio.live && !audioStarting) void ensureAudio();
    },
    { capture: true },
  );

  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (reviewDialog.open) {
      if (event.key === " ") {
        event.preventDefault();
        toggleReviewPlay();
      }
      return;
    }
    if (markerDialog.open) return;
    if (/^[1-6]$/.test(event.key)) {
      event.preventDefault();
      takeCamera(Number(event.key) as CameraId);
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "t") {
      event.preventDefault();
      toggleTakeover();
    } else if (key === "z") {
      event.preventDefault();
      undoLastCut();
    } else if (key === "m") {
      event.preventDefault();
      openMarker();
    } else if (key === "r") {
      event.preventDefault();
      openReview();
    }
  });
}

let lastReviewDraw = -1;
function animationFrame(): void {
  const t = nowMs();
  if (t - lastProgramRender >= 33) {
    renderCamera(programCanvas, currentCamera, t);
    lastProgramRender = t;
  }
  if (t - lastPreviewRender >= 75) {
    renderCameraGrid(cameraCanvases, t);
    lastPreviewRender = t;
  }
  if (t - lastUiUpdate >= 110) {
    updateCuePanel(t);
    updateProgramChrome(t);
    updateCameraCards();
    updateAudioPanel(t);
    lastUiUpdate = t;
  }
  if (t - lastTimelineDraw >= 500) {
    renderTimeline(t);
    lastTimelineDraw = t;
  }
  if (reviewDialog.open) {
    if (reviewPlaying) stepReviewPlayback();
    else if (t - lastReviewDraw > 220 && selectedReview) {
      drawReview();
      lastReviewDraw = t;
    }
  }
  requestAnimationFrame(animationFrame);
}

buildLegend();
buildTimelineAxis();
syncConfigControls();
setTakeover(false, false);
bindEvents();
processEngineTick(0);
renderCamera(programCanvas, currentCamera, 0);
renderCameraGrid(cameraCanvases, 0);
updateCuePanel(0);
updateProgramChrome(0);
updateCameraCards();
updateAudioPanel(0);
renderTimeline(0);
updateAudioState();
const engineTimer = window.setInterval(() => processEngineTick(nowMs()), 42);
requestAnimationFrame(animationFrame);

window.addEventListener("beforeunload", () => {
  window.clearInterval(engineTimer);
  audio.close();
});
