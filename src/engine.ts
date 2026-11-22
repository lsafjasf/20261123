import {
  CAMERAS,
  DEFAULT_CONFIG,
  clamp,
  formatDb,
  type CameraId,
  type ChannelMetrics,
  type EngineConfig,
  type EnginePhase,
  type EngineSnapshot,
  type EvidenceFrame,
  type SwitchDecision,
} from "./domain.ts";

export interface EngineTick {
  frame: EvidenceFrame;
  snapshot: EngineSnapshot;
  decision: SwitchDecision | null;
}

function rankBy<T>(items: T[], score: (item: T) => number): T[] {
  return [...items].sort((a, b) => score(b) - score(a));
}

function channelMap(channels: ChannelMetrics[]): Map<CameraId, ChannelMetrics> {
  const map = new Map<CameraId, ChannelMetrics>();
  for (const channel of channels) map.set(channel.camera, channel);
  return map;
}

export class RecommendationEngine {
  private config: EngineConfig;
  private program: CameraId;
  private candidate: CameraId | null = null;
  private candidateSince = 0;
  private candidateLeadSince = 0;
  private lastDecisionAt = 0;
  private lastPromptCandidate: CameraId | null = null;
  private ignoredCandidate: CameraId | null = null;
  private paused = false;
  private decisionCount = 0;
  private latest: EvidenceFrame | null = null;
  private lastSnapshot: EngineSnapshot;
  private onsetHistory = new Map<CameraId, Array<{ t: number; value: number }>>();

  constructor(initial: CameraId = 1, config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.program = initial;
    this.lastSnapshot = this.makeSnapshot(0);
  }

  get programCamera(): CameraId {
    return this.program;
  }

  get engineConfig(): EngineConfig {
    return { ...this.config };
  }

  get snapshot(): EngineSnapshot {
    return { ...this.lastSnapshot };
  }

