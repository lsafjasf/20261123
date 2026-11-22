import { LayoutEngine } from '/shared/layout.ts';
import { OcclusionMonitor } from '/shared/occlusion.ts';
import { cutEvent } from '/shared/cut.ts';
import { compareSnapshots, type FrameSnapshot } from '/shared/verify.ts';
import {
  DEFAULT_FRAME_RATE,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  defaultHudZones,
  defaultKeyframes,
} from '/shared/preset.ts';
import type {
  LayoutManifest,
  OcclusionResult,
  PanelRects,
  PanelId,
  VerificationResult,
} from '/shared/types.ts';
import { Compositor } from './compositor.ts';
import { InteractionController } from './interaction.ts';
import { CutDetector } from './cut-detector.ts';
import { ManifestBuilder } from './manifest.ts';
import { SyntheticFeed } from './synthetic-source.ts';
import { VideoFileSource } from './video-file-source.ts';
import { AudioMixer, createAudioDataTap } from './audio-mixer.ts';
import { ExportSession } from './export-session.ts';
import { playThroughMediaSource } from './mse-player.ts';

const PANELS: PanelId[] = ['main', 'cams', 'map'];
const TOTAL_FRAMES = 600;
const VERIFY_SAMPLE_FRAMES = [0, 60, 150, 300, 330, 480, 599];
const PIXEL_TOLERANCE = 24;

class MultiviewApp {
  private readonly canvas: HTMLCanvasElement;
  private readonly engine: LayoutEngine;
  private readonly compositor: Compositor;
  private readonly monitor: OcclusionMonitor;
  private readonly cutDetector = new CutDetector(0.25);
  private manifest: ManifestBuilder;
  private interaction: InteractionController;
  private mixer: AudioMixer | null = null;

  private currentFrame = 0;
  private playing = false;
  private rafId = 0;
  private playAnchorMs = 0;
  private playAnchorFrame = 0;
  private exportSession: ExportSession | null = null;
  private previewSnapshots: FrameSnapshot[] = [];
  private lastEncodedFrame = -1;

  constructor() {
    this.canvas = document.getElementById('stage-canvas') as HTMLCanvasElement;
    this.canvas.width = DEFAULT_WIDTH;
    this.canvas.height = DEFAULT_HEIGHT;
    this.engine = new LayoutEngine(DEFAULT_FRAME_RATE, defaultKeyframes());
    const zones = defaultHudZones();
    this.compositor = new Compositor(this.canvas, zones);
    this.monitor = new OcclusionMonitor(zones);
    this.manifest = new ManifestBuilder(
      DEFAULT_FRAME_RATE,
      DEFAULT_WIDTH,
      DEFAULT_HEIGHT,
    );
    this.interaction = new InteractionController(
      this.canvas,
      this.engine,
      () => this.currentFrame,
      () => this.renderSidebar(),
    );
  }

