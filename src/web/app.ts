import type { ExportManifest, Project } from "../shared/types.ts";
import { buildExportManifest, buildPlans } from "../shared/timeline.ts";
import { loadImages, renderFrame, type RenderContext } from "./renderer.ts";
import { PreviewMixer, renderNarration } from "./audio.ts";
import { encodeVideo } from "./encoder.ts";
import { canPlay, playBytes } from "./mse-player.ts";

interface AppState {
  project: Project;
  render: RenderContext;
  audioDuration?: number;
}

async function loadProject(url: string): Promise<Project> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`project load failed: ${response.status}`);
  }
  return await response.json() as Project;
}

async function probeFullNarration(project: Project): Promise<number | undefined> {
  if (!project.narration.fullNarrationSrc) {
    return undefined;
  }
  const response = await fetch(project.narration.fullNarrationSrc);
  if (!response.ok) {
    return undefined;
  }
  const context = new OfflineAudioContext(2, 1, 48000);
  const buffer = await context.decodeAudioData(await response.arrayBuffer());
  return buffer.duration;
}

class PreviewController {
  private readonly state: AppState;
  private readonly canvas: HTMLCanvasElement;
  private mixer: PreviewMixer | undefined;
  private rafId = 0;
  private startWallTime = 0;
  private offset = 0;
  private playing = false;

  constructor(state: AppState, canvas: HTMLCanvasElement) {
    this.state = state;
    this.canvas = canvas;
  }

  private draw(time: number): void {
    renderFrame(this.state.render, Math.min(time, this.state.render.timeline.duration));
  }

  private tick = (): void => {
    if (!this.playing) {
      return;
    }
    const time = this.offset + (performance.now() - this.startWallTime) / 1000;
    if (time >= this.state.render.timeline.duration) {
      this.pause();
      this.seek(0);
      const playButton = document.querySelector<HTMLButtonElement>("[data-play]");
      if (playButton) {
        playButton.textContent = "播放";
      }
      return;
    }
    this.draw(time);
    this.updateClock(time);
    this.rafId = requestAnimationFrame(this.tick);
  };

  private updateClock(time: number): void {
    const clock = document.querySelector<HTMLElement>("[data-clock]");
    if (clock) {
      clock.textContent = `${time.toFixed(2)} / ${this.state.render.timeline.duration.toFixed(2)}s`;
    }
    const scrubber = document.querySelector<HTMLInputElement>("[data-scrub]");
    if (scrubber && document.activeElement !== scrubber) {
      scrubber.value = String(
        Math.round((time / this.state.render.timeline.duration) * Number(scrubber.max)),
      );
    }
  }

  async start(): Promise<void> {
    this.mixer = await PreviewMixer.create(this.state.project, this.state.render.timeline);
    this.draw(0);
    this.updateClock(0);
  }

  async play(): Promise<void> {
    if (this.playing) {
      return;
    }
    this.playing = true;
    this.startWallTime = performance.now();
    await this.mixer?.play(this.offset);
    this.rafId = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (!this.playing) {
      return;
    }
    this.offset = this.offset + (performance.now() - this.startWallTime) / 1000;
    this.playing = false;
    cancelAnimationFrame(this.rafId);
    this.mixer?.pause();
  }

  seek(time: number): void {
    this.offset = Math.max(0, Math.min(time, this.state.render.timeline.duration));
    this.startWallTime = performance.now();
    void this.mixer?.seek(this.offset);
    this.draw(this.offset);
    this.updateClock(this.offset);
  }

  get timelineTime(): number {
    return this.playing
      ? this.offset + (performance.now() - this.startWallTime) / 1000
      : this.offset;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.mixer?.close();
  }
}

