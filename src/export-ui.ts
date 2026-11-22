import type { PortraitCutApp } from "./app.ts";
import { exportProject } from "./exporter.ts";
import type { ExportResult } from "./exporter.ts";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function waitForEvent(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      target.removeEventListener(event, done);
      target.removeEventListener("error", failed);
      resolve();
    };
    const failed = () => {
      target.removeEventListener(event, done);
      target.removeEventListener("error", failed);
      reject(new Error(`${event} failed`));
    };
    target.addEventListener(event, done, { once: true });
    target.addEventListener("error", failed, { once: true });
  });
}

export class ExportController {
  private readonly dialog = byId<HTMLDialogElement>("exportDialog");
  private readonly runButton = byId<HTMLButtonElement>("runExport");
  private readonly resultPanel = byId<HTMLDivElement>("exportResult");
  private readonly video = byId<HTMLVideoElement>("exportVideo");
  private readonly progressBar = byId<HTMLElement>("progressBar");
  private readonly progressValue = byId<HTMLElement>("progressValue");
  private readonly progressLabel = byId<HTMLElement>("progressLabel");
  private readonly codecStatus = byId<HTMLElement>("codecStatus");
  private readonly files = byId<HTMLDivElement>("resultFiles");
  private readonly bundle = byId<HTMLAnchorElement>("downloadBundle");
  private readonly app: PortraitCutApp;
  private exporting = false;
  private objectUrls: string[] = [];

  constructor(app: PortraitCutApp) {
    this.app = app;
    this.detectSupport();
    this.bind();
  }

  private detectSupport(): void {
    const codecs = typeof window !== "undefined" && "VideoEncoder" in window
      ? "WebCodecs 可用"
      : "WebCodecs 不可用";
    const media = typeof window !== "undefined" && "MediaSource" in window
      ? "MediaSource 可用"
      : "MediaSource 不可用";
    this.codecStatus.textContent = `${codecs} · ${media}`;
  }

  private bind(): void {
    byId("exportOpen").addEventListener("click", () => {
      this.dialog.showModal();
      this.detectSupport();
    });
    this.dialog.addEventListener("cancel", (event) => {
      if (this.exporting) event.preventDefault();
    });
    this.runButton.addEventListener("click", () => void this.run());
  }

  private setProgress(value: number, label: string): void {
    this.progressBar.style.width = `${value}%`;
    this.progressValue.textContent = `${Math.round(value)}%`;
    this.progressLabel.textContent = label;
  }

  private async run(): Promise<void> {
    if (this.exporting) return;
    this.exporting = true;
    this.runButton.disabled = true;
    this.runButton.textContent = "编码中…";
    this.resultPanel.classList.remove("visible");
    this.bundle.classList.add("hidden");
    this.files.innerHTML = "";
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls = [];
    this.setProgress(0, "准备编码器");
    try {
      const result = await exportProject(this.app.project, {
        burnCaptions: byId<HTMLInputElement>("burnCaptions").checked,
        includeAudio: byId<HTMLInputElement>("includeAudio").checked,
        includeReadme: byId<HTMLInputElement>("includeReadme").checked,
        soundtrack: this.app.getSoundtrack(),
        onProgress: (value, label) => this.setProgress(value, label),
      });
      this.showResult(result);
      await this.showPreview(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.progressLabel.textContent = `编码失败：${message}`;
      this.progressValue.textContent = "ERR";
      this.progressBar.style.width = "100%";
      this.progressBar.style.background = "#df7b6b";
      console.error(error);
    } finally {
      this.exporting = false;
      this.runButton.disabled = false;
      this.runButton.textContent = "重新生成";
    }
  }

  private showResult(result: ExportResult): void {
    this.resultPanel.classList.add("visible");
    const makeUrl = (data: Uint8Array, type: string) => {
      const url = URL.createObjectURL(new Blob([data.slice().buffer], { type }));
      this.objectUrls.push(url);
      return url;
    };
    const videoUrl = makeUrl(result.video, result.mime);
    const vttUrl = makeUrl(new TextEncoder().encode(result.vtt), "text/vtt;charset=utf-8");
    const jsonUrl = makeUrl(new TextEncoder().encode(result.parameters), "application/json");
    const zipUrl = makeUrl(result.zip, "application/zip");
    this.bundle.href = zipUrl;
    this.bundle.classList.remove("hidden");
    byId("bundleSize").textContent = formatBytes(result.zip.byteLength);
    const fileRows = [
      ["portrait-master.webm", result.video.byteLength, videoUrl, "video/webm"],
      ["captions.zh-CN.vtt", new TextEncoder().encode(result.vtt).length, vttUrl, "text/vtt"],
      ["edit-parameters.json", new TextEncoder().encode(result.parameters).length, jsonUrl, "application/json"],
    ];
    this.files.innerHTML = fileRows.map(([name, size, url]) => `
      <a class="result-file" href="${url}" download="${name}">
        <b>${name}</b>${formatBytes(Number(size))}
      </a>
    `).join("");
  }

  private async showPreview(result: ExportResult): Promise<void> {
    this.video.removeAttribute("src");
    if (!("MediaSource" in window) || !MediaSource.isTypeSupported(result.mime)) {
      const url = URL.createObjectURL(new Blob([result.video.slice().buffer], { type: result.mime }));
      this.objectUrls.push(url);
      this.video.src = url;
      this.progressLabel.textContent = "交付完成 · MediaSource 不支持该封装，已切换直接预览";
      return;
    }
    try {
      const mediaSource = new MediaSource();
      const url = URL.createObjectURL(mediaSource);
      this.objectUrls.push(url);
      this.video.src = url;
      await waitForEvent(mediaSource, "sourceopen");
      mediaSource.duration = result.duration;
      const sourceBuffer = mediaSource.addSourceBuffer(result.mime);
      sourceBuffer.appendBuffer(result.video.slice().buffer);
      await waitForEvent(sourceBuffer, "updateend");
      if (mediaSource.readyState === "open") mediaSource.endOfStream();
      this.progressLabel.textContent = "交付完成 · MediaSource 预览已挂载";
    } catch (error) {
      const url = URL.createObjectURL(new Blob([result.video.slice().buffer], { type: result.mime }));
      this.objectUrls.push(url);
      this.video.src = url;
      console.warn("MediaSource preview fallback", error);
    }
  }
}