  boot(): void {
    this.bindTransport();
    this.bindSourceSlots();
    this.bindExportControls();
    this.renderSidebar();
    this.renderFrame(true);
    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  private loop(nowMs: number): void {
    if (this.playing) {
      const elapsedSec = (nowMs - this.playAnchorMs) / 1000;
      const target = Math.min(
        TOTAL_FRAMES - 1,
        this.playAnchorFrame + Math.floor(elapsedSec * DEFAULT_FRAME_RATE),
      );
      if (target !== this.currentFrame) {
        this.currentFrame = target;
        if (this.currentFrame >= TOTAL_FRAMES - 1) {
          this.currentFrame = TOTAL_FRAMES - 1;
          this.setPlaying(false);
          this.stopAtEnd();
        }
        this.renderFrame();
      }
    } else {
      this.playAnchorMs = 0;
    }
    this.rafId = requestAnimationFrame(this.loop);
  }

  private setPlaying(value: boolean): void {
    if (value && !this.playing) {
      this.playAnchorMs = performance.now();
      this.playAnchorFrame = this.currentFrame;
    }
    this.playing = value;
    const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
    const pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement;
    playBtn.disabled = value;
    pauseBtn.disabled = !value;
  }

  private renderFrame(force = false): void {
    const sample = this.engine.sample(this.currentFrame);
    this.interaction.setRects(sample.rects);
    const timeSec = this.currentFrame / DEFAULT_FRAME_RATE;
    const { results, events } = this.monitor.evaluate(
      sample.rects,
      this.currentFrame,
      DEFAULT_FRAME_RATE,
    );
    this.compositor.renderFrame(sample, timeSec, results);

    const layoutEvent = this.engine.emitLayoutEvent(this.currentFrame);
    const cutCount = this.detectCuts(sample.rects, sample.transitioning);
    if (this.exportSession) {
      this.manifest.add(layoutEvent);
      this.manifest.addAll(events);
    }
    this.updateOcclusionUi(results);
    this.updateClock();

    if (this.exportSession) {
      const key = this.currentFrame === 0 || sample.segmentIndex !== this.lastSegment;
      if (this.currentFrame > this.lastEncodedFrame) {
        this.exportSession.captureFrame(this.currentFrame, key);
        this.lastEncodedFrame = this.currentFrame;
      }
      this.capturePreviewSnapshot();
    }
    this.lastSegment = sample.segmentIndex;
    if (
      force ||
      Boolean(layoutEvent) ||
      events.length > 0 ||
      cutCount > 0
    ) {
      this.renderEventLog();
    }
  }

  private lastSegment = -1;

  private detectCuts(rects: PanelRects, transitioning: boolean): number {
    let added = 0;
    if (transitioning) return added;
    for (const panel of PANELS) {
      const rect = this.compositor.pixelRect(rects, panel);
      if (rect.width < 8 || rect.height < 8) continue;
      const diff = this.cutDetector.samplePanel(this.compositor, panel, rect);
      if (this.cutDetector.consumeCut(panel, diff, this.currentFrame)) {
        if (this.exportSession) {
          this.manifest.add(
            cutEvent(panel, this.currentFrame, DEFAULT_FRAME_RATE, diff),
          );
        }
        added += 1;
      }
    }
    return added;
  }

  private updateClock(): void {
    const clock = document.getElementById('clock') as HTMLElement;
    const timeSec = this.currentFrame / DEFAULT_FRAME_RATE;
    clock.textContent =
      `${String(this.currentFrame).padStart(4, '0')} / ` +
      `${timeSec.toFixed(2).padStart(6, '0')}s`;
    const scrub = document.getElementById('frame-scrub') as HTMLInputElement;
    scrub.value = String(this.currentFrame);
  }

  private updateOcclusionUi(results: OcclusionResult[]): void {
    const banner = document.getElementById('occlusion-banner') as HTMLElement;
    const blocked = results.filter((r) => r.level === 'blocked');
    const partial = results.filter((r) => r.level === 'partial');
    banner.classList.toggle('hidden', blocked.length === 0 && partial.length === 0);
    banner.classList.toggle('partial', blocked.length === 0 && partial.length > 0);
    banner.textContent = blocked.length
      ? `遮挡警报：${blocked.map((r) => r.zoneId).join(', ')} 关键 HUD 被挡住`
      : `提示：${partial.map((r) => r.zoneId).join(', ')} 部分遮挡`;

    const list = document.getElementById('hud-list') as HTMLElement;
    list.innerHTML = '';
    for (const result of results) {
      const li = document.createElement('li');
      li.innerHTML =
        `<span>${result.zoneId}</span>` +
        `<span class="level-${result.level}">${result.level} ` +
        `${(result.covered * 100).toFixed(0)}%</span>`;
      list.appendChild(li);
    }
  }

  private renderEventLog(): void {
    const log = document.getElementById('event-log') as HTMLElement;
    const data: LayoutManifest = this.manifest.build();
    log.innerHTML = '';
    for (const event of data.events.slice(-40)) {
      const li = document.createElement('li');
      li.textContent = `f${String(event.frame).padStart(4, '0')} ${event.type}: ${event.detail}`;
      log.appendChild(li);
    }
  }

  private bindTransport(): void {
    const scrub = document.getElementById('frame-scrub') as HTMLInputElement;
    scrub.max = String(TOTAL_FRAMES - 1);
    document.getElementById('play-btn')?.addEventListener('click', () => {
      this.setPlaying(true);
      this.mixer?.resume();
    });
    document.getElementById('pause-btn')?.addEventListener('click', () =>
      this.setPlaying(false),
    );
    document.getElementById('step-btn')?.addEventListener('click', () => {
      if (this.exportSession) return;
      this.setPlaying(false);
      this.currentFrame = Math.min(
        TOTAL_FRAMES - 1,
        this.currentFrame + 1,
      );
      this.renderFrame();
    });
    scrub.addEventListener('input', () => {
      if (this.exportSession) {
        scrub.value = String(this.currentFrame);
        return;
      }
      this.setPlaying(false);
      this.currentFrame = Number(scrub.value);
      this.renderFrame();
    });
  }

  private bindSourceSlots(): void {
    const container = document.getElementById('source-slots') as HTMLElement;
    container.innerHTML = '';
    for (const panel of PANELS) {
      const row = document.createElement('div');
      row.className = 'source-row';
      const label = document.createElement('label');
      label.textContent = panel;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*';
      input.addEventListener('change', () => this.attachFile(panel, input));
      row.append(label, input);
      container.appendChild(row);
    }
    document
      .getElementById('synthetic-btn')
      ?.addEventListener('click', () => this.loadSynthetic());
    document
      .getElementById('add-keyframe-btn')
      ?.addEventListener('click', () => this.persistCurrentKeyframe());
  }

  private async attachFile(
    panel: PanelId,
    input: HTMLInputElement,
  ): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    const source = new VideoFileSource(file);
    try {
      await source.ready;
    } catch (err) {
      window.alert(`无法加载 ${file.name}: ${String(err)}`);
      return;
    }
    // Swapping the source only rebinds the panel; layout and head are kept.
    this.compositor.bindSource(panel, source);
    if (!this.mixer) this.mixer = new AudioMixer();
    this.mixer.attachFile(source.id, source.element);
    this.renderFrame();
  }

