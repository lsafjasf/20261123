import {
  chooseOption,
  createInitialState,
  decisionAtPlayerTime,
  finishBranch,
  getDecisionPreloadIds,
  pausePlayback,
  resumePlayback,
  returnToDecision,
  seekMainline,
  type PlayerState,
  type PreloadMap,
  type PreloadState,
  type ReadinessResult,
} from "../core/engine.ts";
import {
  getDecisionAt,
  getMainlineDurationMs,
  getPlacementAt,
  getSegment,
} from "../core/manifest.ts";
import type { BranchManifest, Decision, MediaSegment } from "../core/types.ts";
import { SyncMediaEngine } from "./media.ts";

export interface PreviewCallbacks {
  onStateChange: () => void;
  onTick: (timeMs: number, totalMs: number, driftMs: number) => void;
  onNotice: (message: string, tone?: "info" | "error") => void;
  onMediaStatus: (
    segmentId: string,
    state: PreloadState,
    error?: string,
  ) => void;
}

export class PreviewController {
  state: PlayerState = createInitialState();
  readonly preloads: PreloadMap = {};
  readiness: ReadinessResult = {
    ready: false,
    blockers: [],
    segmentIds: [],
  };
  status: "idle" | "loading" | "ready" | "error" = "idle";
  error = "";
  private manifest: BranchManifest;
  private readonly engine: SyncMediaEngine;
  private readonly context: CanvasRenderingContext2D;
  private readonly callbacks: PreviewCallbacks;
  private operation = 0;
  private transitionInFlight = false;
  private decisionPreloadInFlight = false;
  private lastMainTimeMs = 0;
  private raf = 0;
  private lastTickAt = 0;
  private destroyed = false;
  private volume = 0.78;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    manifest: BranchManifest,
    callbacks: PreviewCallbacks,
  ) {
    this.manifest = manifest;
    this.callbacks = callbacks;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D 不可用");
    this.context = context;
    this.engine = new SyncMediaEngine((segmentId, state, error) => {
      this.preloads[segmentId] = state;
      const decision = this.currentDecision;
      if (decision) {
        this.readiness = this.evaluateReadiness(decision);
        if (this.readiness.blockers.some((blocker) => blocker.status === "failed")) {
          this.state = {
            ...this.state,
            status: "blocked",
          };
        }
      }
      this.callbacks.onMediaStatus(segmentId, state, error);
      this.callbacks.onStateChange();
    });
    this.startLoop();
  }

  get currentDecision(): Decision | undefined {
    return decisionAtPlayerTime(this.manifest, this.state);
  }

  get mainlineDurationMs(): number {
    return getMainlineDurationMs(this.manifest);
  }

  get activeSegment(): MediaSegment | undefined {
    if (this.state.mode === "branch" && this.state.branch) {
      return getSegment(this.manifest, this.state.branch.segmentId);
    }
    const placement = getPlacementAt(this.manifest, this.state.mainTimeMs);
    return placement?.segment;
  }

  get isPlaying(): boolean {
    return this.state.status === "playing";
  }

  get audioLocked(): boolean {
    return this.engine.audioReady ?? false;
  }

  async initialize(): Promise<void> {
    this.status = "loading";
    this.callbacks.onStateChange();
    const placement = getPlacementAt(this.manifest, 0);
    if (!placement) {
      this.status = "error";
      this.error = "主时间线没有可播放的片段";
      this.callbacks.onStateChange();
      return;
    }
    this.lastMainTimeMs = 0;
    try {
      await this.engine.cue(placement.segment, 0);
      this.status = "ready";
      this.callbacks.onStateChange();
      void this.prepareUpcomingMainline(0);
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : "首段预加载失败";
      this.callbacks.onStateChange();
    }
  }

  async loadManifest(manifest: BranchManifest): Promise<void> {
    this.manifest = manifest;
    this.operation += 1;
    this.transitionInFlight = false;
    this.state = createInitialState();
    this.readiness = { ready: false, blockers: [], segmentIds: [] };
    this.status = "loading";
    this.error = "";
    Object.keys(this.preloads).forEach((segmentId) => {
      this.engine.disposeSegment(segmentId);
      delete this.preloads[segmentId];
    });
    this.callbacks.onStateChange();
    await this.initialize();
  }

  updateManifest(manifest: BranchManifest): void {
    this.manifest = manifest;
    const decision = this.currentDecision;
    this.readiness = decision
      ? this.evaluateReadiness(decision)
      : { ready: false, blockers: [], segmentIds: [] };
    this.callbacks.onStateChange();
  }

  async togglePlay(): Promise<void> {
    if (this.state.status === "choice") {
      this.callbacks.onNotice("请先在画面上选择一个处置方式");
      return;
    }
    if (this.state.status === "blocked") {
      this.callbacks.onNotice("预加载未通过，重试后才能继续", "error");
      return;
    }
    if (this.state.status === "playing") {
      this.pause();
      return;
    }
    if (this.state.status === "ended") {
      const reset = seekMainline(this.manifest, this.state, 0);
      this.state = reset;
      this.lastMainTimeMs = 0;
    } else {
      this.state = resumePlayback(this.state);
    }
    await this.resumeCurrentMedia();
  }

  pause(): void {
    this.state = pausePlayback(this.state);
    this.engine.pause();
    this.callbacks.onStateChange();
  }

  async seekTo(timeMs: number): Promise<void> {
    this.operation += 1;
    const token = this.operation;
    this.engine.pause();
    this.state = seekMainline(this.manifest, this.state, timeMs);
    this.lastMainTimeMs = this.state.mainTimeMs;
    if (this.state.status === "paused" && this.currentDecision) {
      this.state = { ...this.state, status: "choice" };
    }
    this.callbacks.onStateChange();
    const placement = getPlacementAt(this.manifest, this.state.mainTimeMs);
    if (!placement) return;
    try {
      await this.engine.cue(
        placement.segment,
        this.state.mainTimeMs - placement.startMs,
      );
      if (token !== this.operation) return;
      this.status = "ready";
      this.callbacks.onStateChange();
      const decision = this.currentDecision;
      if (decision) await this.ensureDecisionPreload(decision);
    } catch (error) {
      if (token !== this.operation) return;
      this.status = "error";
      this.error = error instanceof Error ? error.message : "定位预览失败";
      this.callbacks.onStateChange();
    }
  }

  async choose(optionId: string): Promise<void> {
    const decision = this.currentDecision;
    if (!decision) return;
    this.readiness = this.evaluateReadiness(decision);
    if (!this.readiness.ready) {
      await this.ensureDecisionPreload(decision);
      this.readiness = this.evaluateReadiness(decision);
    }
    if (!this.readiness.ready) {
      this.callbacks.onNotice("相邻片段尚未就绪，已阻止跳转", "error");
      this.callbacks.onStateChange();
      return;
    }
    const result = chooseOption(
      this.manifest,
      this.state,
      decision.id,
      optionId,
      this.preloads,
    );
    if (!result.ok || !result.state.branch) {
      this.callbacks.onNotice("当前无法进入该分支，播放位置未改变", "error");
      return;
    }
    const branch = result.state.branch;
    const segment = getSegment(this.manifest, branch.segmentId);
    if (!segment) {
      this.callbacks.onNotice("目标片段不存在，已阻止跳转", "error");
      return;
    }
    const token = ++this.operation;
    this.state = result.state;
    this.callbacks.onStateChange();
    try {
      await this.engine.activate(segment, 0);
      if (token !== this.operation) {
        this.engine.pause();
        return;
      }
      this.status = "ready";
    } catch (error) {
      if (token !== this.operation) return;
      this.state = {
        ...this.state,
        status: "blocked",
        branch: null,
      };
      this.error = error instanceof Error ? error.message : "分支片段播放失败";
      this.callbacks.onNotice("分支片段播放失败，已停在决策点", "error");
    }
    this.callbacks.onStateChange();
  }

  async returnToDecisionPoint(): Promise<void> {
    if (this.state.mode !== "branch") return;
    this.engine.pause();
    this.state = returnToDecision(this.manifest, this.state);
    this.lastMainTimeMs = this.state.mainTimeMs;
    this.callbacks.onStateChange();
    await this.cueMainAt(this.state.mainTimeMs);
    const decision = this.currentDecision;
    if (decision) await this.ensureDecisionPreload(decision);
  }

  async retryPreload(): Promise<void> {
    const decision = this.currentDecision;
    Object.keys(this.preloads).forEach((segmentId) => {
      if (this.preloads[segmentId] === "failed") {
        this.engine.disposeSegment(segmentId);
        delete this.preloads[segmentId];
      }
    });
    if (!decision) {
      if (this.state.status === "blocked") {
        this.state = { ...this.state, status: "paused" };
        this.callbacks.onStateChange();
      }
      await this.seekTo(this.state.mainTimeMs);
      return;
    }
    if (this.state.status === "blocked") {
      this.state = {
        ...this.state,
        status: "choice",
        mode: "main",
        branch: null,
        activeDecisionId: decision.id,
      };
    }
    this.callbacks.onStateChange();
    await this.ensureDecisionPreload(decision, true);
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    this.engine.setVolume(this.volume);
  }

  async ensureDecisionPreload(
    decision: Decision,
    force = false,
  ): Promise<void> {
    if (this.decisionPreloadInFlight && !force) return;
    const segmentIds = getDecisionPreloadIds(this.manifest, decision);
    const segments = segmentIds
      .map((id) => getSegment(this.manifest, id))
      .filter((segment): segment is MediaSegment => Boolean(segment));
    this.decisionPreloadInFlight = true;
    this.callbacks.onStateChange();
    try {
      await this.engine.prepareMany(segments);
    } finally {
      this.decisionPreloadInFlight = false;
      this.readiness = this.evaluateReadiness(decision);
      if (
        this.state.mode === "main" &&
        this.state.activeDecisionId === decision.id &&
        !this.readiness.ready
      ) {
        this.state = { ...this.state, status: "blocked" };
      } else if (
        this.state.mode === "main" &&
        this.state.activeDecisionId === decision.id &&
        this.readiness.ready &&
        this.state.status === "blocked"
      ) {
        this.state = { ...this.state, status: "choice" };
      }
      this.callbacks.onStateChange();
    }
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
  }

  private evaluateReadiness(decision: Decision): ReadinessResult {
    const ids = getDecisionPreloadIds(this.manifest, decision);
    const blockers = ids
      .filter((segmentId) => this.preloads[segmentId] !== "ready")
      .map((segmentId) => ({
        segmentId,
        status: (this.preloads[segmentId] ?? "idle") as PreloadState,
      }));
    return { ready: blockers.length === 0, blockers, segmentIds: ids };
  }

  private async resumeCurrentMedia(): Promise<void> {
    const token = ++this.operation;
    try {
      if (this.state.mode === "branch" && this.state.branch) {
        const segment = getSegment(this.manifest, this.state.branch.segmentId);
        if (!segment) throw new Error("分支片段不存在");
        await this.engine.activate(segment, this.state.branch.elapsedMs);
      } else {
        const placement = getPlacementAt(this.manifest, this.state.mainTimeMs);
        if (!placement) throw new Error("主时间线片段不存在");
        this.lastMainTimeMs = this.state.mainTimeMs;
        await this.engine.activate(
          placement.segment,
          this.state.mainTimeMs - placement.startMs,
        );
        if (getDecisionAt(this.manifest, this.state.mainTimeMs)) {
          await this.ensureDecisionPreload(this.currentDecision as Decision);
        }
      }
      if (token !== this.operation) {
        this.engine.pause();
        return;
      }
      this.status = "ready";
      this.callbacks.onStateChange();
    } catch (error) {
      if (token !== this.operation) return;
      this.state = pausePlayback(this.state);
      this.status = "error";
      this.error = error instanceof Error ? error.message : "播放失败";
      this.callbacks.onNotice(this.error, "error");
      this.callbacks.onStateChange();
    }
  }

  private async cueMainAt(timeMs: number): Promise<void> {
    const token = ++this.operation;
    const placement = getPlacementAt(this.manifest, timeMs);
    if (!placement) return;
    try {
      await this.engine.cue(placement.segment, timeMs - placement.startMs);
      if (token !== this.operation) return;
      this.status = "ready";
    } catch (error) {
      if (token !== this.operation) return;
      this.status = "error";
      this.error = error instanceof Error ? error.message : "跳转预览失败";
      this.state = { ...this.state, status: "blocked" };
    }
    this.callbacks.onStateChange();
  }

  private async prepareUpcomingMainline(index: number): Promise<void> {
    const next = this.manifest.mainline[index + 1];
    if (!next) return;
    const segment = getSegment(this.manifest, next.segmentId);
    if (!segment) return;
    try {
      await this.engine.prepare(segment);
    } catch {
      // The general playback boundary will stop safely instead of guessing.
    }
  }

  private startLoop(): void {
    const frame = (now: number) => {
      if (this.destroyed) return;
      const delta = this.lastTickAt ? now - this.lastTickAt : 16;
      this.lastTickAt = now;
      this.tick(delta).catch((error) => {
        this.status = "error";
        this.error = error instanceof Error ? error.message : "预览循环异常";
        this.callbacks.onStateChange();
      });
      this.drawFrame();
      this.callbacks.onTick(
        this.currentDisplayTime(),
        this.mainlineDurationMs,
        Math.abs(this.engine.activeDriftMs),
      );
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private async tick(_delta: number): Promise<void> {
    if (this.state.status !== "playing") return;
    if (this.state.mode === "branch" && this.state.branch) {
      const elapsed = this.engine.currentTimeMs;
      if (elapsed >= this.state.branch.endMs - 34 || this.engine.activeEnded) {
        this.engine.pause();
        const completed = finishBranch(this.manifest, this.state);
        this.state = completed;
        this.lastMainTimeMs = completed.mainTimeMs;
        this.callbacks.onStateChange();
        if (completed.mode === "main") {
          await this.cueMainAt(completed.mainTimeMs);
          const decision = this.currentDecision;
          if (decision) await this.ensureDecisionPreload(decision);
          if (completed.status === "playing") {
            const placement = getPlacementAt(
              this.manifest,
              completed.mainTimeMs,
            );
            if (placement) {
              await this.engine.activate(
                placement.segment,
                completed.mainTimeMs - placement.startMs,
              );
            }
          }
        }
      } else {
        this.state = {
          ...this.state,
          branch: { ...this.state.branch, elapsedMs: elapsed },
        };
      }
      return;
    }

    if (this.state.mode !== "main") return;
    const placement = getPlacementAt(this.manifest, this.state.mainTimeMs);
    if (!placement) return;
    if (this.engine.activeSegmentId !== placement.segment.id) return;
    const actualTime = placement.startMs + this.engine.currentTimeMs;
    const decision = this.manifest.decisions
      .filter(
        (candidate) =>
          candidate.pauseAtMs > this.lastMainTimeMs &&
          candidate.pauseAtMs <= actualTime,
      )
      .sort((a, b) => a.pauseAtMs - b.pauseAtMs)[0];
    if (decision) {
      this.engine.pause();
      this.state = {
        ...this.state,
        status: "choice",
        mainTimeMs: decision.pauseAtMs,
        activeDecisionId: decision.id,
      };
      this.lastMainTimeMs = decision.pauseAtMs;
      await this.engine.seek(decision.pauseAtMs - placement.startMs);
      this.callbacks.onStateChange();
      await this.ensureDecisionPreload(decision);
      return;
    }

    if (actualTime >= placement.endMs - 30 || this.engine.activeEnded) {
      if (this.transitionInFlight) return;
      this.transitionInFlight = true;
      const next = getPlacementAt(this.manifest, placement.endMs);
      if (!next || next.index === placement.index) {
        this.engine.pause();
        this.state = {
          ...this.state,
          status: "ended",
          mainTimeMs: this.mainlineDurationMs,
          activeDecisionId: null,
        };
        this.transitionInFlight = false;
        this.callbacks.onStateChange();
        return;
      }
      try {
        this.engine.pause();
        await this.engine.activate(next.segment, 0);
        this.state = {
          ...this.state,
          mainTimeMs: next.startMs,
          activeDecisionId: getDecisionAt(this.manifest, next.startMs)?.id ?? null,
        };
        this.lastMainTimeMs = next.startMs;
        void this.prepareUpcomingMainline(next.index);
      } catch (error) {
        this.engine.pause();
        this.state = {
          ...this.state,
          status: "blocked",
          mainTimeMs: placement.endMs,
        };
        this.error =
          error instanceof Error ? error.message : "下一片段预加载失败";
        this.callbacks.onNotice("下一片段预加载失败，已安全停止", "error");
      } finally {
        this.transitionInFlight = false;
        this.callbacks.onStateChange();
      }
      return;
    }

    this.state = { ...this.state, mainTimeMs: actualTime };
    this.lastMainTimeMs = actualTime;
  }

  private drawFrame(): void {
    const width = this.canvas.width;
    const height = this.canvas.height;
    this.context.fillStyle = "#050708";
    this.context.fillRect(0, 0, width, height);
    if (!this.engine.draw(this.context, width, height)) {
      this.context.save();
      this.context.strokeStyle = "rgba(255,255,255,0.09)";
      this.context.lineWidth = 1;
      for (let x = 0; x < width; x += 48) {
        this.context.beginPath();
        this.context.moveTo(x, 0);
        this.context.lineTo(x, height);
        this.context.stroke();
      }
      for (let y = 0; y < height; y += 48) {
        this.context.beginPath();
        this.context.moveTo(0, y);
        this.context.lineTo(width, y);
        this.context.stroke();
      }
      this.context.fillStyle = "rgba(255,255,255,0.24)";
      this.context.font = "12px sans-serif";
      this.context.textAlign = "center";
      this.context.fillText("PREPARING MEDIA", width / 2, height / 2);
      this.context.restore();
    }
  }

  private currentDisplayTime(): number {
    if (this.state.mode === "branch" && this.state.branch) {
      return this.state.mainTimeMs;
    }
    return this.state.mainTimeMs;
  }
}
