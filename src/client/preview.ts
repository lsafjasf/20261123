import type { Mp4File } from "./mp4/reader.js";

function waitForEvent(target: EventTarget, name: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(name, onEvent);
      reject(new Error(`等待 ${name} 超时`));
    }, timeoutMs);
    const onEvent = () => {
      clearTimeout(timer);
      target.removeEventListener(name, onEvent);
      resolve();
    };
    target.addEventListener(name, onEvent, { once: true });
  });
}

export function mediaSourceMime(file: Mp4File): string {
  const codecs = [file.video.codec];
  if (file.audio) codecs.push(file.audio.codec === "mp4a.40.2" ? "mp4a.40.2" : file.audio.codec);
  return `video/mp4; codecs="${codecs.join(",")}"`;
}

export function mediaSourceSupported(mime: string): boolean {
  return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime);
}

export class SourcePreview {
  readonly video: HTMLVideoElement;
  private bytes: Uint8Array | null = null;
  private mime = "video/mp4";
  private objectUrl: string | null = null;
  private mediaSource: MediaSource | null = null;
  private audioContext: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private usingMediaSource = false;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.video.preload = "auto";
    this.video.crossOrigin = "anonymous";
    this.video.muted = false;
  }

  async attach(bytes: Uint8Array, mime: string): Promise<{ mode: "mediasource" | "file"; warnings: string[] }> {
    await this.detach();
    this.bytes = bytes;
    this.mime = mime;
    const warnings: string[] = [];

    if (mediaSourceSupported(mime)) {
      try {
        await this.attachMediaSource(bytes, mime);
        this.usingMediaSource = true;
        return { mode: "mediasource", warnings };
      } catch (error) {
        warnings.push(`MediaSource 预览回退：${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      warnings.push("当前编码组合不支持 MediaSource，预览使用本地 Blob 回退");
    }

    const copy = bytes.slice().buffer;
    this.objectUrl = URL.createObjectURL(new Blob([copy], { type: mime }));
    this.video.src = this.objectUrl;
    this.video.load();
    await waitForEvent(this.video, "loadedmetadata");
    this.usingMediaSource = false;
    return { mode: "file", warnings };
  }

  private async attachMediaSource(bytes: Uint8Array, mime: string): Promise<void> {
    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;
    this.objectUrl = URL.createObjectURL(mediaSource);
    this.video.src = this.objectUrl;
    await waitForEvent(mediaSource, "sourceopen");
    const sourceBuffer = mediaSource.addSourceBuffer(mime);
    const copy = bytes.slice().buffer;
    sourceBuffer.appendBuffer(copy);
    await waitForEvent(sourceBuffer, "updateend", 12_000);
    if (mediaSource.readyState === "open") mediaSource.endOfStream();
    if (this.video.readyState < 1) await waitForEvent(this.video, "loadedmetadata");
  }

  async ensureAudio(): Promise<void> {
    if (this.audioContext) {
      if (this.audioContext.state === "suspended") await this.audioContext.resume();
      return;
    }
    const context = new AudioContext({ latencyHint: "interactive", sampleRate: 48_000 });
    const source = context.createMediaElementSource(this.video);
    const gain = context.createGain();
    gain.gain.value = 0.72;
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(gain).connect(analyser).connect(context.destination);
    this.audioContext = context;
    this.gain = gain;
    this.analyser = analyser;
    if (context.state === "suspended") await context.resume();
  }

  async play(): Promise<void> {
    await this.ensureAudio();
    await this.video.play();
  }

  pause(): void {
    this.video.pause();
  }

  seek(seconds: number): void {
    const duration = this.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const safe = Math.min(Math.max(0, seconds), Math.max(0, duration - 0.001));
    try {
      this.video.currentTime = safe;
    } catch {
      // Metadata may not be ready yet.
    }
  }

  get duration(): number {
    return Number.isFinite(this.video.duration) ? this.video.duration : 0;
  }

  get currentTime(): number {
    return this.video.currentTime || 0;
  }

  get paused(): boolean {
    return this.video.paused;
  }

  get ready(): boolean {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  get previewMode(): "mediasource" | "file" {
    return this.usingMediaSource ? "mediasource" : "file";
  }

  getVolumeLevel(): number {
    if (!this.analyser) return 0;
    const buffer = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(buffer);
    let sum = 0;
    for (const value of buffer) sum += value * value;
    return Math.min(1, Math.sqrt(sum / buffer.length) / 128);
  }

  setVolume(value: number): void {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, value));
  }

  async detach(): Promise<void> {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this.mediaSource && this.mediaSource.readyState === "open") {
      try {
        this.mediaSource.endOfStream();
      } catch {
        // Source may already have ended.
      }
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.mediaSource = null;
    this.bytes = null;
  }

  async close(): Promise<void> {
    await this.detach();
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
    this.gain = null;
    this.analyser = null;
  }
}