  private loadSynthetic(): void {
    PANELS.forEach((panel, index) => {
      this.compositor.bindSource(panel, new SyntheticFeed(panel, index));
    });
    if (!this.mixer) {
      this.mixer = new AudioMixer();
      this.mixer.addSyntheticBed('bed-main', 220);
      this.mixer.addSyntheticBed('bed-cams', 330);
      this.mixer.addSyntheticBed('bed-map', 440);
    }
    this.mixer.resume();
    this.renderFrame();
  }

  private persistCurrentKeyframe(): void {
    const sample = this.engine.sample(this.currentFrame);
    this.engine.upsertKeyframe({
      frame: Math.round(this.currentFrame),
      rects: {
        main: { ...sample.rects.main },
        cams: { ...sample.rects.cams },
        map: { ...sample.rects.map },
      },
      label: `keyframe @${Math.round(this.currentFrame)}`,
    });
    this.renderSidebar();
  }

  private renderSidebar(): void {
    const list = document.getElementById('segment-list') as HTMLElement;
    list.innerHTML = '';
    for (const segment of this.engine.segments) {
      const li = document.createElement('li');
      const end = Number.isFinite(segment.endFrame)
        ? segment.endFrame
        : TOTAL_FRAMES;
      li.textContent = `${segment.label}: 帧 ${segment.startFrame}–${end}`;
      list.appendChild(li);
    }
  }

  private bindExportControls(): void {
    document
      .getElementById('record-btn')
      ?.addEventListener('click', () => this.startExport());
    document
      .getElementById('stop-record-btn')
      ?.addEventListener('click', () => this.stopExport());
    document
      .getElementById('manifest-btn')
      ?.addEventListener('click', () =>
        this.manifest.download('layout-manifest.json'),
      );
  }

  private setRecordStatus(text: string): void {
    const status = document.getElementById('record-status') as HTMLElement;
    status.textContent = text;
  }

  private resetTimelineState(): void {
    this.engine.resetEmission();
    this.monitor.reset();
    this.cutDetector.reset();
    this.lastSegment = -1;
    this.manifest = new ManifestBuilder(
      DEFAULT_FRAME_RATE,
      DEFAULT_WIDTH,
      DEFAULT_HEIGHT,
    );
  }