  setMode(mode: EngineConfig["mode"]): void {
    this.config.mode = mode;
    this.lastPromptCandidate = null;
    this.ignoredCandidate = null;
    this.candidate = null;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.candidate = null;
      this.lastPromptCandidate = null;
    }
  }

  updateConfig(patch: Partial<EngineConfig>): EngineConfig {
    this.config = { ...this.config, ...patch };
    this.lastPromptCandidate = null;
    return this.engineConfig;
  }

  manualTake(camera: CameraId, now: number): EngineSnapshot {
    if (camera !== this.program) {
      this.program = camera;
      this.lastDecisionAt = now;
    }
    this.candidate = null;
    this.candidateSince = 0;
    this.candidateLeadSince = 0;
    this.lastPromptCandidate = null;
    this.ignoredCandidate = null;
    this.lastSnapshot = this.makeSnapshot(now);
    return this.snapshot;
  }

  rollback(camera: CameraId, now: number): EngineSnapshot {
    this.program = camera;
    this.lastDecisionAt = now;
    this.candidate = null;
    this.candidateSince = 0;
    this.candidateLeadSince = 0;
    this.lastPromptCandidate = null;
    this.ignoredCandidate = null;
    this.lastSnapshot = this.makeSnapshot(now);
    return this.snapshot;
  }

  dismiss(now: number): EngineSnapshot {
    if (this.candidate) this.ignoredCandidate = this.candidate;
    this.candidate = null;
    this.candidateSince = 0;
    this.candidateLeadSince = 0;
    this.lastPromptCandidate = null;
    this.lastSnapshot = this.makeSnapshot(now);
    return this.snapshot;
  }

  tick(channels: ChannelMetrics[], now: number): EngineTick {
    const byCamera = channelMap(channels);
    const normalized = CAMERAS.map((camera) => {
      const source = byCamera.get(camera.id);
      return {
        camera: camera.id,
        energyDb: source?.energyDb ?? -100,
        onset: source?.onset ?? 0,
      } satisfies ChannelMetrics;
    });

    const scores = normalized.map((channel) => channel.energyDb + channel.onset * this.config.onsetBoost);
    this.recordOnsets(normalized, now);
    const energyRank = rankBy(normalized, (channel) => channel.energyDb);
    const scoreRank = rankBy(
      normalized.map((channel, index) => ({ ...channel, score: scores[index] ?? -100 })),
      (channel) => channel.score,
    );
    const leader = energyRank[0]?.camera ?? 1;
    const runnerUp = energyRank[1]?.camera ?? 2;
    const leadMarginDb = (energyRank[0]?.energyDb ?? -100) - (energyRank[1]?.energyDb ?? -100);
    const candidate = scoreRank[0]?.camera ?? this.program;
    const candidateChannel = scoreRank[0];
    const currentScore = scores[this.program - 1] ?? -100;
    const candidateScore = candidateChannel?.score ?? -100;
    const challenge = candidateScore - currentScore >= this.config.hysteresisDb;
    const candidateLead =
      candidateChannel !== undefined &&
      candidateChannel.energyDb - (energyRank.find((channel) => channel.camera !== candidate)?.energyDb ?? -100) >=
        this.config.leaderMarginDb;

    const frame: EvidenceFrame = {
      t: now,
      channels: normalized.map((channel) => ({ ...channel })),
      scores: scores.map((score) => Number(score.toFixed(3))),
      leader,
      runnerUp,
      leadMarginDb: Number(leadMarginDb.toFixed(3)),
      candidate,
    };
    this.latest = frame;

    let decision: SwitchDecision | null = null;
    const dwellRemaining = Math.max(0, this.lastDecisionAt + this.config.minDwellMs - now);

    if (candidate === this.program) this.ignoredCandidate = null;

    if (
      !this.paused &&
      candidate !== this.program &&
      candidate !== this.ignoredCandidate &&
      challenge &&
      candidateLead
    ) {
      if (this.candidate !== candidate) {
        this.candidate = candidate;
        this.candidateSince = now;
        this.candidateLeadSince = now;
      }
      if (this.candidateLeadSince === 0) this.candidateLeadSince = now;

      const pendingMs = now - this.candidateSince;
      if (
        pendingMs >= this.config.confirmMs &&
        dwellRemaining <= 0 &&
        this.lastPromptCandidate !== candidate
      ) {
        const onsetPeak = this.peakOnset(candidate, now);
        const sustainedMs = pendingMs;
        const confidence = this.confidence(candidateScore - currentScore, leadMarginDb, onsetPeak);
        const reason = `${this.cameraName(candidate)}能量领先次席 ${formatDb(leadMarginDb, false)}，起音 ${(
          onsetPeak * 100
        ).toFixed(0)}%，越过 ${formatDb(this.config.hysteresisDb, false)} 迟滞。`;
        const from = this.program;
        decision = {
          id: `cue-${++this.decisionCount}-${Math.floor(now)}`,
          t: now,
          from,
          to: candidate,
          kind: this.config.mode === "auto" ? "auto" : "suggestion",
          confidence,
          sustainedMs,
          onsetPeak,
          reason,
          config: this.engineConfig,
          frame,
        };
        this.lastPromptCandidate = candidate;

        if (this.config.mode === "auto") {
          this.program = candidate;
          this.lastDecisionAt = now;
          this.candidate = null;
          this.candidateSince = 0;
          this.candidateLeadSince = 0;
          this.lastPromptCandidate = null;
        }
      }
    } else {
      this.lastPromptCandidate = null;
      this.candidate = null;
      this.candidateSince = 0;
      this.candidateLeadSince = 0;
    }

    this.lastSnapshot = this.makeSnapshot(now, dwellRemaining, candidateScore - currentScore);
    return { frame, snapshot: this.lastSnapshot, decision };
  }

  private confidence(scoreMargin: number, leadMarginDb: number, onset: number): number {
    const scorePart = clamp(scoreMargin / 24, 0, 0.46);
    const leadPart = clamp(leadMarginDb / 30, 0, 0.34);
    const onsetPart = clamp(onset, 0, 1) * 0.12;
    return Number(clamp(0.42 + scorePart + leadPart + onsetPart, 0.42, 0.98).toFixed(3));
  }

  private recordOnsets(channels: ChannelMetrics[], now: number): void {
    for (const channel of channels) {
      if (channel.onset < 0.02) continue;
      const history = this.onsetHistory.get(channel.camera) ?? [];
      history.push({ t: now, value: channel.onset });
      const cutoff = now - 1800;
      while (history[0] && history[0].t < cutoff) history.shift();
      this.onsetHistory.set(channel.camera, history);
    }
  }

  private peakOnset(camera: CameraId, now: number): number {
    const history = this.onsetHistory.get(camera) ?? [];
    let peak = 0;
    for (const entry of history) {
      if (entry.t >= now - 1800 && entry.value > peak) peak = entry.value;
    }
    return peak;
  }

  private makeSnapshot(now: number, dwell = 0, margin = 0): EngineSnapshot {
    const dwellRemainingMs = Math.max(0, this.lastDecisionAt + this.config.minDwellMs - now);
    let phase: EnginePhase = "watching";
    let pendingMs = 0;
    let reason = "持续监听六路声场，等待稳定焦点";

    if (this.paused) {
      phase = "locked";
      reason = "导播已接管，自动建议暂停";
    } else if (this.candidate) {
      pendingMs = Math.max(0, now - this.candidateSince);
      if (dwellRemainingMs > 0) {
        phase = "dwell";
        reason = `${this.cameraName(this.candidate)}持续领先，最短停留还剩 ${(dwellRemainingMs / 1000).toFixed(1)}s`;
      } else if (this.lastPromptCandidate === this.candidate) {
        phase = "ready";
        reason = `${this.cameraName(this.candidate)}已满足切换条件，等待导播采纳`;
      } else if (pendingMs >= this.config.confirmMs) {
        phase = "ready";
      } else {
        phase = "confirming";
        reason = `${this.cameraName(this.candidate)}领先 ${formatDb(margin, false)}，确认中`;
      }
    } else if (dwellRemainingMs > 0) {
      phase = "dwell";
      reason = `最短停留 ${(dwellRemainingMs / 1000).toFixed(1)}s 内保持当前机位`;
    }

    const lead = this.latest?.leadMarginDb ?? 0;
    const onset = this.latest?.channels.find((channel) => channel.camera === this.candidate)?.onset ?? 0;
    return {
      current: this.program,
      candidate: this.candidate,
      pendingMs,
      dwellRemainingMs,
      phase,
      confidence: this.candidate
        ? this.confidence(margin, lead, onset)
        : this.paused
          ? 0
          : clamp(0.38 + lead / 60, 0.25, 0.62),
      reason,
    };
  }

  private cameraName(camera: CameraId): string {
    const spec = CAMERAS[camera - 1];
    return spec ? `${spec.code} ${spec.name}` : `CAM ${camera}`;
  }
}
