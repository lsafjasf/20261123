// 应用主控制器：串联 LUT 注册表、颜色时间线、渲染器、WebCodecs/MSE/合成三种画面源。

import { LUTRegistry } from "./core/lutRegistry.ts";
import { ColorTimeline } from "./core/timeline.ts";
import { createSampler, createIdentitySampler, type LUTSampler } from "./core/lutSampler.ts";
import { compareLUTOrder } from "./core/orderExplain.ts";
import { DEFAULT_GRADE_OPTIONS, type ColorNode, type GradeOptions } from "./core/types.ts";
import { GradingRenderer, type CompareMode } from "./render/renderer.ts";
import { CodecEngine, type StreamInfo } from "./media/codecEngine.ts";
import { MSEPlayer } from "./media/msePlayer.ts";
import { SyntheticSource, SyntheticAudio } from "./media/syntheticSource.ts";

type SourceMode = "none" | "synthetic" | "webcodecs" | "mse";

interface AppState {
  mode: SourceMode;
  durationMs: number;
  width: number;
  height: number;
  selectedNodeId: string | null;
  compareMode: CompareMode;
  comparePosition: number;
  options: GradeOptions;
}

class GraderApp {
  private readonly registry = new LUTRegistry();
  private readonly timeline = new ColorTimeline();
  private readonly renderer: GradingRenderer;
  private readonly samplerCache = new Map<string, LUTSampler>();
  private state: AppState = {
    mode: "none",
    durationMs: 10_000,
    width: 960,
    height: 540,
    selectedNodeId: null,
    compareMode: "slider",
    comparePosition: 0.5,
    options: { ...DEFAULT_GRADE_OPTIONS }
  };

  private codecEngine: CodecEngine | null = null;
  private msePlayer: MSEPlayer | null = null;
  private synthetic: SyntheticSource | null = null;
  private syntheticAudio: SyntheticAudio | null = null;
  private rafHandle = 0;
  private syntheticPlaying = false;
  private nodeSeq = 0;
  private meterHandle = 0;

  constructor() {
    const display = document.getElementById("display") as HTMLCanvasElement;
    this.renderer = new GradingRenderer(display);
  }

  init(): void {
    this.detectEngine();
    this.bindStaticControls();
    this.renderTimeline();
    this.renderNodeEditor();
    void this.loadBundledLuts();
  }

  private async loadBundledLuts(): Promise<void> {
    const bundled = [
      "luts/identity.cube",
      "luts/warm_sunset.cube",
      "luts/teal_orange.cube",
      "luts/mono_contrast.cube",
      "luts/warm_4point.3dl"
    ];
    for (const path of bundled) {
      try {
        const response = await fetch(path);
        if (!response.ok) continue;
        this.registry.importText(await response.text(), path.split("/").pop());
      } catch {
        // file:// 直开时 fetch 可能被禁，用户仍可手动导入。
      }
    }
    this.renderLutList();
    this.renderOrderOptions();
  }