async function saveExport(manifest: ExportManifest, bytes: Uint8Array): Promise<{ manifestUrl: string; videoUrl: string }> {
  const response = await fetch("/api/exports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      manifest,
      videoBase64: bytesToBase64(bytes),
    }),
  });
  if (!response.ok) {
    throw new Error(`export save failed: ${response.status}`);
  }
  return await response.json() as { manifestUrl: string; videoUrl: string };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function run(state: AppState, canvas: HTMLCanvasElement): Promise<void> {
  const preview = new PreviewController(state, canvas);
  await preview.start();

  const playButton = document.querySelector<HTMLButtonElement>("[data-play]");
  const exportButton = document.querySelector<HTMLButtonElement>("[data-export]");
  const progress = document.querySelector<HTMLElement>("[data-progress]");
  const result = document.querySelector<HTMLElement>("[data-result]");
  const scrubber = document.querySelector<HTMLInputElement>("[data-scrub]");

  scrubber?.addEventListener("input", () => {
    const ratio = Number(scrubber.value) / Number(scrubber.max);
    preview.pause();
    preview.seek(ratio * state.render.timeline.duration);
    if (playButton) {
      playButton.textContent = "播放";
    }
  });

  playButton?.addEventListener("click", () => {
    if (preview.isPlaying) {
      preview.pause();
      playButton.textContent = "播放";
    } else {
      void preview.play();
      playButton.textContent = "暂停";
    }
  });

  exportButton?.addEventListener("click", () => {
    void (async () => {
      if (exportButton) {
        exportButton.disabled = true;
      }
      try {
        const timeline = state.render.timeline;
        const audio = await renderNarration(state.project, timeline);
        const { bytes, codec } = await encodeVideo({
          project: state.project,
          canvas,
          render: (time) => renderFrame(state.render, time),
          durationSeconds: Math.max(timeline.duration, audio.length / audio.sampleRate),
          audio,
          onProgress: (item) => {
            if (progress) {
              progress.textContent = `${item.phase} ${item.frame}/${item.totalFrames}`;
            }
          },
        });
        const manifest: ExportManifest = {
          title: state.project.title,
          exportedAt: new Date().toISOString(),
          video: state.project.video,
          duration: timeline.duration,
          frameCount: timeline.frameCount,
          segments: buildExportManifest(
            state.project,
            { timeline, plans: state.render.plans },
            new Date().toISOString(),
          ).segments,
        };
        const saved = await saveExport(manifest, bytes);
        if (result) {
          result.innerHTML = "";
          const video = document.createElement("video");
          video.controls = true;
          video.style.width = "100%";
          result.append(video);
          if (canPlay(codec, true)) {
            await playBytes(video, bytes, codec, true);
          } else {
            video.src = saved.videoUrl;
          }
          const links = document.createElement("div");
          links.innerHTML = `<a href="${saved.videoUrl}" target="_blank">下载 WebM 视频</a> · <a href="${saved.manifestUrl}" target="_blank">导出参数 JSON</a>`;
          result.append(links);
        }
      } catch (error) {
        if (progress) {
          progress.textContent = `导出失败：${(error as Error).message}`;
        }
      } finally {
        if (exportButton) {
          exportButton.disabled = false;
        }
      }
    })();
  });
}

async function bootstrap(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>("[data-canvas]");
  if (!canvas) {
    throw new Error("canvas element missing");
  }
  const project = await loadProject("/api/project");
  const audioDuration = await probeFullNarration(project);
  const bundle = buildPlans(project, audioDuration);
  canvas.width = project.video.width;
  canvas.height = project.video.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    throw new Error("2d canvas context unavailable");
  }
  const images = await loadImages(project);
  const render: RenderContext = {
    ctx,
    project,
    timeline: bundle.timeline,
    plans: bundle.plans,
    images,
  };
  await run({ project, render, audioDuration }, canvas);
}

bootstrap().catch((error) => {
  const target = document.querySelector<HTMLElement>("[data-progress]");
  if (target) {
    target.textContent = `初始化失败：${(error as Error).message}`;
  }
  console.error(error);
});
