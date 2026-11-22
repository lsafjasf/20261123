import { buildTestProject, projectDuration } from "./content.ts";
import { cropAtCut, resolveCrop, shotIndexAt } from "./crop.ts";
import { SourceRenderer } from "./draw-source.ts";
import { PortraitRenderer } from "./render-portrait.ts";
import { renderSoundtrack, waveformPeaks } from "./audio.ts";
import {
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  SOURCE_HEIGHT,
  SOURCE_WIDTH,
} from "./types.ts";
import type { Project, Rect, Shot } from "./types.ts";

type BoxMode = "subject" | "gesture";
type DragKind = "move" | "resize" | "draw";

interface DragState {
  kind: DragKind;
  mode: BoxMode;
  startX: number;
  startY: number;
  rect: Rect;
  anchorX: number;
  anchorY: number;
  handle?: string;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function canvasById(id: string): HTMLCanvasElement {
  return byId<HTMLCanvasElement>(id);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function copyRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

function timeLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

export class PortraitCutApp {
  readonly project: Project;
  private readonly defaults: Project;
  private readonly sourceRenderer = new SourceRenderer();
  private readonly portraitRenderer = new PortraitRenderer();
  private currentTime = 0;
  private selectedIndex = 0;
  private playing = false;
  private playStartedAt = 0;
  private playStartedFrom = 0;
  private muted = false;
  private captions = true;
  private guides = true;
  private view: "portrait" | "source" = "portrait";
  private boxMode: BoxMode = "subject";
  private drag: DragState | null = null;
  private timelineDragging = false;
  private frameRequest = 0;
  private soundtrack: AudioBuffer | null = null;
  private audioContext: AudioContext | null = null;
  private audioSource: AudioBufferSourceNode | null = null;
  private audioGain: GainNode | null = null;
  private mapDrag: DragState | null = null;
  private readonly sourceScratch = document.createElement("canvas");
  private toastTimer = 0;

  private readonly el = {
    preview: canvasById("previewCanvas"),
    source: canvasById("sourceCanvas"),
    map: canvasById("mapCanvas"),
    thumb: canvasById("sourceThumb"),
    wave: canvasById("waveCanvas"),
    previewFrame: byId<HTMLDivElement>("previewFrame"),
    sourceView: byId<HTMLDivElement>("sourceView"),
    playBtn: byId<HTMLButtonElement>("playBtn"),
    playIcon: byId<SVGSVGElement>("playIcon"),
    currentTime: byId<HTMLSpanElement>("currentTime"),
    totalTime: byId<HTMLSpanElement>("totalTime"),
    frameHint: byId<HTMLSpanElement>("frameHint"),
    shotList: byId<HTMLDivElement>("shotList"),
    shotsTrack: byId<HTMLDivElement>("shotsTrack"),
    captionTrack: byId<HTMLDivElement>("captionTrack"),
    ruler: byId<HTMLDivElement>("ruler"),
    body: byId<HTMLDivElement>("timelineBody"),
    playhead: byId<HTMLDivElement>("playhead"),
    inspectorTitle: byId<HTMLHeadingElement>("inspectorTitle"),
    inspectorSpeaker: byId<HTMLSpanElement>("inspectorSpeaker"),
    targetValue: byId<HTMLSpanElement>("targetValue"),
    targetX: byId<HTMLInputElement>("targetX"),
    targetY: byId<HTMLInputElement>("targetY"),
    zoomRange: byId<HTMLInputElement>("zoomRange"),
    zoomValue: byId<HTMLOutputElement>("zoomValue"),
    panRange: byId<HTMLInputElement>("panRange"),
    panValue: byId<HTMLOutputElement>("panValue"),
    captionSafe: byId<HTMLInputElement>("captionSafe"),
    gestureSafe: byId<HTMLInputElement>("gestureSafe"),
    safePill: byId<HTMLSpanElement>("safePill"),
    warningStrip: byId<HTMLDivElement>("warningStrip"),
    boxX: byId<HTMLInputElement>("boxX"),
    boxY: byId<HTMLInputElement>("boxY"),
    boxW: byId<HTMLInputElement>("boxW"),
    boxH: byId<HTMLInputElement>("boxH"),
    muteBtn: byId<HTMLButtonElement>("muteBtn"),
    previewArea: byId<HTMLDivElement>("previewArea"),
    toast: byId<HTMLDivElement>("toast"),
  };

  constructor() {
    this.project = buildTestProject();
    this.defaults = structuredClone(this.project);
    this.sourceScratch.width = SOURCE_WIDTH;
    this.sourceScratch.height = SOURCE_HEIGHT;
    this.currentTime = this.project.shots[0].start;
    this.el.totalTime.textContent = timeLabel(projectDuration(this.project));
  }

  async start(): Promise<void> {
    this.buildShotList();
    this.buildTimeline();
    this.bindEvents();
    this.selectShot(0, true);
    this.renderImmediate();
    this.renderThumbnail();
    this.resizeWaveform();
    this.el.map.style.touchAction = "none";
    this.el.previewFrame.style.touchAction = "none";
    window.addEventListener("resize", () => this.resizeWaveform());
    try {
      this.soundtrack = await renderSoundtrack(this.project);
      this.resizeWaveform();
    } catch {
      this.showToast("当前浏览器未提供 OfflineAudioContext，静音预览");
    }
  }

  getSoundtrack(): AudioBuffer | null {
    return this.soundtrack;
  }

  private buildShotList(): void {
    byId("shotCount").textContent = `${this.project.shots.length} 句`;
    this.el.shotList.innerHTML = this.project.shots.map((shot, index) => `
      <button class="shot-card" data-shot="${index}">
        <span class="shot-number">${String(index + 1).padStart(2, "0")}</span>
        <span class="shot-copy">
          <span class="shot-speaker"><i class="${shot.person}"></i>${shot.speaker} · ${shot.role}</span>
          <span class="shot-text">${shot.text}</span>
        </span>
        <span class="shot-time">${(shot.end - shot.start).toFixed(1)}s</span>
      </button>
    `).join("");
    this.el.shotList.addEventListener("click", (event) => {
      const card = (event.target as HTMLElement).closest<HTMLElement>("[data-shot]");
      if (card) this.selectShot(Number(card.dataset.shot), true);
    });
  }

  private buildTimeline(): void {
    const duration = projectDuration(this.project);
    const tickStep = duration > 20 ? 2 : 1;
    this.el.ruler.innerHTML = Array.from(
      { length: Math.floor(duration / tickStep) + 1 },
      (_, index) => {
        const at = index * tickStep;
        return `<span class="ruler-mark" style="left:${(at / duration) * 100}%">${timeLabel(at).slice(0, 5)}</span>`;
      },
    ).join("");

    this.el.shotsTrack.innerHTML = this.project.shots.map((shot, index) => {
      const left = (shot.start / duration) * 100;
      const width = ((shot.end - shot.start) / duration) * 100;
      const gestureLeft = ((shot.gesture.start - shot.start) / (shot.end - shot.start)) * 100;
      return `
        <div class="timeline-shot ${shot.person}" data-shot="${index}" style="left:${left}%;width:${width}%">
          <div class="timeline-shot-label"><i></i>${String(index + 1).padStart(2, "0")} · ${shot.speaker}</div>
          <div class="timeline-shot-text">${shot.text}</div>
          <span class="gesture-mark" style="left:${gestureLeft}%"></span>
        </div>`;
    }).join("");

    this.el.captionTrack.innerHTML = this.project.shots.map((shot) => {
      const left = (shot.start / duration) * 100;
      const width = ((shot.end - shot.start) / duration) * 100;
      return `<div class="caption-cue" style="left:${left}%;width:${width}%">${shot.text}</div>`;
    }).join("");

    this.el.shotsTrack.querySelectorAll<HTMLElement>("[data-shot]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        this.selectShot(Number(element.dataset.shot), true);
      });
    });
  }

  private bindEvents(): void {
    this.el.playBtn.addEventListener("click", () => this.togglePlayback());
    byId("prevShot").addEventListener("click", () => this.selectShot(Math.max(0, this.selectedIndex - 1), true));
    byId("nextShot").addEventListener("click", () => this.selectShot(
      Math.min(this.project.shots.length - 1, this.selectedIndex + 1),
      true,
    ));
    this.el.muteBtn.addEventListener("click", () => {
      this.muted = !this.muted;
      this.el.muteBtn.classList.toggle("muted", this.muted);
      if (this.audioGain) this.audioGain.gain.value = this.muted ? 0 : 0.66;
      this.showToast(this.muted ? "预览已静音" : "声音已开启");
    });
    byId("guidesBtn").addEventListener("click", (event) => {
      this.guides = !this.guides;
      (event.currentTarget as HTMLElement).classList.toggle("active", this.guides);
      this.renderImmediate();
    });
    byId("captionToggle").addEventListener("click", (event) => {
      this.captions = !this.captions;
      (event.currentTarget as HTMLElement).classList.toggle("active", this.captions);
      this.renderImmediate();
    });

    document.querySelectorAll<HTMLElement>("[data-view]").forEach((tab) => {
      tab.addEventListener("click", () => {
        this.view = tab.dataset.view === "source" ? "source" : "portrait";
        document.querySelectorAll("[data-view]").forEach((item) => item.classList.toggle("active", item === tab));
        this.el.previewArea.classList.toggle("source-mode", this.view === "source");
        this.renderImmediate();
      });
    });
    document.querySelectorAll<HTMLElement>("[data-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        this.boxMode = button.dataset.mode === "gesture" ? "gesture" : "subject";
        document.querySelectorAll("[data-mode]").forEach((item) => item.classList.toggle("active", item === button));
        this.renderMap();
      });
    });

    this.bindMapEvents();
    this.bindPreviewTarget();
    this.bindTimelineScrub();
    this.bindInspector();
    window.addEventListener("keydown", (event) => this.onKeyDown(event));
  }

  private bindInspector(): void {
    const current = () => this.project.shots[this.selectedIndex];
    this.el.targetX.addEventListener("input", () => {
      current().target.x = Number(this.el.targetX.value) / 100;
      this.syncInspector();
      this.renderImmediate();
    });
    this.el.targetY.addEventListener("input", () => {
      current().target.y = Number(this.el.targetY.value) / 100;
      this.syncInspector();
      this.renderImmediate();
    });
    this.el.zoomRange.addEventListener("input", () => {
      current().zoom = Number(this.el.zoomRange.value) / 100;
      this.syncInspector();
      this.renderImmediate();
    });
    this.el.panRange.addEventListener("input", () => {
      current().panMs = Number(this.el.panRange.value);
      this.syncInspector();
      this.renderImmediate();
    });
    this.el.captionSafe.addEventListener("change", () => {
      current().safeCaptions = this.el.captionSafe.checked;
      this.renderImmediate();
    });
    this.el.gestureSafe.addEventListener("change", () => {
      current().safeGestures = this.el.gestureSafe.checked;
      this.renderImmediate();
    });
    const boxFields = [this.el.boxX, this.el.boxY, this.el.boxW, this.el.boxH];
    boxFields.forEach((field) => {
      field.addEventListener("change", () => {
        const value = (input: HTMLInputElement, fallback: number) => {
          const parsed = Number(input.value);
          return Number.isFinite(parsed) ? parsed : fallback;
        };
        const old = current().sourceBox;
        current().sourceBox = {
          x: value(this.el.boxX, old.x),
          y: value(this.el.boxY, old.y),
          w: value(this.el.boxW, old.w),
          h: value(this.el.boxH, old.h),
        };
        this.normalizeBox(current().sourceBox);
        this.syncInspector();
        this.renderImmediate();
      });
    });
    byId("resetShot").addEventListener("click", () => {
      this.project.shots[this.selectedIndex] = structuredClone(this.defaults.shots[this.selectedIndex]);
      this.syncInspector();
      this.renderImmediate();
      this.showToast(`镜头 ${this.selectedIndex + 1} 已恢复自动构图`);
    });
  }

  private bindMapEvents(): void {
    const point = (event: PointerEvent) => {
      const bounds = this.el.map.getBoundingClientRect();
      const localX = ((event.clientX - bounds.left) / bounds.width) * this.el.map.width;
      const localY = ((event.clientY - bounds.top) / bounds.height) * this.el.map.height;
      return {
        x: (localX / this.el.map.width) * SOURCE_WIDTH,
        y: (localY / this.el.map.height) * SOURCE_HEIGHT,
        localX,
        localY,
      };
    };
    const activeRect = () => this.boxMode === "subject"
      ? this.currentShot.sourceBox
      : this.currentShot.gesture.rect;
    const setRect = (rect: Rect) => {
      if (this.boxMode === "subject") this.currentShot.sourceBox = rect;
      else this.currentShot.gesture.rect = rect;
    };
    const handleAt = (x: number, y: number, rect: Rect): string | null => {
      const handles: Array<[string, number, number]> = [
        ["nw", rect.x, rect.y],
        ["ne", rect.x + rect.w, rect.y],
        ["sw", rect.x, rect.y + rect.h],
        ["se", rect.x + rect.w, rect.y + rect.h],
      ];
      const threshold = 16 * (SOURCE_WIDTH / this.el.map.width);
      return handles.find(([, hx, hy]) => Math.hypot(hx - x, hy - y) <= threshold)?.[0] ?? null;
    };

    this.el.map.addEventListener("pointerdown", (event) => {
      const p = point(event);
      const rect = copyRect(activeRect());
      const handle = handleAt(p.x, p.y, rect);
      const inside = p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
      const kind: DragKind = handle ? "resize" : inside ? "move" : "draw";
      this.mapDrag = {
        kind,
        mode: this.boxMode,
        startX: p.x,
        startY: p.y,
        rect,
        anchorX: p.x,
        anchorY: p.y,
        handle: handle ?? undefined,
      };
      if (kind === "draw") {
        setRect({ x: p.x, y: p.y, w: 1, h: 1 });
      }
      this.el.map.setPointerCapture(event.pointerId);
      this.pausePlayback();
    });

    this.el.map.addEventListener("pointermove", (event) => {
      const p = point(event);
      if (!this.mapDrag) {
        const handle = handleAt(p.x, p.y, activeRect());
        this.el.map.style.cursor = handle ? "nwse-resize" : "crosshair";
        return;
      }
      const drag = this.mapDrag;
      if (drag.kind === "draw") {
        setRect(this.normalizedRect(drag.anchorX, drag.anchorY, p.x, p.y, 74, 58));
      } else if (drag.kind === "move") {
        const x = clamp(drag.rect.x + p.x - drag.startX, 0, SOURCE_WIDTH - drag.rect.w);
        const y = clamp(drag.rect.y + p.y - drag.startY, 0, SOURCE_HEIGHT - drag.rect.h);
        setRect({ ...drag.rect, x, y });
      } else {
        setRect(this.resizeRect(drag.rect, drag.handle ?? "se", p.x, p.y));
      }
      this.normalizeBox(activeRect());
      this.syncInspector();
      this.renderImmediate();
    });

    const finish = (event: PointerEvent) => {
      if (!this.mapDrag) return;
      if (this.mapDrag.kind === "draw") this.normalizeBox(activeRect());
      this.mapDrag = null;
      if (this.el.map.hasPointerCapture(event.pointerId)) {
        this.el.map.releasePointerCapture(event.pointerId);
      }
      this.syncInspector();
      this.renderImmediate();
    };
    this.el.map.addEventListener("pointerup", finish);
    this.el.map.addEventListener("pointercancel", finish);
  }

  private bindPreviewTarget(): void {
    let dragging = false;
    const update = (event: PointerEvent) => {
      const bounds = this.el.previewFrame.getBoundingClientRect();
      const x = clamp((event.clientX - bounds.left) / bounds.width, 0.18, 0.82);
      const y = clamp((event.clientY - bounds.top) / bounds.height, 0.28, 0.62);
      this.currentShot.target = { x, y };
      this.syncInspector();
      this.renderImmediate();
    };
    this.el.previewFrame.addEventListener("pointerdown", (event) => {
      dragging = true;
      this.el.previewFrame.classList.add("dragging");
      this.el.previewFrame.setPointerCapture(event.pointerId);
      this.pausePlayback();
      update(event);
    });
    this.el.previewFrame.addEventListener("pointermove", (event) => {
      if (dragging) update(event);
    });
    const stop = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      this.el.previewFrame.classList.remove("dragging");
      if (this.el.previewFrame.hasPointerCapture(event.pointerId)) {
        this.el.previewFrame.releasePointerCapture(event.pointerId);
      }
    };
    this.el.previewFrame.addEventListener("pointerup", stop);
    this.el.previewFrame.addEventListener("pointercancel", stop);
  }

  private bindTimelineScrub(): void {
    const seek = (event: PointerEvent) => {
      const bounds = this.el.body.getBoundingClientRect();
      const ratio = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
      this.currentTime = ratio * projectDuration(this.project);
      this.renderImmediate();
    };
    this.el.body.addEventListener("pointerdown", (event) => {
      this.timelineDragging = true;
      this.pausePlayback();
      this.el.body.setPointerCapture(event.pointerId);
      seek(event);
    });
    this.el.body.addEventListener("pointermove", (event) => {
      if (this.timelineDragging) seek(event);
    });
    const stop = (event: PointerEvent) => {
      if (!this.timelineDragging) return;
      this.timelineDragging = false;
      if (this.el.body.hasPointerCapture(event.pointerId)) {
        this.el.body.releasePointerCapture(event.pointerId);
      }
    };
    this.el.body.addEventListener("pointerup", stop);
    this.el.body.addEventListener("pointercancel", stop);
  }

  private get currentShot(): Shot {
    return this.project.shots[this.selectedIndex];
  }

  private normalizedRect(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    minW: number,
    minH: number,
  ): Rect {
    const left = clamp(Math.min(x1, x2), 0, SOURCE_WIDTH);
    const top = clamp(Math.min(y1, y2), 0, SOURCE_HEIGHT);
    const right = clamp(Math.max(x1, x2), left + minW, SOURCE_WIDTH);
    const bottom = clamp(Math.max(y1, y2), top + minH, SOURCE_HEIGHT);
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  private resizeRect(rect: Rect, handle: string, x: number, y: number): Rect {
    const left = handle.includes("w") ? clamp(x, 0, rect.x + rect.w - 70) : rect.x;
    const top = handle.includes("n") ? clamp(y, 0, rect.y + rect.h - 56) : rect.y;
    const right = handle.includes("e") ? clamp(x, rect.x + 70, SOURCE_WIDTH) : rect.x + rect.w;
    const bottom = handle.includes("s") ? clamp(y, rect.y + 56, SOURCE_HEIGHT) : rect.y + rect.h;
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  private normalizeBox(rect: Rect): void {
    rect.w = clamp(rect.w, 70, SOURCE_WIDTH);
    rect.h = clamp(rect.h, 56, SOURCE_HEIGHT);
    rect.x = clamp(rect.x, 0, SOURCE_WIDTH - rect.w);
    rect.y = clamp(rect.y, 0, SOURCE_HEIGHT - rect.h);
  }

  private selectShot(index: number, seek: boolean): void {
    const next = clamp(index, 0, this.project.shots.length - 1);
    this.selectedIndex = next;
    if (seek) {
      this.pausePlayback();
      this.currentTime = this.project.shots[next].start + 0.08;
    }
    this.syncSelectionUI();
    this.syncInspector();
    this.renderThumbnail();
    this.renderImmediate();
  }

  private syncSelectionUI(): void {
    this.el.shotList.querySelectorAll<HTMLElement>("[data-shot]").forEach((item) => {
      item.classList.toggle("active", Number(item.dataset.shot) === this.selectedIndex);
    });
    this.el.shotsTrack.querySelectorAll<HTMLElement>(".timeline-shot").forEach((item) => {
      item.classList.toggle("active", Number(item.dataset.shot) === this.selectedIndex);
    });
  }

  private syncInspector(): void {
    const shot = this.currentShot;
    this.el.inspectorTitle.textContent = `镜头 ${String(this.selectedIndex + 1).padStart(2, "0")}`;
    this.el.inspectorSpeaker.textContent = `${shot.speaker} · ${shot.role}`;
    this.el.targetX.value = String(Math.round(shot.target.x * 100));
    this.el.targetY.value = String(Math.round(shot.target.y * 100));
    this.el.targetValue.textContent = `X ${Math.round(shot.target.x * 100)}% · Y ${Math.round(shot.target.y * 100)}%`;
    this.el.zoomRange.value = String(Math.round(shot.zoom * 100));
    this.el.zoomValue.textContent = `${shot.zoom.toFixed(2)}×`;
    this.el.panRange.value = String(shot.panMs);
    this.el.panValue.textContent = `${shot.panMs} ms`;
    this.el.captionSafe.checked = shot.safeCaptions;
    this.el.gestureSafe.checked = shot.safeGestures;
    this.el.boxX.value = String(Math.round(shot.sourceBox.x));
    this.el.boxY.value = String(Math.round(shot.sourceBox.y));
    this.el.boxW.value = String(Math.round(shot.sourceBox.w));
    this.el.boxH.value = String(Math.round(shot.sourceBox.h));
    this.updateRangeFill(this.el.targetX);
    this.updateRangeFill(this.el.targetY);
    this.updateRangeFill(this.el.zoomRange);
    this.updateRangeFill(this.el.panRange);
    const crop = cropAtCut(this.project, shot);
    const contains = (rect: Rect) => crop.left <= rect.x + 2 &&
      crop.left + crop.width >= rect.x + rect.w - 2;
    const safe = contains(shot.sourceBox) && (!shot.safeGestures || contains(shot.gesture.rect));
    this.el.safePill.textContent = safe ? "全部安全" : "需要修正";
    this.el.safePill.classList.toggle("warn", !safe);
    this.el.warningStrip.classList.toggle("warn", !safe);
    this.el.warningStrip.innerHTML = safe
      ? "<span>✓</span><p>主体、手势与字幕均在安全区内。</p>"
      : "<span>!</span><p>主体或手势区越过裁切窗，请扩大画幅或调整落点。</p>";
  }

  private updateRangeFill(input: HTMLInputElement): void {
    const value = (Number(input.value) - Number(input.min)) /
      (Number(input.max) - Number(input.min)) * 100;
    input.style.setProperty("--range", `${clamp(value, 0, 100)}%`);
  }

  private renderImmediate(): void {
    const total = projectDuration(this.project);
    this.currentTime = clamp(this.currentTime, 0, total);
    const activeIndex = shotIndexAt(this.project, this.currentTime);
    if (activeIndex !== this.selectedIndex) {
      this.selectedIndex = activeIndex;
      this.syncSelectionUI();
      this.syncInspector();
      this.renderThumbnail();
    }
    const crop = resolveCrop(this.project, this.currentTime);
    this.portraitRenderer.draw(
      this.el.preview.getContext("2d")!,
      this.project,
      this.currentTime,
      crop.frame,
      this.sourceCanvasForCurrentTime(),
      { captions: this.captions, guides: this.guides },
    );
    if (this.view === "source") {
      const ctx = this.el.source.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.sourceRenderer.draw(ctx, this.project, this.currentTime);
    }
    this.renderMap();
    this.updateTransport(crop.frame);
  }

  private sourceCanvasForCurrentTime(): HTMLCanvasElement {
    const ctx = this.sourceScratch.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.sourceRenderer.draw(ctx, this.project, this.currentTime);
    return this.sourceScratch;
  }

  private renderMap(): void {
    const ctx = this.el.map.getContext("2d")!;
    const sx = this.el.map.width / SOURCE_WIDTH;
    const sy = this.el.map.height / SOURCE_HEIGHT;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.el.map.width, this.el.map.height);
    ctx.save();
    ctx.scale(sx, sy);
    this.sourceRenderer.draw(ctx, this.project, this.currentTime);
    ctx.restore();

    const crop = cropAtCut(this.project, this.currentShot);
    const x = crop.left * sx;
    const y = crop.top * sy;
    const w = crop.width * sx;
    const h = crop.height * sy;
    ctx.fillStyle = "rgba(6, 7, 6, .58)";
    ctx.fillRect(0, 0, this.el.map.width, y);
    ctx.fillRect(0, y + h, this.el.map.width, this.el.map.height - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, this.el.map.width - x - w, h);
    ctx.strokeStyle = "rgba(255, 245, 226, .72)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);

    const shot = this.currentShot;
    const subject = shot.sourceBox;
    ctx.strokeStyle = "#f0a052";
    ctx.fillStyle = "rgba(240, 160, 82, .08)";
    ctx.lineWidth = 2;
    ctx.fillRect(subject.x * sx, subject.y * sy, subject.w * sx, subject.h * sy);
    ctx.strokeRect(subject.x * sx, subject.y * sy, subject.w * sx, subject.h * sy);
    const points = [
      [subject.x, subject.y],
      [subject.x + subject.w, subject.y],
      [subject.x, subject.y + subject.h],
      [subject.x + subject.w, subject.y + subject.h],
    ];
    ctx.fillStyle = "#ffd3a0";
    for (const [hx, hy] of points) {
      ctx.fillRect(hx * sx - 3, hy * sy - 3, 6, 6);
    }
    ctx.fillStyle = "#f5b46d";
    ctx.font = '600 10px "Droid Sans Mono", monospace';
    ctx.fillText("SUBJECT", subject.x * sx + 5, Math.max(12, subject.y * sy - 6));

    const gesture = shot.gesture.rect;
    ctx.strokeStyle = "#7fd2b7";
    ctx.fillStyle = "rgba(127, 210, 183, .06)";
    ctx.setLineDash([5, 4]);
    ctx.fillRect(gesture.x * sx, gesture.y * sy, gesture.w * sx, gesture.h * sy);
    ctx.strokeRect(gesture.x * sx, gesture.y * sy, gesture.w * sx, gesture.h * sy);
    ctx.setLineDash([]);
    ctx.fillStyle = "#8eddc3";
    ctx.font = '500 9px "Droid Sans Mono", monospace';
    ctx.fillText("GESTURE", gesture.x * sx + 4, Math.max(10, gesture.y * sy - 5));
  }

  private renderThumbnail(): void {
    const ctx = this.el.thumb.getContext("2d");
    if (!ctx) return;
    const scale = this.el.thumb.width / SOURCE_WIDTH;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this.sourceRenderer.draw(ctx, this.project, this.project.shots[this.selectedIndex].start + 0.55);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private updateTransport(frame: ReturnType<typeof resolveCrop>["frame"]): void {
    const total = projectDuration(this.project);
    this.el.currentTime.textContent = timeLabel(this.currentTime);
    this.el.frameHint.textContent = `帧 ${String(Math.round(this.currentTime * this.project.fps)).padStart(4, "0")} · 立即合成`;
    this.el.playhead.style.left = `${(this.currentTime / total) * 100}%`;
    this.el.previewFrame.dataset.crop = `${Math.round(frame.left)},${Math.round(frame.top)}`;
  }

  private resizeWaveform(): void {
    if (!this.soundtrack) return;
    const bounds = this.el.body.getBoundingClientRect();
    const width = Math.max(300, Math.round(bounds.width));
    const height = 52;
    this.el.wave.width = width;
    this.el.wave.height = height;
    const ctx = this.el.wave.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const peaks = waveformPeaks(this.soundtrack, width);
    ctx.fillStyle = "rgba(232, 149, 76, .55)";
    peaks.forEach((peak, index) => {
      const bar = Math.max(1, peak * height * 0.78);
      ctx.fillRect(index, (height - bar) / 2, 1, bar);
    });
  }

  private togglePlayback(): void {
    if (this.playing) {
      this.pausePlayback();
      return;
    }
    const total = projectDuration(this.project);
    if (this.currentTime >= total - 0.02) this.currentTime = this.project.shots[0].start;
    this.playing = true;
    this.playStartedAt = performance.now();
    this.playStartedFrom = this.currentTime;
    this.setPlayIcon(true);
    this.startAudio(this.currentTime);
    const tick = () => {
      if (!this.playing) return;
      this.currentTime = this.playStartedFrom + (performance.now() - this.playStartedAt) / 1000;
      if (this.currentTime >= total - 0.012) {
        this.currentTime = total - 0.012;
        this.renderImmediate();
        this.pausePlayback();
        return;
      }
      this.renderImmediate();
      this.frameRequest = requestAnimationFrame(tick);
    };
    this.frameRequest = requestAnimationFrame(tick);
  }

  private pausePlayback(): void {
    if (this.playing) {
      this.playing = false;
      cancelAnimationFrame(this.frameRequest);
      this.setPlayIcon(false);
      this.stopAudio();
    }
  }

  private setPlayIcon(isPlaying: boolean): void {
    this.el.playIcon.innerHTML = isPlaying
      ? '<path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z"/>'
      : '<path d="M8 5v14l11-7L8 5Z"/>';
    this.el.playBtn.title = isPlaying ? "暂停" : "播放";
  }

  private startAudio(offset: number): void {
    this.stopAudio();
    if (!this.soundtrack || this.muted) return;
    try {
      this.audioContext ??= new AudioContext({ sampleRate: 48000 });
      const source = this.audioContext.createBufferSource();
      const gain = this.audioContext.createGain();
      source.buffer = this.soundtrack;
      gain.gain.value = 0.66;
      source.connect(gain).connect(this.audioContext.destination);
      source.start(0, offset);
      this.audioSource = source;
      this.audioGain = gain;
      void this.audioContext.resume();
    } catch {
      this.showToast("WebAudio 不可用，继续静音预览");
    }
  }

  private stopAudio(): void {
    if (this.audioSource) {
      try {
        this.audioSource.stop();
        this.audioSource.disconnect();
      } catch {
        // A stopped source can throw; the UI is already paused.
      }
    }
    this.audioSource = null;
    this.audioGain = null;
  }

  private onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target.matches("input, select, textarea")) return;
    if (event.code === "Space") {
      event.preventDefault();
      this.togglePlayback();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      this.pausePlayback();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const step = event.shiftKey ? 0.5 : 1 / this.project.fps;
      this.currentTime = clamp(this.currentTime + direction * step, 0, projectDuration(this.project));
      this.renderImmediate();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.selectShot(Math.max(0, this.selectedIndex - 1), true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      this.selectShot(Math.min(this.project.shots.length - 1, this.selectedIndex + 1), true);
    }
  }

  private showToast(message: string): void {
    window.clearTimeout(this.toastTimer);
    this.el.toast.textContent = message;
    this.el.toast.classList.add("visible");
    this.toastTimer = window.setTimeout(() => this.el.toast.classList.remove("visible"), 2200);
  }
}
