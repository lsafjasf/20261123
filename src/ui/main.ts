/**
 * 页面主控制器：DOM 事件 -> reducer -> Canvas/面板渲染 -> 导出。
 * 所有算法仍来自 core / audio，本文件只做浏览器胶水。
 */

import { buildDemoTrack } from "../audio/demo.ts";
import { analyzeAudio, decodeAudioFile } from "../audio/webaudio.ts";
import { buildCutRows, toCsv, toJson } from "../core/cutlist.ts";
import type { Clip, Project } from "../core/types.ts";
import { formatTimecode } from "../core/timeline.ts";
import { suggestSafeTime } from "../core/speech.ts";
import { RENDER_WIDTH, RENDER_HEIGHT, renderFrame } from "./canvas-render.ts";
import {
  downloadBlob,
  downloadText,
  exportWebm,
  openMediaSource,
} from "./exporter.ts";
import { initialState, reduce, type Action, type AppState } from "./state.ts";
import { TIMELINE_HEIGHT, TimelineView } from "./timeline-view.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

class App {
  private state: AppState = initialState();
  private timeline: TimelineView | null = null;
  private audioContext: AudioContext | null = null;
  private audioBuffer: AudioBuffer | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private playStartedAt = 0;
  private playOffset = 0;
  private rafId = 0;
  private readonly canvas = $<HTMLCanvasElement>("preview");
  private readonly timelineCanvas = $<HTMLCanvasElement>("timeline");

  constructor() {
    this.timelineCanvas.width = 1040;
    this.timelineCanvas.height = TIMELINE_HEIGHT;
    this.bindUi();
    this.fitTimelineWidth();
    window.addEventListener("resize", () => {
      this.fitTimelineWidth();
      this.render();
    });
    this.render();
  }

  private fitTimelineWidth(): void {
    const width = Math.max(480, this.timelineCanvas.clientWidth || 1040);
    if (this.timelineCanvas.width !== width) this.timelineCanvas.width = width;
  }

  private dispatch(action: Action): void {
    this.state = reduce(this.state, action);
    this.render();
  }

