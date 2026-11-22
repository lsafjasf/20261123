import {
  getDecisionPreloadIds,
  type PreloadState,
} from "../core/engine.ts";
import {
  clamp,
  cloneManifest,
  createId,
  formatTimecode,
  getDecision,
  getMainlineDurationMs,
  getMainlinePlacements,
  getSegment,
  normalizeManifest,
} from "../core/manifest.ts";
import type {
  BranchManifest,
  ChoiceOption,
  Decision,
  MediaSegment,
  ValidationResult,
} from "../core/types.ts";
import { validateManifest } from "../core/validation.ts";
import { PreviewController } from "./preview.ts";
import {
  downloadManifest,
  parseImportedManifest,
  readBestManifest,
  readDemoManifest,
  saveLocalManifest,
  saveServerManifest,
  touchManifest,
  type StoredManifest,
} from "./storage.ts";

const STATUS_LABELS: Record<PreloadState, string> = {
  idle: "待命",
  loading: "加载中",
  ready: "已就绪",
  failed: "失败",
};

class Workbench {
  private manifest: BranchManifest = normalizeManifest({});
  private revision = 1;
  private selectedDecisionId = "";
  private savedAt = "";
  private origin: StoredManifest["origin"] = "demo";
  private serverMirror: "pending" | "ok" | "failed" = "pending";
  private controller!: PreviewController;
  private saveTimer = 0;
  private saving = false;
  private pendingSave = false;
  private toastTimer = 0;
  private hasInteracted = false;
  private muted = false;
  private volume = 0.78;
  private drag:
    | {
        decisionId: string;
        mode: "start" | "end" | "move";
        originX: number;
        startMs: number;
        endMs: number;
      }
    | null = null;

  async start(): Promise<void> {
    let loaded: StoredManifest;
    try {
      loaded = await readBestManifest();
    } catch (error) {
      this.showToast(
        error instanceof Error ? error.message : "清单载入失败，使用内置演示",
        "error",
      );
      loaded = await readDemoManifest();
    }
    this.applyStoredState(loaded, false);
    this.controller = new PreviewController(
      this.element<HTMLCanvasElement>("preview-canvas"),
      this.manifest,
      {
        onStateChange: () => this.renderPlaybackState(),
        onTick: (timeMs, totalMs, driftMs) =>
          this.renderTime(timeMs, totalMs, driftMs),
        onNotice: (message, tone) => this.showToast(message, tone),
        onMediaStatus: () => {
          this.renderPreloads();
          this.renderRecovery();
        },
      },
    );
    this.bindEvents();
    this.renderAll();
    await this.controller.loadManifest(this.manifest);
    const sourceLabel =
      this.origin === "local"
        ? "已完整恢复本地清单"
        : this.origin === "server"
          ? "已恢复 Node 本地镜像"
          : "已载入内置急救演示";
    this.showToast(sourceLabel);
  }