  private async startExport(): Promise<void> {
    try {
      this.resetTimelineState();
      let tap: ReadableStream<AudioData> | null = null;
      if (this.mixer) tap = await createAudioDataTap(this.mixer.stream);
      this.exportSession = await ExportSession.create(
        this.canvas,
        DEFAULT_FRAME_RATE,
        TOTAL_FRAMES,
        this.mixer,
        tap,
      );
      this.previewSnapshots = [];
      this.lastEncodedFrame = -1;
      this.currentFrame = 0;
      this.setPlaying(true);
      this.setRecordButtons(true);
      this.setRecordStatus(
        `导出中… 音频=${this.exportSession.audioEnabled ? 'Opus' : '关闭'}`,
      );
    } catch (err) {
      this.setRecordStatus(`导出失败: ${(err as Error).message}`);
      this.exportSession = null;
    }
  }

  private async stopExport(): Promise<void> {
    if (!this.exportSession) return;
    this.setPlaying(false);
    this.setRecordStatus('封装 WebM…');
    const session = this.exportSession;
    this.exportSession = null;
    try {
      const handles = await session.finalize();
      this.downloadBlob(handles.blob, 'multiview-export.webm');
      this.setRecordStatus(
        `已导出 ${handles.blob.size} 字节，编码 ${handles.codec}，` +
          `音频=${handles.hasAudio ? '有' : '无'}；开始 MSE 校验…`,
      );
      await this.verifyExport(handles.blob);
    } catch (err) {
      this.setRecordStatus(`封装失败: ${(err as Error).message}`);
    } finally {
      this.setRecordButtons(false);
    }
  }

  private setRecordButtons(recording: boolean): void {
    (
      document.getElementById('record-btn') as HTMLButtonElement
    ).disabled = recording;
    (
      document.getElementById('stop-record-btn') as HTMLButtonElement
    ).disabled = !recording;
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private capturePreviewSnapshot(): void {
    if (!VERIFY_SAMPLE_FRAMES.includes(this.currentFrame)) return;
    this.previewSnapshots.push({
      frame: this.currentFrame,
      pixels: this.compositor.snapshotAtWidth(320),
    });
  }

  private async verifyExport(blob: Blob): Promise<void> {
    const video = document.getElementById('verify-video') as HTMLVideoElement;
    const report = document.getElementById('verify-report') as HTMLElement;
    try {
      await playThroughMediaSource(video, blob);
      const exported: FrameSnapshot[] = [];
      const probe = document.createElement('canvas');
      probe.width = 320;
      probe.height = 180;
      const probeCtx = probe.getContext('2d', { alpha: false });
      if (!probeCtx) throw new Error('probe canvas unavailable');

      for (const frame of VERIFY_SAMPLE_FRAMES) {
        const timeSec = frame / DEFAULT_FRAME_RATE;
        await this.seekVideo(video, timeSec);
        probeCtx.drawImage(video, 0, 0, probe.width, probe.height);
        exported.push({
          frame,
          pixels: probeCtx.getImageData(0, 0, probe.width, probe.height).data,
        });
      }

      const result: VerificationResult = compareSnapshots(
        this.previewSnapshots,
        exported,
        PIXEL_TOLERANCE,
      );
      report.textContent = this.formatReport(result);
    } catch (err) {
      report.textContent = `校验失败: ${(err as Error).message}`;
    }
  }

  private seekVideo(
    video: HTMLVideoElement,
    timeSec: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error(`seek timeout @${timeSec}s`)),
        4000,
      );
      video.addEventListener(
        'seeked',
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      video.currentTime = timeSec;
    });
  }

  private formatReport(result: VerificationResult): string {
    const lines = [
      `对比帧数: ${result.comparedFrames}`,
      `超差帧数(>${result.tolerance}): ${result.mismatchedFrames}`,
      `最大通道差: ${result.maxChannelDelta.toFixed(1)}`,
      `平均通道差: ${result.meanChannelDelta.toFixed(2)}`,
      `结论: ${result.passed ? '通过 — 导出与预览一致' : '失败 — 存在不一致帧'}`,
      '',
      '逐帧 maxDelta / meanDelta:',
      ...result.perFrame.map(
        (delta) =>
          `  f${String(delta.frame).padStart(4, '0')}: ` +
          `${delta.maxDelta.toFixed(1)} / ${delta.meanDelta.toFixed(2)}`,
      ),
    ];
    return lines.join('\n');
  }

  private stopAtEnd(): void {
    if (this.exportSession && this.currentFrame >= TOTAL_FRAMES - 1) {
      this.stopExport();
    }
  }
}

const app = new MultiviewApp();
app.boot();