  private bindUi(): void {
    $("btn-demo").addEventListener("click", () => this.loadDemo());
    $<HTMLInputElement>("file-audio").addEventListener("change", (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) this.loadAudioFile(file);
    });
    $("btn-replan").addEventListener("click", () => this.dispatch({ type: "replan" }));
    $("btn-play").addEventListener("click", () => this.togglePlay());
    $<HTMLInputElement>("zoom").addEventListener("input", (event) => {
      this.dispatch({ type: "set-zoom", pxPerSec: Number((event.target as HTMLInputElement).value) });
    });
    $<HTMLInputElement>("min-duration").addEventListener("change", (event) => {
      const seconds = Number((event.target as HTMLInputElement).value);
      this.state = reduce(this.state, { type: "set-min-duration", clipId: null, seconds });
      this.render();
    });
    $<HTMLInputElement>("downbeat-bias").addEventListener("input", (event) => {
      const bias = Number((event.target as HTMLInputElement).value);
      $("downbeat-bias-val").textContent = bias.toFixed(2);
      this.dispatch({
        type: "set-bias",
        downbeatBias: bias,
        maxSnapDistance: this.state.planner.maxSnapDistance,
      });
    });
    $<HTMLInputElement>("snap-distance").addEventListener("input", (event) => {
      const snap = Number((event.target as HTMLInputElement).value);
      $("snap-distance-val").textContent = `${snap.toFixed(2)}s`;
      this.dispatch({
        type: "set-bias",
        downbeatBias: this.state.planner.downbeatBias,
        maxSnapDistance: snap,
      });
    });
    $("btn-export-csv").addEventListener("click", () => this.exportCutList("csv"));
    $("btn-export-json").addEventListener("click", () => this.exportCutList("json"));
    $("btn-export-video").addEventListener("click", () => this.exportVideo());
  }

  private async loadDemo(): Promise<void> {
    this.stopPlay();
    const demo = buildDemoTrack();
    const audioCtx = this.ensureAudioContext();
    const buffer = await audioCtx.decodeAudioData(demo.wav.buffer.slice(0));
    this.audioBuffer = buffer;
    const analysis = analyzeAudio(buffer);
    const waveform = this.downsampleWaveform(analysis.pcm);
    const project: Project = {
      clips: demo.clips,
      beats: analysis.beats,
      cuts: [],
      speech: analysis.speech,
      duration: demo.durationSec,
    };
    this.dispatch({ type: "load", project, waveform });
    this.setButtonsEnabled(true);
  }

  private async loadAudioFile(file: File): Promise<void> {
    this.stopPlay();
    const bytes = await file.arrayBuffer();
    const buffer = await decodeAudioFile(bytes, this.ensureAudioContext());
    this.audioBuffer = buffer;
    const analysis = analyzeAudio(buffer);
    const waveform = this.downsampleWaveform(analysis.pcm);
    const clips = this.deriveClips(analysis.durationSec);
    const project: Project = {
      clips,
      beats: analysis.beats,
      cuts: [],
      speech: analysis.speech,
      duration: analysis.durationSec,
    };
    this.dispatch({ type: "load", project, waveform });
    this.setButtonsEnabled(true);
  }

  /** 导入外部音频时仍按故事线切 8 段等长片段，用户可再调强弱。 */
  private deriveClips(duration: number): Clip[] {
    const weights: Clip["weight"][] = [
      "strong", "normal", "strong", "weak",
      "strong", "normal", "weak", "normal",
    ];
    const each = duration / 8;
    return Array.from({ length: 8 }, (_, index) => ({
      id: `clip-${index + 1}`,
      name: `片段 ${index + 1}`,
      start: index * each,
      duration: each,
      weight: weights[index],
      source: { sourceId: `import-${index + 1}`, inPoint: 0 },
    }));
  }

  private ensureAudioContext(): AudioContext {
    if (!this.audioContext) this.audioContext = new AudioContext();
    return this.audioContext;
  }

  private downsampleWaveform(pcm: Float32Array, target = 1600): Float32Array {
    const bucket = Math.max(1, Math.floor(pcm.length / target));
    const out = new Float32Array(Math.min(target, Math.ceil(pcm.length / bucket)));
    for (let i = 0; i < out.length; i++) {
      let peak = 0;
      for (let j = i * bucket; j < (i + 1) * bucket && j < pcm.length; j++) {
        peak = Math.max(peak, Math.abs(pcm[j]));
      }
      out[i] = peak;
    }
    return out;
  }

  private setButtonsEnabled(enabled: boolean): void {
    for (const id of ["btn-replan", "btn-play", "btn-export-video", "btn-export-csv", "btn-export-json"]) {
      $<HTMLButtonElement>(id).disabled = !enabled;
    }
  }

  private render(): void {
    const { project } = this.state;
    if (project.clips.length === 0) return;
    renderFrame(this.canvas, this.state.playhead, {
      clips: project.clips,
      beats: project.beats,
      cuts: project.cuts,
    });
    $("play-time").textContent = formatTimecode(this.state.playhead);

    if (!this.timeline) {
      this.timeline = new TimelineView(
        this.timelineCanvas,
        this.timelineState(),
        {
          onDrag: (cutId, time) => this.dispatch({ type: "drag-cut", cutId, requestedTime: time }),
          onDragEnd: () => this.renderInspector(),
          onSelect: (cutId) => {
            this.state = reduce(this.state, { type: "select", cutId });
            this.renderInspector();
          },
        },
      );
    } else {
      this.timeline.update(this.timelineState());
    }
    this.renderClipEditor();
    this.renderInspector();
    this.renderIssues();
  }

  private timelineState() {
    return {
      clips: this.state.project.clips,
      beats: this.state.project.beats,
      cuts: this.state.project.cuts,
      speech: this.state.project.speech,
      waveform: this.state.waveform,
      duration: this.state.project.duration,
      pxPerSec: this.state.pxPerSec,
      playhead: this.state.playhead,
      selectedCutId: this.state.selectedCutId,
    };
  }

  private renderClipEditor(): void {
    const host = $("clip-editor");
    host.innerHTML = "";
    this.state.project.clips.forEach((clip, index) => {
      const card = document.createElement("div");
      card.className = "clip-card";
      const override = this.state.planner.minDurationOverrides[clip.id];
      card.innerHTML = `
        <div class="row">
          <strong>${index + 1}. ${clip.name}</strong>
          <select data-role="weight">
            <option value="strong" ${clip.weight === "strong" ? "selected" : ""}>强</option>
            <option value="normal" ${clip.weight === "normal" ? "selected" : ""}>中</option>
            <option value="weak" ${clip.weight === "weak" ? "selected" : ""}>弱</option>
          </select>
        </div>
        <div class="fields">
          <label>最短停留
            <input data-role="min" type="number" min="0.3" step="0.1"
              value="${(override ?? this.state.planner.defaultMinDuration).toFixed(1)}" />
          </label>
          <label>入点(秒)
            <input data-role="in" type="number" min="0" step="0.1"
              value="${clip.source.inPoint.toFixed(1)}" />
          </label>
        </div>`;
      card.querySelector<HTMLSelectElement>('[data-role="weight"]')!.addEventListener("change", (event) => {
        this.dispatch({
          type: "set-weight",
          clipId: clip.id,
          weight: (event.target as HTMLSelectElement).value as Clip["weight"],
        });
      });
      card.querySelector<HTMLInputElement>('[data-role="min"]')!.addEventListener("change", (event) => {
        this.dispatch({
          type: "set-min-duration",
          clipId: clip.id,
          seconds: Number((event.target as HTMLInputElement).value),
        });
      });
      card.querySelector<HTMLInputElement>('[data-role="in"]')!.addEventListener("change", (event) => {
        this.dispatch({
          type: "set-in-point",
          clipId: clip.id,
          inPoint: Number((event.target as HTMLInputElement).value),
        });
      });
      host.appendChild(card);
    });
  }

  private renderInspector(): void {
    const host = $("cut-inspector");
    const cut = this.state.project.cuts.find((item) => item.id === this.state.selectedCutId);
    if (!cut) {
      host.innerHTML = '<p class="hint">在时间线上点击三角手柄选择并拖动切点。</p>';
      return;
    }
    const index = this.state.project.cuts.indexOf(cut);
    const neighbor = {
      prevTime: this.state.project.cuts[index - 1]?.time ?? 0,
      nextTime: this.state.project.cuts[index + 1]?.time ?? this.state.project.duration,
    };
    const safe = suggestSafeTime(cut, this.state.project.speech, neighbor);
    host.innerHTML = `
      <dl>
        <dt>当前时刻</dt><dd class="mono">${formatTimecode(cut.time)}（${cut.time.toFixed(3)}s）</dd>
        <dt>系统建议</dt><dd class="mono">${formatTimecode(cut.suggestedTime)}</dd>
        <dt>偏移</dt><dd>${(cut.time - cut.suggestedTime >= 0 ? "+" : "")}${(cut.time - cut.suggestedTime).toFixed(3)}s</dd>
        <dt>吸附节拍</dt><dd>${cut.beatTime !== null ? formatTimecode(cut.beatTime) : "未吸附"}</dd>
        <dt>状态</dt><dd class="${cut.manual ? "manual" : ""}">${cut.manual ? "手动拖动（重算保留）" : "系统生成"}</dd>
        <dt>安全替代</dt><dd class="mono">${formatTimecode(safe)}</dd>
      </dl>
      <div class="row" style="margin-top:8px; display:flex; gap:8px;">
        <button data-role="safe" type="button">移到安全位置</button>
        <button data-role="reset" type="button">复位此切点</button>
      </div>`;
    host.querySelector<HTMLButtonElement>('[data-role="safe"]')!.addEventListener("click", () => {
      this.dispatch({ type: "drag-cut", cutId: cut.id, requestedTime: safe });
    });
    host.querySelector<HTMLButtonElement>('[data-role="reset"]')!.addEventListener("click", () => {
      this.dispatch({ type: "reset-cut", cutId: cut.id });
    });
  }

  private renderIssues(): void {
    const list = $("issue-list");
    list.innerHTML = "";
    if (this.state.issues.length === 0) {
      const ok = document.createElement("li");
      ok.className = "ok";
      ok.textContent = "全部切点通过：没有拦腰切断说话，且满足最短停留。";
      list.appendChild(ok);
      return;
    }
    for (const issue of this.state.issues) {
      const li = document.createElement("li");
      li.textContent = `${formatTimecode(issue.time)} · ${issue.message}`;
      list.appendChild(li);
    }
  }

  private togglePlay(): void {
    if (this.sourceNode) {
      this.stopPlay();
      return;
    }
    if (!this.audioContext || !this.audioBuffer) return;
    const ctx = this.audioContext;
    const source = ctx.createBufferSource();
    source.buffer = this.audioBuffer;
    source.connect(ctx.destination);
    const offset = Math.min(this.playOffset, this.audioBuffer.duration);
    source.start(0, offset);
    this.sourceNode = source;
    this.playStartedAt = ctx.currentTime - offset;
    $<HTMLButtonElement>("btn-play").textContent = "暂停";
    source.onended = () => {
      if (this.sourceNode === source) this.stopPlay(true);
    };
    const tick = (): void => {
      if (!this.sourceNode) return;
      const time = Math.min(this.audioBuffer?.duration ?? 0, ctx.currentTime - this.playStartedAt);
      this.state = reduce(this.state, { type: "set-playhead", time });
      renderFrame(this.canvas, time, {
        clips: this.state.project.clips,
        beats: this.state.project.beats,
        cuts: this.state.project.cuts,
      });
      this.timeline?.update(this.timelineState());
      $("play-time").textContent = formatTimecode(time);
      if (time >= this.state.project.duration) {
        this.stopPlay(true);
        return;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopPlay(reset = false): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.onended = null;
        this.sourceNode.stop();
      } catch {
        // 已停止的节点再 stop 会抛错，忽略。
      }
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    cancelAnimationFrame(this.rafId);
    this.playOffset = reset ? 0 : Math.max(0, (this.audioContext?.currentTime ?? 0) - this.playStartedAt);
    if (reset) {
      this.playOffset = 0;
      this.state = reduce(this.state, { type: "set-playhead", time: 0 });
      this.render();
    }
    $<HTMLButtonElement>("btn-play").textContent = "播放";
  }

  private exportCutList(kind: "csv" | "json"): void {
    const rows = buildCutRows(this.state.project.cuts, this.state.project.speech);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (kind === "csv") {
      downloadText(toCsv(rows), `cutlist-${stamp}.csv`, "text/csv;charset=utf-8");
    } else {
      downloadText(
        toJson(
          rows,
          this.state.project.clips,
          this.state.project.speech,
          this.state.project.duration,
          new Date().toISOString(),
        ),
        `cutlist-${stamp}.json`,
        "application/json",
      );
    }
  }

  private async exportVideo(): Promise<void> {
    if (!this.audioBuffer) return;
    const button = $<HTMLButtonElement>("btn-export-video");
    const progress = $<HTMLProgressElement>("export-progress");
    const status = $("export-status");
    button.disabled = true;
    progress.value = 0;
    status.textContent = "正在编码 VP9 画面…";
    try {
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = RENDER_WIDTH;
      exportCanvas.height = RENDER_HEIGHT;
      const pcm = this.buildExportPcm();
      const result = await exportWebm(
        exportCanvas,
        {
          clips: this.state.project.clips,
          beats: this.state.project.beats,
          cuts: this.state.project.cuts,
        },
        this.state.project.duration,
        pcm,
        {
          frameRate: 30,
          sampleRate: this.audioBuffer.sampleRate,
          audioChannels: 1,
          onProgress: (ratio) => {
            progress.value = Math.round(ratio * 100);
          },
        },
      );
      status.textContent = `编码完成：${result.frameCount} 帧，${(result.bytes / 1024).toFixed(1)} KiB`;
      downloadBlob(result.blob, "beatcut-export.webm");
      const preview = $<HTMLVideoElement>("export-preview");
      preview.hidden = false;
      openMediaSource(preview, result.blob);
    } catch (error) {
      status.textContent = `导出失败：${(error as Error).message}`;
    } finally {
      button.disabled = false;
    }
  }

  /** 把时间线音频转成单声道 f32-planar PCM，长度对齐画面时长。 */
  private buildExportPcm(): Float32Array {
    const buffer = this.audioBuffer!;
    const channels: Float32Array[] = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    const needed = Math.ceil(this.state.project.duration * buffer.sampleRate);
    const mono = new Float32Array(needed);
    for (let i = 0; i < needed; i++) {
      let sum = 0;
      for (const channel of channels) sum += channel[i] ?? 0;
      mono[i] = sum / channels.length;
    }
    return mono;
  }
}

const app = new App();
void app;