  private bindEvents(): void {
    this.element("play-button").addEventListener("click", () => {
      this.hasInteracted = true;
      void this.controller.togglePlay();
      this.renderPlaybackState();
    });
    this.element("mute-button").addEventListener("click", () => {
      this.muted = !this.muted;
      this.controller.setVolume(this.muted ? 0 : this.volume);
      this.element("mute-icon").textContent = this.muted ? "◌" : "◖";
    });
    this.element<HTMLInputElement>("volume-slider").addEventListener(
      "input",
      (event) => {
        this.volume = Number((event.target as HTMLInputElement).value) / 100;
        this.muted = false;
        this.element("mute-icon").textContent = "◖";
        this.controller.setVolume(this.volume);
      },
    );
    this.element("export-button").addEventListener("click", () => {
      downloadManifest(this.manifest);
      this.showToast("分支清单已导出");
    });
    this.element("import-button").addEventListener("click", () => {
      this.element<HTMLInputElement>("file-input").click();
    });
    this.element<HTMLInputElement>("file-input").addEventListener(
      "change",
      (event) => void this.importFile(event),
    );
    this.element("reset-button").addEventListener("click", () => {
      void this.resetDemo();
    });
    this.element("add-decision").addEventListener("click", () => {
      this.addDecision();
    });
    this.element("project-title").addEventListener("input", (event) => {
      this.mutate((draft) => {
        draft.title = (event.target as HTMLInputElement).value;
      });
    });
    this.element("project-description").addEventListener("input", (event) => {
      this.mutate((draft) => {
        draft.description = (event.target as HTMLTextAreaElement).value;
      });
    });
    this.element("timeline-track").addEventListener("click", (event) => {
      void this.seekFromPointer(event);
    });
    this.element("decision-lane").addEventListener("pointerdown", (event) => {
      this.beginIntervalDrag(event);
    });
    this.element("decision-editor").addEventListener("input", (event) => {
      this.handleEditorInput(event);
    });
    this.element("decision-editor").addEventListener("change", (event) => {
      this.handleEditorChange(event);
    });
    this.element("decision-editor").addEventListener("focusin", (event) => {
      const block = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-decision-id]",
      );
      const id = block?.dataset.decisionId;
      if (!id || id === this.selectedDecisionId) return;
      this.selectedDecisionId = id;
      this.renderTimeline();
      this.renderBranchMap();
      this.renderInspector();
      this.renderPreloads();
    });
    this.element("decision-editor").addEventListener("click", (event) => {
      this.handleEditorClick(event);
    });
    this.element("choice-options").addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
        "[data-option-id]",
      );
      if (!button || button.disabled) return;
      this.hasInteracted = true;
      void this.controller.choose(button.dataset.optionId ?? "");
    });
    this.element("return-decision").addEventListener("click", () => {
      void this.controller.returnToDecisionPoint();
    });
    this.element("retry-preload").addEventListener("click", () => {
      void this.controller.retryPreload();
    });
    this.element("blocked-retry").addEventListener("click", () => {
      void this.controller.retryPreload();
    });
    document.addEventListener("pointermove", (event) => {
      this.updateIntervalDrag(event);
    });
    document.addEventListener("pointerup", () => {
      this.endIntervalDrag();
    });
    window.addEventListener("resize", () => this.updatePlayhead());
    window.addEventListener("beforeunload", () => {
      saveLocalManifest(this.manifest, this.revision);
    });
    document.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement;
      if (
        target.matches("input, textarea, select, button") ||
        target.isContentEditable
      ) {
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        this.hasInteracted = true;
        void this.controller.togglePlay();
      }
    });
  }

  private applyStoredState(stored: StoredManifest, reload: boolean): void {
    this.manifest = stored.manifest;
    this.revision = stored.revision;
    this.savedAt = stored.savedAt;
    this.origin = stored.origin;
    this.selectedDecisionId =
      this.manifest.decisions[0]?.id ?? this.selectedDecisionId;
    this.hasInteracted = false;
    if (reload) {
      this.renderAll();
      void this.controller.loadManifest(this.manifest);
    }
  }

  private renderAll(): void {
    this.renderProject();
    this.renderTimeline();
    this.renderEditor();
    this.renderBranchMap();
    this.renderInspector();
    this.renderPreloads();
    this.renderRecovery();
    this.renderPlaybackState();
    this.renderTime(
      this.controller?.state.mainTimeMs ?? 0,
      getMainlineDurationMs(this.manifest),
      0,
    );
  }

  private renderDerived(): void {
    this.renderProject();
    this.renderTimeline();
    this.renderBranchMap();
    this.renderInspector();
    this.renderPreloads();
    this.refreshValidation();
  }

  private renderProject(): void {
    const title = this.element<HTMLInputElement>("project-title");
    const description =
      this.element<HTMLTextAreaElement>("project-description");
    if (document.activeElement !== title) title.value = this.manifest.title;
    if (document.activeElement !== description) {
      description.value = this.manifest.description;
    }
    const duration = getMainlineDurationMs(this.manifest);
    this.element("project-stats").innerHTML = [
      chip("片段", String(this.manifest.segments.length)),
      chip("主线", String(this.manifest.mainline.length)),
      chip("决策", String(this.manifest.decisions.length)),
      chip("时长", formatTimecode(duration, false)),
      chip(
        "正确分支",
        String(
          this.manifest.decisions.reduce(
            (sum, decision) =>
              sum + decision.options.filter((option) => option.correct).length,
            0,
          ),
        ),
      ),
    ].join("");
    this.element("total-time").textContent = formatTimecode(duration);
    this.element("mainline-time").textContent = formatTimecode(duration);
  }

  private renderTimeline(): void {
    const total = Math.max(1, getMainlineDurationMs(this.manifest));
    const placements = getMainlinePlacements(this.manifest);
    const ruler = Array.from({ length: 7 }, (_, index) => {
      const ratio = index / 6;
      return `<span>${formatTimecode(total * ratio, false)}</span>`;
    }).join("");
    this.element("timeline-ruler").innerHTML = ruler;
    this.element("timeline-track").innerHTML = placements
      .map((placement) => {
        const width = (placement.segment.durationMs / total) * 100;
        return `<div class="timeline-clip" data-seek="${placement.startMs}"
          style="width:${width}%;--clip-color:${safeColor(placement.segment.accent)}"
          title="${escapeHtml(placement.segment.name)} · ${formatTimecode(placement.segment.durationMs)}">
          <strong>${escapeHtml(placement.segment.name)}</strong>
          <span>${formatTimecode(placement.segment.durationMs, false)} · ${escapeHtml(placement.segment.kind.toUpperCase())}</span>
        </div>`;
      })
      .join("");
    const lane = this.element("decision-lane");
    lane.innerHTML =
      '<span class="lane-label">选项</span>' +
      this.manifest.decisions
        .map((decision) => {
          const left = (decision.timelineStartMs / total) * 100;
          const width = Math.max(
            3,
            ((decision.timelineEndMs - decision.timelineStartMs) / total) * 100,
          );
          const pauseRatio =
            ((decision.pauseAtMs - decision.timelineStartMs) /
              Math.max(1, decision.timelineEndMs - decision.timelineStartMs)) *
            100;
          return `<div class="decision-range" data-decision-drag="${decision.id}"
            data-selected="${decision.id === this.selectedDecisionId}"
            style="left:${left}%;width:${width}%"
            title="${escapeHtml(decision.title)} · 选项区间">
            <span class="range-handle start" data-handle="start"></span>
            <span class="decision-range-label">${escapeHtml(decision.title)}</span>
            <span class="pause-pin" style="left:${clamp(pauseRatio, 0, 100)}%"></span>
            <span class="range-handle end" data-handle="end"></span>
          </div>`;
        })
        .join("");
    this.updatePlayhead();
  }

  private renderEditor(): void {
    const validation = validateManifest(this.manifest);
    if (!this.selectedDecisionId) {
      this.selectedDecisionId = this.manifest.decisions[0]?.id ?? "";
    }
    this.element("decision-editor").innerHTML = this.manifest.decisions
      .map((decision, index) => this.decisionEditorHtml(decision, index, validation))
      .join("");
  }

  private decisionEditorHtml(
    decision: Decision,
    index: number,
    validation: ValidationResult,
  ): string {
    const decisionPath = `decisions[${index}]`;
    const issues = validation.issues.filter(
      (issue) =>
        issue.path.startsWith(decisionPath) &&
        issue.severity === "error",
    );
    const total = getMainlineDurationMs(this.manifest);
    return `<div class="decision-block" data-decision-id="${decision.id}">
      <div class="decision-block-head">
        <span class="decision-index">${String(index + 1).padStart(2, "0")}</span>
        <div class="decision-heading-copy">
          <h3>${escapeHtml(decision.title || "未命名决策")}</h3>
          <p>${formatTimecode(decision.timelineStartMs)} → ${formatTimecode(decision.timelineEndMs)} · ${decision.options.length} 个选项</p>
        </div>
        <button class="delete-decision" type="button" data-delete-decision="${decision.id}" title="删除决策">×</button>
      </div>
      <div class="field-row">
        <label class="input-group"><span>决策标题</span>
          <input class="text-input" data-field="title" value="${escapeHtml(decision.title)}" />
        </label>
        <label class="input-group"><span>暂停决策点</span>
          <div class="number-wrap"><input class="number-input" type="number" min="0" max="${total}" data-field="pauseAtMs" value="${decision.pauseAtMs}" /><em>ms</em></div>
        </label>
      </div>
      <label class="input-group" style="display:block;margin-bottom:9px"><span>问题文案</span>
        <textarea class="text-input" data-field="prompt">${escapeHtml(decision.prompt)}</textarea>
      </label>
      <div class="field-row three">
        <label class="input-group"><span>选项出现</span>
          <div class="number-wrap"><input class="number-input" type="number" min="0" max="${total}" data-field="timelineStartMs" value="${decision.timelineStartMs}" /><em>ms</em></div>
        </label>
        <label class="input-group"><span>选项消失</span>
          <div class="number-wrap"><input class="number-input" type="number" min="0" max="${total}" data-field="timelineEndMs" value="${decision.timelineEndMs}" /><em>ms</em></div>
        </label>
        <label class="input-group"><span>决策编号</span>
          <input class="text-input" value="${String(index + 1).padStart(2, "0")}" disabled />
        </label>
      </div>
      <div class="options-label">
        <span>分支选项 / TARGET & RETURN</span>
        <button class="add-option" type="button" data-add-option="${decision.id}">＋ 添加选项</button>
      </div>
      ${decision.options
        .map((option) => this.optionEditorHtml(option, decision))
        .join("")}
      <div class="validation-line ${issues.length ? "has-error" : ""}" data-validation="${decision.id}">
        <i></i><span>${issues.length ? issues[0]?.message : "区间、目标片段与回主线位置有效"}</span>
      </div>
    </div>`;
  }

  private optionEditorHtml(
    option: ChoiceOption,
    decision: Decision,
  ): string {
    const target = getSegment(this.manifest, option.targetSegmentId);
    const maxTarget = target?.durationMs ?? 10_000;
    return `<div class="option-editor ${option.correct ? "correct-option" : "wrong-option"}"
      data-option-id="${option.id}">
      <div class="option-editor-top">
        <input class="text-input" data-option-field="label" value="${escapeHtml(option.label)}" aria-label="选项文案" />
        <label class="option-state" title="标记正确处置">
          <input type="checkbox" data-option-field="correct" ${option.correct ? "checked" : ""} />
          <span>${option.correct ? "正确" : "错误"}</span>
        </label>
        <button class="option-remove" type="button" data-delete-option="${option.id}" title="删除选项">×</button>
      </div>
      <div class="option-route">
        <label class="input-group"><span>目标片段</span>
          <select class="select-input" data-option-field="targetSegmentId">
            ${this.manifest.segments
              .map(
                (segment) =>
                  `<option value="${segment.id}" ${segment.id === option.targetSegmentId ? "selected" : ""}>${escapeHtml(segment.name)}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label class="input-group"><span>播放至</span>
          <div class="number-wrap"><input class="number-input" type="number" min="1" max="${maxTarget}" data-option-field="targetEndMs" value="${option.targetEndMs}" /><em>ms</em></div>
        </label>
        <label class="input-group"><span>回主线</span>
          <div class="number-wrap"><input class="number-input" type="number" min="0" data-option-field="returnToMs" value="${option.returnToMs}" /><em>ms</em></div>
        </label>
      </div>
      <input class="text-input option-hint-input" data-option-field="hint" value="${escapeHtml(option.hint)}" placeholder="选项说明 / 反馈文案" aria-label="选项说明" />
      <div style="margin-top:5px;color:var(--muted-2);font-family:var(--mono);font-size:7px">
        ${option.correct ? "CORRECT" : "WRONG"} · RETURN ${formatTimecode(option.returnToMs)} · DECISION ${formatTimecode(decision.timelineStartMs)}
      </div>
    </div>`;
  }

  private renderBranchMap(): void {
    const decision =
      getDecision(this.manifest, this.selectedDecisionId) ??
      this.manifest.decisions[0];
    this.element("topology-count").textContent =
      `${this.manifest.decisions.length} NODE${this.manifest.decisions.length === 1 ? "" : "S"}`;
    if (!decision) {
      this.element("branch-map").innerHTML =
        '<p class="eyebrow">NO DECISION</p><p style="color:var(--muted);font-size:10px">新增决策后会在此显示分支拓扑。</p>';
      return;
    }
    const state = this.controller?.state;
    const activeId = this.controller?.activeSegment?.id;
    const intro = this.manifest.mainline[0]
      ? getSegment(this.manifest, this.manifest.mainline[0].segmentId)
      : undefined;
    const after = this.manifest.mainline[1]
      ? getSegment(this.manifest, this.manifest.mainline[1].segmentId)
      : undefined;
    const ending = this.manifest.mainline.at(-1)
      ? getSegment(this.manifest, this.manifest.mainline.at(-1)?.segmentId ?? "")
      : undefined;
    const options = decision.options.slice(0, 2);
    this.element("branch-map").innerHTML = `
      <div class="map-caption"><span>DECISION FLOW</span><span>${this.manifest.mainline.length} MAIN CLIPS</span></div>
      <div class="map-canvas">
        <div class="map-line vertical" style="left:8px;top:26px;height:14px"></div>
        <div class="map-node main ${activeId === intro?.id ? "active" : ""}" style="top:0;--node-color:${safeColor(intro?.accent ?? "#66b7f5")}">
          <strong>${escapeHtml(intro?.name ?? "主线片段")}</strong><span>00:00 → ${formatTimecode(intro?.durationMs ?? 0, false)}</span>
        </div>
        <div class="map-line vertical" style="left:8px;top:59px;height:10px"></div>
        <div class="map-node decision ${state?.activeDecisionId === decision.id ? "active" : ""}" style="top:70px">
          <strong>◆ ${escapeHtml(decision.title)}</strong><span>${formatTimecode(decision.timelineStartMs, false)} · 暂停 ${formatTimecode(decision.pauseAtMs, false)}</span>
        </div>
        <div class="map-line" style="left:14px;right:50%;top:121px;height:14px;background:transparent;border-left:1px solid var(--line-strong);border-bottom:1px solid var(--line-strong)"></div>
        <div class="map-line" style="left:50%;right:14px;top:121px;height:14px;background:transparent;border-right:1px solid var(--line-strong);border-bottom:1px solid var(--line-strong)"></div>
        ${options
          .map((option, index) => {
            const target = getSegment(this.manifest, option.targetSegmentId);
            const cls = index === 0 ? "branch-a" : "branch-b";
            const active = activeId === target?.id;
            return `<div class="map-branch ${cls}" style="top:135px;--branch-color:${safeColor(target?.accent ?? (option.correct ? "#58cf8d" : "#efb45e"))};${active ? "outline:2px solid #fff;outline-offset:1px" : ""}">
              ${escapeHtml(option.label)}<span>${option.correct ? "CORRECT" : "WRONG"} · → ${formatTimecode(option.returnToMs, false)}</span>
            </div>`;
          })
          .join("")}
        <div class="map-line vertical" style="left:8px;top:171px;height:10px"></div>
        <div class="map-node main ${activeId === after?.id ? "active" : ""}" style="top:182px;--node-color:${safeColor(after?.accent ?? "#66b7f5")}">
          <strong>${escapeHtml(after?.name ?? "回主线片段")}</strong><span>RETURN → ${formatTimecode(options.find((option) => option.correct)?.returnToMs ?? 0, false)}</span>
        </div>
        <div class="map-node main ${activeId === ending?.id ? "active" : ""}" style="top:222px;--node-color:${safeColor(ending?.accent ?? "#b69bff")}">
          <strong>${escapeHtml(ending?.name ?? "结束片段")}</strong><span>END</span>
        </div>
      </div>`;
  }

  private renderInspector(): void {
    const decision = getDecision(
      this.manifest,
      this.selectedDecisionId,
    ) ?? this.manifest.decisions[0];
    if (!decision) {
      this.element("interval-inspector").innerHTML =
        '<p style="color:var(--muted-2);font-size:9px;line-height:1.5">尚未定义选项区间。点击「＋ 决策」在当前播放头创建。</p>';
      this.element("inspector-state").textContent = "无决策";
      return;
    }
    const total = Math.max(1, getMainlineDurationMs(this.manifest));
    const left = (decision.timelineStartMs / total) * 100;
    const width = Math.max(
      0,
      ((decision.timelineEndMs - decision.timelineStartMs) / total) * 100,
    );
    const pause = (decision.pauseAtMs / total) * 100;
    this.element("interval-inspector").innerHTML = `
      <div class="interval-bar">
        <span class="interval-bar-main" style="left:0;width:100%"></span>
        <span class="interval-bar-choice" style="left:${left}%;width:${width}%"></span>
        <span class="interval-bar-pause" style="left:${pause}%"></span>
      </div>
      <div class="interval-values">
        <div><span>选项出现区间</span><strong>${formatTimecode(decision.timelineStartMs)} → ${formatTimecode(decision.timelineEndMs)}</strong></div>
        <div><span>暂停点</span><strong>${formatTimecode(decision.pauseAtMs)}</strong></div>
        <div><span>目标片段</span><strong>${decision.options.length} 条分支</strong></div>
        <div><span>区间时长</span><strong>${formatTimecode(decision.timelineEndMs - decision.timelineStartMs)}</strong></div>
      </div>`;
    this.element("inspector-state").textContent = "可编辑";
  }

  private renderPreloads(): void {
    const current = this.controller?.currentDecision;
    const decision =
      current ??
      getDecision(this.manifest, this.selectedDecisionId) ??
      this.manifest.decisions[0];
    if (!decision) {
      this.element("preload-list").innerHTML =
        '<p style="color:var(--muted-2);font-size:9px">尚未定义需要预加载的相邻片段。</p>';
      this.element("preload-summary").textContent = "无决策";
      return;
    }
    const ids = getDecisionPreloadIds(this.manifest, decision);
    const segments = ids
      .map((id) => getSegment(this.manifest, id))
      .filter((segment): segment is MediaSegment => Boolean(segment));
    const states = segments.map(
      (segment) => this.controller?.preloads[segment.id] ?? "idle",
    );
    const ready = states.filter((state) => state === "ready").length;
    const failed = states.filter((state) => state === "failed").length;
    const loading = states.filter((state) => state === "loading").length;
    this.element("preload-summary").textContent = failed
      ? `${failed} 项失败 · 已锁定`
      : ready === segments.length
        ? `${ready}/${segments.length} 已就绪`
        : loading
          ? `${ready}/${segments.length} 加载中`
          : current
            ? "等待预加载"
            : "等待决策点";
    this.element("preload-summary").className = `preload-summary ${failed ? "failed" : ready === segments.length ? "ready" : ""}`;
    this.element("preload-list").innerHTML = segments
      .map((segment, index) => {
        const state = states[index] ?? "idle";
        const role = decision.options.some(
          (option) => option.targetSegmentId === segment.id,
        )
          ? "分支目标"
          : "回主线";
        return `<div class="preload-row ${state}">
          <i></i>
          <div class="preload-name">
            <strong>${escapeHtml(segment.name)}</strong>
            <span>${role} · ${escapeHtml(segment.src)}</span>
          </div>
          <span class="preload-status">${STATUS_LABELS[state]}</span>
        </div>`;
      })
      .join("");
  }

  private renderRecovery(): void {
    const validation = validateManifest(this.manifest);
    const errorCount = validation.issues.filter(
      (issue) => issue.severity === "error",
    ).length;
    const validRefs = this.manifest.mainline.filter((clip) =>
      Boolean(getSegment(this.manifest, clip.segmentId)),
    ).length;
    this.element("manifest-revision").textContent =
      `REV ${String(this.revision).padStart(2, "0")}`;
    this.element("recovery-grid").innerHTML = [
      recovery(
        "Manifest source",
        this.origin === "local"
          ? "localStorage"
          : this.origin === "server"
            ? "Node mirror"
            : "Demo bundle",
      ),
      recovery(
        "Autosave",
        this.savedAt ? formatSavedTime(this.savedAt) : "等待首次编辑",
      ),
      recovery(
        "Segment refs",
        `${validRefs}/${this.manifest.mainline.length} valid`,
      ),
      recovery("Schema", `v${this.manifest.version} · ${errorCount ? `${errorCount} issue` : "clean"}`),
    ].join("");
  }

  private renderPlaybackState(): void {
    if (!this.controller) return;
    const state = this.controller.state;
    const decision = this.controller.currentDecision;
    const choiceActive =
      state.mode === "main" &&
      Boolean(decision) &&
      (state.status === "choice" ||
        state.status === "blocked" ||
        state.status === "paused");
    const branchActive = state.mode === "branch" && Boolean(state.branch);
    const blockedWithoutChoice =
      state.status === "blocked" && !decision;
    const welcome = this.element("welcome-overlay");
    const choice = this.element("choice-overlay");
    const branch = this.element("branch-overlay");
    const blocked = this.element("blocked-overlay");

    welcome.hidden = this.hasInteracted || state.status !== "paused";
    choice.hidden = !choiceActive;
    branch.hidden = !branchActive;
    blocked.hidden = !blockedWithoutChoice;

    const playButton = this.element("play-button");
    playButton.classList.toggle("playing", state.status === "playing");
    playButton.setAttribute(
      "aria-label",
      state.status === "playing" ? "暂停" : "播放",
    );
    this.element("play-icon").textContent =
      state.status === "playing" ? "❚❚" : "▶";

    if (choiceActive && decision) {
      const index = this.manifest.decisions.findIndex(
        (candidate) => candidate.id === decision.id,
      );
      this.element("choice-number").textContent =
        `决策 ${String(index + 1).padStart(2, "0")} / ${decision.title}`;
      this.element("choice-time").textContent = formatTimecode(
        this.controller.state.mainTimeMs,
      );
      this.element("choice-title").textContent = decision.prompt;
      this.element("choice-prompt").textContent =
        `选项区间 ${formatTimecode(decision.timelineStartMs, false)} – ${formatTimecode(decision.timelineEndMs, false)} · 暂停于 ${formatTimecode(decision.pauseAtMs, false)}`;
      const ready = this.controller.readiness.ready;
      this.element("choice-options").innerHTML = decision.options
        .map(
          (option, optionIndex) => `<button class="choice-option" type="button"
            data-option-id="${option.id}"
            ${ready && state.status === "choice" ? "" : "disabled"}>
            <span class="choice-option-key">${String.fromCharCode(65 + optionIndex)}</span>
            <strong>${escapeHtml(option.label)}</strong>
            <span>${escapeHtml(option.hint || "播放该处置分支")}</span>
          </button>`,
        )
        .join("");
      const failed = this.controller.readiness.blockers;
      const guard = this.element("choice-guard");
      const retry = this.element<HTMLButtonElement>("retry-preload");
      if (ready) {
        guard.className = "choice-guard";
        this.element("guard-text").textContent =
          "相邻片段已预加载，可安全进入分支";
        retry.hidden = true;
        guard.querySelector(".guard-icon")!.textContent = "✓";
      } else if (failed.length) {
        guard.className = "choice-guard blocked";
        this.element("guard-text").textContent =
          `预加载失败 · 已锁定在 ${formatTimecode(decision.pauseAtMs)}`;
        retry.hidden = false;
        guard.querySelector(".guard-icon")!.textContent = "!";
      } else {
        guard.className = "choice-guard";
        this.element("guard-text").textContent =
          `正在核验相邻片段 ${this.controller.readiness.segmentIds.length - failed.length}/${this.controller.readiness.segmentIds.length}`;
        retry.hidden = true;
        guard.querySelector(".guard-icon")!.textContent = "…";
      }
    }

    if (branchActive && state.branch) {
      const segment = getSegment(this.manifest, state.branch.segmentId);
      const option = getDecision(
        this.manifest,
        state.branch.decisionId,
      )?.options.find((candidate) => candidate.id === state.branch?.optionId);
      const tag = this.element("branch-tag");
      tag.textContent = state.branch.correct ? "正确处置 · CORRECT" : "错误处置 · REVIEW";
      tag.className = `branch-tag ${state.branch.correct ? "" : "wrong"}`;
      this.element("branch-title").textContent =
        segment?.name ?? option?.label ?? "分支片段";
      this.element("branch-summary").textContent =
        option?.hint ?? segment?.summary ?? "";
      this.element("branch-warning").hidden = state.branch.correct;
      this.element("return-decision").hidden = state.branch.correct;
    }

    if (blockedWithoutChoice) {
      const failed = Object.entries(this.controller.preloads)
        .filter(([, value]) => value === "failed")
        .map(([id]) => getSegment(this.manifest, id)?.name ?? id);
      this.element("blocked-detail").textContent = failed.length
        ? `${failed.join("、")} 加载失败，系统保持当前位置，未切换到任何未验证片段。`
        : this.controller.error ||
          "目标片段不可用，系统拒绝继续跳转以避免播放错误片段。";
    }

    const engine = this.element("engine-state");
    let engineText = "音画就绪";
    let engineClass = "";
    if (this.controller.status === "error") {
      engineText = "媒体异常";
      engineClass = "error";
    } else if (state.status === "blocked") {
      engineText = "安全停止";
      engineClass = "error";
    } else if (
      this.controller.status === "loading" ||
      this.controller.readiness.blockers.some(
        (blocker) => blocker.status === "loading",
      )
    ) {
      engineText = "预加载中";
      engineClass = "loading";
    } else if (state.status === "choice") {
      engineText = "等待选择";
    } else if (branchActive) {
      engineText = "分支同步";
    } else if (state.status === "playing" && this.controller.audioLocked) {
      engineText = "音画同步";
    }
    engine.className = `engine-state ${engineClass}`;
    engine.querySelector("span")!.textContent = engineText;
    this.renderPreloads();
    this.renderBranchMap();
  }

  private renderTime(timeMs: number, totalMs: number, driftMs: number): void {
    const time = formatTimecode(timeMs);
    this.element("current-time").textContent = time;
    this.element("canvas-timecode").textContent = time;
    this.element("total-time").textContent = formatTimecode(totalMs);
    this.element("mainline-time").textContent = formatTimecode(totalMs);
    this.updatePlayhead(timeMs);
    const sync = this.element("sync-label");
    if (this.controller?.isPlaying) {
      sync.textContent =
        driftMs > 80
          ? `A/V Δ ${Math.round(driftMs)}ms · CORRECTING`
          : `A/V Δ ${Math.round(driftMs)}ms · LOCKED`;
    } else {
      sync.textContent = this.controller?.audioLocked
        ? "AUDIO CLOCK READY"
        : "AUDIO STANDBY";
    }
  }

  private updatePlayhead(timeMs?: number): void {
    const track = this.element("timeline-track");
    if (!track) return;
    const total = Math.max(1, getMainlineDurationMs(this.manifest));
    const value = timeMs ?? this.controller?.state.mainTimeMs ?? 0;
    const ratio = clamp(value / total, 0, 1);
    this.element("playhead").style.left =
      `${track.offsetLeft + ratio * track.clientWidth}px`;
  }

  private handleEditorInput(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const block = target.closest<HTMLElement>(".decision-block");
    if (!block?.dataset.decisionId) return;
    const decisionId = block.dataset.decisionId;
    const optionEditor = target.closest<HTMLElement>(".option-editor");
    const optionId = optionEditor?.dataset.optionId;
    const field = target.dataset.field;
    const optionField = target.dataset.optionField;
    if (!field && !optionField) return;
    if (target.type === "checkbox") return;

    this.mutate((draft) => {
      const decision = draft.decisions.find(
        (candidate) => candidate.id === decisionId,
      );
      if (!decision) return;
      if (field) {
        if (field === "title" || field === "prompt") {
          decision[field] = target.value;
        } else if (
          field === "timelineStartMs" ||
          field === "timelineEndMs" ||
          field === "pauseAtMs"
        ) {
          decision[field] = numberValue(target.value);
        }
      }
      if (optionField) {
        const option = decision.options.find(
          (candidate) => candidate.id === optionId,
        );
        if (!option) return;
        if (
          optionField === "label" ||
          optionField === "hint" ||
          optionField === "targetSegmentId"
        ) {
          option[optionField] = target.value;
        } else if (
          optionField === "targetEndMs" ||
          optionField === "returnToMs"
        ) {
          option[optionField] = numberValue(target.value);
        }
      }
    });
  }

  private handleEditorChange(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const block = target.closest<HTMLElement>(".decision-block");
    if (!block?.dataset.decisionId) return;
    const decisionId = block.dataset.decisionId;
    const optionId = target.closest<HTMLElement>(".option-editor")?.dataset
      .optionId;
    if (target.dataset.optionField === "correct") {
      this.mutate((draft) => {
        const decision = draft.decisions.find(
          (candidate) => candidate.id === decisionId,
        );
        if (!decision) return;
        const checked = target.checked;
        decision.options = decision.options.map((option) =>
          option.id === optionId
            ? { ...option, correct: checked }
            : checked
              ? { ...option, correct: false }
              : option,
        );
      }, true);
      return;
    }
    if (target.tagName === "SELECT" || target.type === "number") {
      this.renderEditor();
      this.renderDerived();
    } else {
      this.renderEditor();
    }
  }

  private handleEditorClick(event: Event): void {
    const target = event.target as HTMLElement;
    const addButton = target.closest<HTMLElement>("[data-add-option]");
    if (addButton?.dataset.addOption) {
      this.addOption(addButton.dataset.addOption);
      return;
    }
    const removeOption = target.closest<HTMLElement>("[data-delete-option]");
    if (removeOption?.dataset.deleteOption) {
      this.removeOption(removeOption.dataset.deleteOption);
      return;
    }
    const removeDecision = target.closest<HTMLElement>(
      "[data-delete-decision]",
    );
    if (removeDecision?.dataset.deleteDecision) {
      this.removeDecision(removeDecision.dataset.deleteDecision);
    }
  }

  private addOption(decisionId: string): void {
    const decision = getDecision(this.manifest, decisionId);
    if (!decision) return;
    const branchSegments = this.manifest.segments.filter(
      (segment) => segment.kind === "branch",
    );
    const used = new Set(decision.options.map((option) => option.targetSegmentId));
    const target =
      branchSegments.find((segment) => !used.has(segment.id)) ??
      branchSegments[0] ??
      this.manifest.segments[1] ??
      this.manifest.segments[0];
    if (!target) {
      this.showToast("请先在清单中定义可用的媒体片段", "error");
      return;
    }
    this.mutate((draft) => {
      const candidate = draft.decisions.find((item) => item.id === decisionId);
      if (!candidate) return;
      candidate.options.push({
        id: createId("option"),
        label: "新分支选项",
        hint: "补充处置说明与反馈",
        targetSegmentId: target.id,
        targetEndMs: Math.max(500, Math.min(4_000, target.durationMs)),
        returnToMs: candidate.timelineStartMs,
        correct: false,
      });
    }, true);
  }

  private removeOption(optionId: string): void {
    this.mutate((draft) => {
      draft.decisions.forEach((decision) => {
        decision.options = decision.options.filter(
          (option) => option.id !== optionId,
        );
      });
    }, true);
  }

  private removeDecision(decisionId: string): void {
    this.mutate((draft) => {
      draft.decisions = draft.decisions.filter(
        (decision) => decision.id !== decisionId,
      );
    }, true);
    if (this.selectedDecisionId === decisionId) {
      this.selectedDecisionId = this.manifest.decisions[0]?.id ?? "";
    }
    this.renderAll();
  }

  private addDecision(): void {
    if (this.manifest.mainline.length === 0) {
      this.showToast("主时间线为空，无法创建决策", "error");
      return;
    }
    const total = getMainlineDurationMs(this.manifest);
    const lastEnd = this.manifest.decisions.reduce(
      (max, decision) => Math.max(max, decision.timelineEndMs),
      0,
    );
    const preferred = Math.max(this.controller.state.mainTimeMs, lastEnd + 600);
    const start = clamp(preferred, 0, Math.max(0, total - 1_200));
    const end = Math.min(total, start + 2_400);
    const branchSegments = this.manifest.segments.filter(
      (segment) => segment.kind === "branch",
    );
    const correctTarget = branchSegments[0] ?? this.manifest.segments[0];
    const wrongTarget =
      branchSegments[1] ?? this.manifest.segments[1] ?? correctTarget;
    if (!correctTarget || !wrongTarget) return;
    const decisionId = createId("decision");
    this.mutate((draft) => {
      draft.decisions.push({
        id: decisionId,
        title: "新决策",
        prompt: "请选择下一步处置方式。",
        timelineStartMs: start,
        timelineEndMs: end,
        pauseAtMs: Math.min(end, start + Math.round((end - start) * 0.6)),
        options: [
          {
            id: createId("option"),
            label: "正确处置",
            hint: "进入正确分支",
            targetSegmentId: correctTarget.id,
            targetEndMs: Math.max(
              500,
              Math.min(4_000, correctTarget.durationMs),
            ),
            returnToMs: Math.min(total, end + 800),
            correct: true,
          },
          {
            id: createId("option"),
            label: "错误处置",
            hint: "播放后回到决策点",
            targetSegmentId: wrongTarget.id,
            targetEndMs: Math.max(
              500,
              Math.min(4_000, wrongTarget.durationMs),
            ),
            returnToMs: start,
            correct: false,
          },
        ],
      });
    });
    this.selectedDecisionId = decisionId;
    this.renderAll();
    this.showToast("已在当前时间线位置新增决策");
  }

  private beginIntervalDrag(event: PointerEvent): void {
    const target = event.target as HTMLElement;
    const range = target.closest<HTMLElement>("[data-decision-drag]");
    if (!range?.dataset.decisionDrag) return;
    const decision = getDecision(
      this.manifest,
      range.dataset.decisionDrag,
    );
    if (!decision) return;
    event.preventDefault();
    const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle;
    this.selectedDecisionId = decision.id;
    this.drag = {
      decisionId: decision.id,
      mode: handle === "start" ? "start" : handle === "end" ? "end" : "move",
      originX: event.clientX,
      startMs: decision.timelineStartMs,
      endMs: decision.timelineEndMs,
    };
    this.renderInspector();
  }

  private updateIntervalDrag(event: PointerEvent): void {
    if (!this.drag) return;
    const track = this.element("timeline-track");
    const total = Math.max(1, getMainlineDurationMs(this.manifest));
    const delta =
      ((event.clientX - this.drag.originX) / Math.max(1, track.clientWidth)) *
      total;
    const width = this.drag.endMs - this.drag.startMs;
    let start = this.drag.startMs;
    let end = this.drag.endMs;
    if (this.drag.mode === "start") {
      start = clamp(this.drag.startMs + delta, 0, end - 120);
    } else if (this.drag.mode === "end") {
      end = clamp(this.drag.endMs + delta, start + 120, total);
    } else {
      start = clamp(this.drag.startMs + delta, 0, Math.max(0, total - width));
      end = start + width;
    }
    this.mutate((draft) => {
      const decision = draft.decisions.find(
        (candidate) => candidate.id === this.drag?.decisionId,
      );
      if (!decision) return;
      decision.timelineStartMs = Math.round(start);
      decision.timelineEndMs = Math.round(end);
      decision.pauseAtMs = Math.round(
        clamp(decision.pauseAtMs, start, end),
      );
    });
  }

  private endIntervalDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.renderEditor();
    this.renderDerived();
    this.showToast("选项区间已更新");
  }

  private async seekFromPointer(event: MouseEvent): Promise<void> {
    const track = this.element("timeline-track");
    const rect = track.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const total = getMainlineDurationMs(this.manifest);
    this.hasInteracted = true;
    this.element("welcome-overlay").hidden = true;
    await this.controller.seekTo(total * ratio);
    this.renderTime(total * ratio, total, 0);
  }

  private mutate(
    transform: (draft: BranchManifest) => void,
    structural = false,
  ): void {
    const draft = cloneManifest(this.manifest);
    transform(draft);
    this.manifest = touchManifest(draft);
    this.revision += 1;
    this.controller.updateManifest(this.manifest);
    if (structural) this.renderAll();
    else this.renderDerived();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    this.setSaveIndicator("正在保存…", true);
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      void this.persist();
    }, 360);
  }

  private async persist(): Promise<void> {
    if (this.saving) {
      this.pendingSave = true;
      return;
    }
    this.saving = true;
    this.pendingSave = false;
    const revision = this.revision;
    const snapshot = cloneManifest(this.manifest);
    const local = saveLocalManifest(snapshot, revision);
    this.origin = "local";
    if (local) this.savedAt = local.savedAt;
    this.serverMirror = "pending";
    this.renderRecovery();
    const mirrored = await saveServerManifest(snapshot);
    this.serverMirror = mirrored ? "ok" : "failed";
    if (revision !== this.revision) this.pendingSave = true;
    this.saving = false;
    this.setSaveIndicator(
      mirrored ? "已自动保存" : "本地已保存 · 镜像失败",
      false,
    );
    this.renderRecovery();
    if (this.pendingSave) void this.persist();
  }

  private setSaveIndicator(text: string, saving: boolean): void {
    const element = this.element("save-state");
    element.classList.toggle("saving", saving);
    element.querySelector("span")!.textContent = text;
  }

  private async importFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseImportedManifest(text);
      const validation = validateManifest(parsed);
      this.applyStoredState(
        {
          manifest: parsed,
          revision: 1,
          savedAt: new Date().toISOString(),
          origin: "local",
        },
        true,
      );
      await this.persist();
      const errors = validation.issues.filter(
        (issue) => issue.severity === "error",
      ).length;
      this.showToast(
        errors
          ? `清单已载入，但仍有 ${errors} 处引用问题`
          : "分支清单已完整载入并恢复",
        errors ? "error" : "info",
      );
    } catch (error) {
      this.showToast(
        error instanceof Error ? error.message : "清单文件无法解析",
        "error",
      );
    }
  }

  private async resetDemo(): Promise<void> {
    try {
      const demo = await readDemoManifest();
      this.applyStoredState(demo, true);
      await this.persist();
      this.showToast("已重新载入内置急救演示");
    } catch (error) {
      this.showToast(
        error instanceof Error ? error.message : "演示清单载入失败",
        "error",
      );
    }
  }

  private refreshValidation(): void {
    const result = validateManifest(this.manifest);
    document
      .querySelectorAll<HTMLElement>(".decision-block")
      .forEach((block, index) => {
        const line = block.querySelector<HTMLElement>(".validation-line");
        if (!line) return;
        const prefix = `decisions[${index}]`;
        const issues = result.issues.filter(
          (issue) =>
            issue.path.startsWith(prefix) && issue.severity === "error",
        );
        line.classList.toggle("has-error", issues.length > 0);
        const text = line.querySelector("span");
        if (text) {
          text.textContent = issues.length
            ? issues[0]?.message ?? "决策配置有误"
            : "区间、目标片段与回主线位置有效";
        }
      });
  }

  private showToast(
    message: string,
    tone: "info" | "error" = "info",
  ): void {
    const toast = this.element("toast");
    toast.textContent = message;
    toast.style.background = tone === "error" ? "#ff8b7b" : "#e9e6df";
    toast.classList.add("visible");
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      toast.classList.remove("visible");
    }, 2_800);
  }

  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`缺少界面元素 #${id}`);
    return element as T;
  }
}

function chip(label: string, value: string): string {
  return `<span class="stat-chip">${escapeHtml(label)}<strong>${escapeHtml(value)}</strong></span>`;
}

function recovery(label: string, value: string): string {
  return `<div class="recovery-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#ff6b4a";
}

function numberValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function formatSavedTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const workbench = new Workbench();
workbench.start().catch((error) => {
  const toast = document.getElementById("toast");
  if (toast) {
    toast.textContent =
      error instanceof Error ? `启动失败：${error.message}` : "启动失败";
    toast.classList.add("visible");
  }
});