  private bindStaticControls(): void {
    document.getElementById("synthetic-btn")!.addEventListener("click", () => void this.startSynthetic());
    document.getElementById("file-input")!.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement;
      if (input.files?.[0]) void this.loadVideoFile(input.files[0]);
    });
    document.getElementById("lut-input")!.addEventListener("change", (event) => {
      void this.importLutFiles((event.target as HTMLInputElement).files);
    });
    document.getElementById("play-btn")!.addEventListener("click", () => void this.togglePlay());
    document.getElementById("stop-btn")!.addEventListener("click", () => this.stop());
    document.getElementById("add-node-btn")!.addEventListener("click", () => this.addNodeAtPlayhead());
    document.getElementById("compare-order-btn")!.addEventListener("click", () => this.compareOrder());
    document.getElementById("volume")!.addEventListener("input", (event) => {
      this.syntheticAudio?.setVolume(Number((event.target as HTMLInputElement).value) * 0.12);
    });

    const intensity = document.getElementById("intensity") as HTMLInputElement;
    intensity.addEventListener("input", () => {
      this.state.options.intensity = Number(intensity.value);
      document.getElementById("intensity-value")!.textContent = `${Math.round(Number(intensity.value) * 100)}%`;
    });
    const threshold = document.getElementById("threshold") as HTMLInputElement;
    threshold.addEventListener("input", () => {
      this.state.options.clipThreshold = Number(threshold.value);
      document.getElementById("threshold-value")!.textContent = `${Math.round(Number(threshold.value) * 100)}%`;
    });
    document.getElementById("highlight-toggle")!.addEventListener("change", (event) => {
      this.state.options.highlightClipping = (event.target as HTMLInputElement).checked;
    });
    document.querySelectorAll<HTMLInputElement>('input[name="compare"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        this.state.compareMode = radio.value as CompareMode;
      });
    });
    document.getElementById("compare-position")!.addEventListener("input", (event) => {
      this.state.comparePosition = Number((event.target as HTMLInputElement).value);
    });
    document.getElementById("scrub")!.addEventListener("input", (event) => {
      this.seek(Number((event.target as HTMLInputElement).value) / 1000);
    });
  }

  private async startSynthetic(): Promise<void> {
    this.teardownSources();
    this.synthetic = new SyntheticSource();
    this.syntheticAudio = new SyntheticAudio();
    this.state.mode = "synthetic";
    this.state.durationMs = 10_000;
    this.state.width = this.synthetic.width;
    this.state.height = this.synthetic.height;
    document.getElementById("source-info")!.textContent =
      `离线合成画面 ${this.state.width}x${this.state.height} @30fps（含合成音频）`;
    await this.syntheticAudio.start();
    this.syntheticPlaying = true;
    document.getElementById("play-btn")!.textContent = "暂停";
    this.runSyntheticLoop();
  }

  private runSyntheticLoop(): void {
    this.startMeter();
    const loop = (): void => {
      if (!this.synthetic || !this.syntheticPlaying) return;
      const elapsed = this.synthetic.currentTimestampMs % this.state.durationMs;
      this.synthetic.nextFrame();
      this.renderFromSynthetic(elapsed);
      this.updateTransport(elapsed);
      this.rafHandle = requestAnimationFrame(loop);
    };
    loop();
  }

  private startMeter(): void {
    cancelAnimationFrame(this.meterHandle);
    const analyser = this.syntheticAudio?.getAnalyser();
    if (!analyser) return;
    const buffer = new Uint8Array(analyser.fftSize);
    const tick = (): void => {
      const current = this.syntheticAudio?.getAnalyser();
      if (!current) return;
      current.getByteTimeDomainData(buffer);
      let peak = 0;
      for (const value of buffer) peak = Math.max(peak, Math.abs(value - 128) / 128);
      (document.getElementById("level-meter") as HTMLMeterElement).value = peak;
      this.meterHandle = requestAnimationFrame(tick);
    };
    tick();
  }

  private renderFromSynthetic(elapsedMs: number): void {
    if (!this.synthetic) return;
    const sample = this.timeline.sampleAt(elapsedMs / 1000);
    const stats = this.renderer.render({
      source: this.synthetic.getCanvas(),
      width: this.state.width,
      height: this.state.height,
      sampler: this.samplerForNode(sample ? sample.fromLutId : null, Boolean(sample)),
      secondSampler: sample ? this.samplerForNode(sample.toLutId, true) : null,
      mix: sample?.mix ?? 0,
      options: this.resolveOptions(sample?.intensity ?? this.state.options.intensity),
      compareMode: this.state.compareMode,
      comparePosition: this.state.comparePosition
    });
    this.updateStats(stats);
  }

  private resolveOptions(intensity: number): GradeOptions {
    return { ...this.state.options, intensity };
  }

  private updateStats(stats: { clipped: number; outOfGamut: number; invalidSample: number; total: number }): void {
    const overlay = document.getElementById("stats-overlay")!;
    const pct = (value: number): string => ((value / Math.max(1, stats.total)) * 100).toFixed(1);
    overlay.innerHTML =
      `过曝 <b style="color:#ff5c8a">${stats.clipped}</b> (${pct(stats.clipped)}%)<br>` +
      `越界 <b style="color:#39d8d8">${stats.outOfGamut}</b> (${pct(stats.outOfGamut)}%)<br>` +
      `非法采样 <b style="color:#ff6b6b">${stats.invalidSample}</b>`;
  }

  private updateTransport(elapsedMs: number): void {
    const scrub = document.getElementById("scrub") as HTMLInputElement;
    scrub.value = String((elapsedMs / this.state.durationMs) * 1000);
    document.getElementById("time-label")!.textContent =
      `${(elapsedMs / 1000).toFixed(2)} / ${(this.state.durationMs / 1000).toFixed(2)} s`;
    document.getElementById("playhead")!.style.left = `${(elapsedMs / this.state.durationMs) * 100}%`;
  }

  private async loadVideoFile(file: File): Promise<void> {
    this.teardownSources();
    const buffer = await file.arrayBuffer();
    if (CodecEngine.isSupported()) {
      await this.startWebCodecs(buffer, file.name);
    } else if (MSEPlayer.isSupported()) {
      await this.startMse(buffer, file.name);
    } else {
      throw new Error("当前浏览器既不支持 WebCodecs 也不支持 MediaSource");
    }
  }

  private async startWebCodecs(buffer: ArrayBuffer, name: string): Promise<void> {
    const engine = new CodecEngine({
      onVideoFrame: (frame, timestampMs) => this.handleDecodedFrame(frame, timestampMs),
      onReady: (info: StreamInfo) => this.handleStreamReady(info, "WebCodecs", name),
      onEnded: () => this.handleEnded(),
      onError: (error) => this.showError(error)
    });
    this.codecEngine = engine;
    await engine.load(buffer);
    this.state.mode = "webcodecs";
  }

  private async startMse(buffer: ArrayBuffer, name: string): Promise<void> {
    const video = document.getElementById("mse-video") as HTMLVideoElement;
    const player = new MSEPlayer(video);
    this.msePlayer = player;
    const info = await player.load(buffer);
    this.state.mode = "mse";
    this.state.durationMs = info.durationMs;
    video.hidden = false;
    video.requestVideoFrameCallback(() => this.drawMseFrame());
    document.getElementById("source-info")!.textContent =
      `${name} · MediaSource · ${info.videoCodec} / ${info.audioCodec}`;
  }

  private handleStreamReady(info: StreamInfo, engineName: string, name: string): void {
    this.state.durationMs = info.durationMs || this.state.durationMs;
    this.state.width = info.width;
    this.state.height = info.height;
    document.getElementById("source-info")!.textContent =
      `${name} · ${engineName} · ${info.videoCodec} / ${info.audioCodec} · ${info.width}x${info.height}`;
  }

  private handleDecodedFrame(frame: VideoFrame, timestampMs: number): void {
    const sample = this.timeline.sampleAt(timestampMs / 1000);
    const stats = this.renderer.render({
      source: frame,
      width: frame.codedWidth,
      height: frame.codedHeight,
      sampler: this.samplerForNode(sample ? sample.fromLutId : null, Boolean(sample)),
      secondSampler: sample ? this.samplerForNode(sample.toLutId, true) : null,
      mix: sample?.mix ?? 0,
      options: this.resolveOptions(sample?.intensity ?? this.state.options.intensity),
      compareMode: this.state.compareMode,
      comparePosition: this.state.comparePosition
    });
    this.updateStats(stats);
    this.updateTransport(timestampMs);
    frame.close();
  }

  private drawMseFrame(): void {
    const video = this.msePlayer?.getVideoElement();
    if (!video || !this.msePlayer || this.state.mode !== "mse") return;
    const width = video.videoWidth || this.state.width;
    const height = video.videoHeight || this.state.height;
    const timestampMs = this.msePlayer.currentTimeMs;
    const sample = this.timeline.sampleAt(timestampMs / 1000);
    const stats = this.renderer.render({
      source: video,
      width,
      height,
      sampler: this.samplerForNode(sample ? sample.fromLutId : null, Boolean(sample)),
      secondSampler: sample ? this.samplerForNode(sample.toLutId, true) : null,
      mix: sample?.mix ?? 0,
      options: this.resolveOptions(sample?.intensity ?? this.state.options.intensity),
      compareMode: this.state.compareMode,
      comparePosition: this.state.comparePosition
    });
    this.updateStats(stats);
    this.updateTransport(timestampMs);
    video.requestVideoFrameCallback(() => this.drawMseFrame());
  }

  private async togglePlay(): Promise<void> {
    if (this.state.mode === "synthetic") {
      this.syntheticPlaying = !this.syntheticPlaying;
      document.getElementById("play-btn")!.textContent = this.syntheticPlaying ? "暂停" : "播放";
      if (this.syntheticPlaying) await this.startSyntheticLoopOnly();
      else await this.suspendSyntheticAudio();
    } else if (this.state.mode === "webcodecs") {
      if (this.codecEngine?.isPlaying) this.codecEngine.pause();
      else await this.codecEngine?.play();
    } else if (this.state.mode === "mse") {
      if (this.msePlayer?.isPlaying) this.msePlayer.pause();
      else await this.msePlayer?.play();
    }
  }

  private async startSyntheticLoopOnly(): Promise<void> {
    await this.syntheticAudio?.start();
    this.runSyntheticLoop();
  }

  private stop(): void {
    if (this.state.mode === "synthetic") {
      this.syntheticPlaying = false;
      cancelAnimationFrame(this.rafHandle);
      this.synthetic?.reset();
      void this.suspendSyntheticAudio();
    } else if (this.state.mode === "webcodecs") {
      this.codecEngine?.pause();
    } else {
      this.msePlayer?.pause();
    }
  }

  private async suspendSyntheticAudio(): Promise<void> {
    const analyser = this.syntheticAudio?.getAnalyser();
    if (analyser) await analyser.context.suspend();
  }

  private seek(fraction: number): void {
    const targetMs = fraction * this.state.durationMs;
    if (this.state.mode === "mse") {
      this.msePlayer!.getVideoElement().currentTime = targetMs / 1000;
    }
    this.updateTransport(targetMs);
  }

  private handleEnded(): void {
    document.getElementById("play-btn")!.textContent = "播放";
  }

  private showError(error: Error): void {
    document.getElementById("source-info")!.textContent = `错误：${error.message}`;
  }

  private teardownSources(): void {
    cancelAnimationFrame(this.rafHandle);
    cancelAnimationFrame(this.meterHandle);
    this.syntheticPlaying = false;
    this.codecEngine?.dispose();
    this.codecEngine = null;
    this.msePlayer?.dispose();
    this.msePlayer = null;
    this.syntheticAudio?.stop();
    this.syntheticAudio = null;
    this.synthetic = null;
  }

  private async importLutFiles(files: FileList | null): Promise<void> {
    if (!files) return;
    const messages: string[] = [];
    for (const file of Array.from(files)) {
      const text = await file.text();
      try {
        const result = this.registry.importText(text, file.name);
        messages.push(result.duplicated ? `「${result.lut.title}」重复导入已去重` : `已导入「${result.lut.title}」`);
      } catch (error) {
        messages.push(`「${file.name}」导入失败：${(error as Error).message}`);
      }
    }
    document.getElementById("lut-hint")!.textContent = messages.join("；");
    this.renderLutList();
    this.renderOrderOptions();
  }

  private renderLutList(): void {
    const list = document.getElementById("lut-list")!;
    list.replaceChildren();
    for (const lut of this.registry.list()) {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = lut.title;
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = `${lut.format} ${lut.size}³ · ${lut.id.slice(0, 8)}`;
      item.append(name, tag);
      list.append(item);
    }
  }

  private renderOrderOptions(): void {
    for (const selectId of ["order-a", "order-b"]) {
      const select = document.getElementById(selectId) as HTMLSelectElement;
      const current = select.value;
      select.replaceChildren();
      for (const lut of this.registry.list()) {
        const option = document.createElement("option");
        option.value = lut.id;
        option.textContent = lut.title;
        select.append(option);
      }
      if (current) select.value = current;
    }
  }

  private compareOrder(): void {
    const aId = (document.getElementById("order-a") as HTMLSelectElement).value;
    const bId = (document.getElementById("order-b") as HTMLSelectElement).value;
    const lutA = this.registry.get(aId);
    const lutB = this.registry.get(bId);
    const output = document.getElementById("order-result")!;
    if (!lutA || !lutB) {
      output.textContent = "请先导入并选择两个 LUT。";
      return;
    }
    const result = compareLUTOrder(lutA, lutB);
    output.textContent =
      `${result.explanation}\n\n采样点 ${result.sampleCount}，差异点占比 ${(result.differingRatio * 100).toFixed(1)}%，` +
      `平均色差 ${result.meanAbsDiff.toFixed(5)}，最大 ${result.maxAbsDiff.toFixed(5)}。`;
  }

  private addNodeAtPlayhead(): void {
    const time = this.currentTimeSeconds();
    const firstLut = this.registry.list()[0]?.id ?? null;
    const node: ColorNode = {
      id: `node-${this.nodeSeq++}`,
      time,
      lutId: firstLut,
      intensity: this.state.options.intensity
    };
    this.timeline.addNode(node);
    this.state.selectedNodeId = node.id;
    this.renderTimeline();
    this.renderNodeEditor();
  }

  private currentTimeSeconds(): number {
    if (this.state.mode === "webcodecs") return (this.codecEngine?.currentTimeMs ?? 0) / 1000;
    if (this.state.mode === "mse") return (this.msePlayer?.currentTimeMs ?? 0) / 1000;
    if (this.synthetic) return this.synthetic.currentTimestampMs / 1000;
    return Number((document.getElementById("scrub") as HTMLInputElement).value) * (this.state.durationMs / 1000000);
  }

  private renderTimeline(): void {
    const track = document.getElementById("timeline-track")!;
    track.querySelectorAll(".node-marker").forEach((marker) => marker.remove());
    const durationSeconds = this.state.durationMs / 1000;
    for (const node of this.timeline.getNodes()) {
      const marker = document.createElement("div");
      marker.className = "node-marker" + (node.id === this.state.selectedNodeId ? " selected" : "");
      marker.style.left = `${(node.time / durationSeconds) * 100}%`;
      marker.title = `${node.time.toFixed(2)}s`;
      marker.addEventListener("click", () => {
        this.state.selectedNodeId = node.id;
        this.renderTimeline();
        this.renderNodeEditor();
      });
      track.append(marker);
    }
  }

  private renderNodeEditor(): void {
    const editor = document.getElementById("node-editor")!;
    const node = this.timeline.getNodes().find((item) => item.id === this.state.selectedNodeId);
    if (!node) {
      editor.innerHTML = `<p class="hint">点击时间线上的节点进行编辑，或先添加一个节点。</p>`;
      return;
    }
    editor.replaceChildren();
    const lutLabel = document.createElement("label");
    lutLabel.textContent = "节点 LUT";
    const select = document.createElement("select");
    const noneOption = document.createElement("option");
    noneOption.value = "";
    noneOption.textContent = "（直通，不套 LUT）";
    select.append(noneOption);
    for (const lut of this.registry.list()) {
      const option = document.createElement("option");
      option.value = lut.id;
      option.textContent = lut.title;
      if (lut.id === node.lutId) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", () => {
      this.timeline.updateNode(node.id, { lutId: select.value || null });
    });
    lutLabel.append(select);

    const intensityLabel = document.createElement("label");
    intensityLabel.textContent = `节点强度 ${Math.round(node.intensity * 100)}%`;
    const intensityInput = document.createElement("input");
    intensityInput.type = "range";
    intensityInput.min = "0";
    intensityInput.max = "1";
    intensityInput.step = "0.01";
    intensityInput.value = String(node.intensity);
    intensityInput.addEventListener("input", () => {
      this.timeline.updateNode(node.id, { intensity: Number(intensityInput.value) });
      intensityLabel.textContent = `节点强度 ${Math.round(Number(intensityInput.value) * 100)}%`;
    });
    intensityLabel.append(intensityInput);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "删除该节点";
    deleteButton.addEventListener("click", () => {
      this.timeline.removeNode(node.id);
      this.state.selectedNodeId = null;
      this.renderTimeline();
      this.renderNodeEditor();
    });

    editor.append(lutLabel, intensityLabel, deleteButton);
  }

  private detectEngine(): void {
    const badge = document.getElementById("engine-badge")!;
    if (CodecEngine.isSupported()) {
      badge.textContent = "WebCodecs 可用（首选）";
      badge.style.color = "#7ee0a0";
    } else if (MSEPlayer.isSupported()) {
      badge.textContent = "WebCodecs 不可用，使用 MediaSource 回退";
      badge.style.color = "#ffd166";
    } else {
      badge.textContent = "仅支持离线合成画面";
      badge.style.color = "#ff8f8f";
    }
  }

  private getSampler(lutId: string | null): LUTSampler | null {
    if (!lutId) return null;
    const cached = this.samplerCache.get(lutId);
    if (cached) return cached;
    const lut = this.registry.get(lutId);
    if (!lut) return null;
    const sampler = createSampler(lut);
    this.samplerCache.set(lutId, sampler);
    return sampler;
  }

  private identitySampler: LUTSampler | null = null;

  /** 节点 LUT 为直通时返回恒等采样器，确保与相邻 LUT 节点的交叉混合有效。 */
  private samplerForNode(lutId: string | null, hasNode: boolean): LUTSampler | null {
    if (lutId) return this.getSampler(lutId);
    if (hasNode) {
      this.identitySampler ??= createIdentitySampler();
      return this.identitySampler;
    }
    return null;
  }
}

const app = new GraderApp();
app.init();
