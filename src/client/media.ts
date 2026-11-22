import type { MediaSegment } from "../core/types.ts";
import type { PreloadMap, PreloadState } from "../core/engine.ts";

type PreloadListener = (segmentId: string, state: PreloadState, error?: string) => void;

const MEDIA_MIME_CANDIDATES = [
  'video/mp4; codecs="avc1.4d401f, mp4a.40.2"',
  'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
  'video/mp4; codecs="avc1.42E01E"',
  "video/mp4",
  'video/webm; codecs="vp9, opus"',
];

export class MediaSession {
  readonly segment: MediaSegment;
  readonly video: HTMLVideoElement;
  state: PreloadState = "idle";
  error = "";
  durationMs = 0;

  private mediaSource: MediaSource | null = null;
  private objectUrl = "";
  private audioContext: AudioContext | null = null;
  private audioSource: MediaElementAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private preparePromise: Promise<void> | null = null;
  private anchor = { contextTime: 0, mediaTime: 0 };

  constructor(segment: MediaSegment, private readonly host: HTMLElement) {
    this.segment = segment;
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.preload = "auto";
    this.video.crossOrigin = "anonymous";
    this.video.style.cssText =
      "position:fixed;width:2px;height:2px;left:-100px;top:-100px;opacity:0;pointer-events:none";
    host.append(this.video);
  }

  async prepare(
    audioContext: AudioContext,
    destination: AudioNode,
  ): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "loading" && this.preparePromise) return this.preparePromise;
    this.audioContext = audioContext;
    this.preparePromise = this.doPrepare(destination);
    return this.preparePromise;
  }

  private async doPrepare(destination: AudioNode): Promise<void> {
    this.state = "loading";
    this.error = "";
    try {
      if (!("MediaSource" in window)) {
        throw new Error("当前浏览器不支持 MediaSource");
      }
      const mime = MEDIA_MIME_CANDIDATES.find((candidate) =>
        MediaSource.isTypeSupported(candidate),
      );
      if (!mime) throw new Error("浏览器没有可用的 MP4/WebM MSE 解码器");

      this.mediaSource = new MediaSource();
      this.objectUrl = URL.createObjectURL(this.mediaSource);
      this.video.src = this.objectUrl;
      this.host.append(this.video);
      await waitForEvent(this.mediaSource, "sourceopen", 8_000);

      const response = await fetch(this.segment.src, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`媒体请求失败 (${response.status})`);
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0) throw new Error("媒体文件为空");

      const sourceBuffer = this.mediaSource.addSourceBuffer(mime);
      sourceBuffer.mode = "segments";
      sourceBuffer.appendBuffer(bytes);
      await waitForEvent(sourceBuffer, "updateend", 12_000);
      await waitUntil(() => this.video.readyState >= 1, 8_000);
      this.video.pause();
      this.video.currentTime = Math.min(
        0.04,
        Math.max(0, (this.video.duration || this.segment.durationMs / 1_000) - 0.05),
      );
      this.durationMs = Number.isFinite(this.video.duration)
        ? Math.round(this.video.duration * 1_000)
        : this.segment.durationMs;
      this.attachAudio(destination);
      this.state = "ready";
    } catch (error) {
      this.state = "failed";
      this.error = error instanceof Error ? error.message : "媒体预加载失败";
      this.video.pause();
      this.gain?.disconnect();
      this.audioSource?.disconnect();
      throw error;
    }
  }

  private attachAudio(destination: AudioNode): void {
    if (!this.audioContext || this.audioSource) return;
    this.audioSource = this.audioContext.createMediaElementSource(this.video);
    this.gain = this.audioContext.createGain();
    this.gain.gain.value = 0;
    this.audioSource.connect(this.gain);
    this.gain.connect(destination);
  }

  async activate(localMs: number, masterVolume: number): Promise<void> {
    if (!this.gain || !this.audioContext) throw new Error("媒体音频尚未就绪");
    await this.seek(localMs);
    this.gain.gain.cancelScheduledValues(this.audioContext.currentTime);
    this.gain.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.gain.gain.linearRampToValueAtTime(
      masterVolume,
      this.audioContext.currentTime + 0.06,
    );
    await this.video.play();
    this.anchor = {
      contextTime: this.audioContext.currentTime,
      mediaTime: this.video.currentTime,
    };
  }

  pause(): void {
    this.video.pause();
    if (this.gain && this.audioContext) {
      this.gain.gain.cancelScheduledValues(this.audioContext.currentTime);
      this.gain.gain.setTargetAtTime(0, this.audioContext.currentTime, 0.025);
    }
  }

  async seek(localMs: number): Promise<void> {
    const target = Math.max(0, Math.min(localMs / 1_000, this.durationMs / 1_000 - 0.02));
    if (Math.abs(this.video.currentTime - target) < 0.012) return;
    const waiting = waitForEvent(this.video, "seeked", 2_500).catch(() => undefined);
    this.video.currentTime = target;
    await waiting;
    if (this.audioContext) {
      this.anchor = {
        contextTime: this.audioContext.currentTime,
        mediaTime: this.video.currentTime,
      };
    }
  }

  get currentTimeMs(): number {
    return Math.max(0, this.video.currentTime * 1_000);
  }

  get clockDriftMs(): number {
    if (!this.audioContext || this.video.paused) return 0;
    const predicted =
      this.anchor.mediaTime +
      (this.audioContext.currentTime - this.anchor.contextTime);
    return (this.video.currentTime - predicted) * 1_000;
  }

  get ended(): boolean {
    return this.video.ended;
  }

  draw(context: CanvasRenderingContext2D, width: number, height: number): boolean {
    if (this.video.readyState < 2) return false;
    let frame: VideoFrame | null = null;
    try {
      if ("VideoFrame" in window) {
        frame = new VideoFrame(this.video, {
          timestamp: Math.round(this.video.currentTime * 1_000_000),
        });
        drawCover(context, frame, width, height);
        return true;
      }
      drawCover(context, this.video, width, height);
      return true;
    } catch {
      try {
        drawCover(context, this.video, width, height);
        return true;
      } catch {
        return false;
      }
    } finally {
      frame?.close();
    }
  }

  dispose(): void {
    this.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.video.remove();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = "";
    this.mediaSource = null;
    this.audioSource?.disconnect();
    this.gain?.disconnect();
    this.audioSource = null;
    this.gain = null;
  }
}

export class SyncMediaEngine {
  readonly sessions = new Map<string, MediaSession>();
  private audioContext: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private host: HTMLDivElement;
  private activeId = "";
  private volume = 0.78;
  private requestOrder = 0;

  constructor(private readonly listener: PreloadListener) {
    this.host = document.createElement("div");
    this.host.id = "media-pool";
    this.host.setAttribute("aria-hidden", "true");
    document.body.append(this.host);
  }

  get audioReady(): boolean {
    return this.audioContext?.state === "running";
  }

  get activeDriftMs(): number {
    return this.sessions.get(this.activeId)?.clockDriftMs ?? 0;
  }

  async ensureAudio(): Promise<void> {
    await this.ensureContext();
    if (this.audioContext?.state === "suspended") {
      await this.audioContext.resume();
    }
  }

  private async ensureContext(): Promise<void> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ latencyHint: "interactive" });
      this.masterGain = this.audioContext.createGain();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
    }
  }

  async prepare(segment: MediaSegment): Promise<MediaSession> {
    await this.ensureContext();
    if (!this.audioContext || !this.masterGain) throw new Error("WebAudio 初始化失败");
    let session = this.sessions.get(segment.id);
    if (!session) {
      session = new MediaSession(segment, this.host);
      this.sessions.set(segment.id, session);
    }
    if (session.state === "failed") {
      session.dispose();
      session = new MediaSession(segment, this.host);
      this.sessions.set(segment.id, session);
    }
    this.listener(segment.id, session.state);
    try {
      await session.prepare(this.audioContext, this.masterGain);
      this.listener(segment.id, "ready");
      return session;
    } catch (error) {
      this.listener(
        segment.id,
        "failed",
        error instanceof Error ? error.message : "媒体预加载失败",
      );
      throw error;
    }
  }

  async prepareMany(
    segments: MediaSegment[],
  ): Promise<{ ready: string[]; failed: string[] }> {
    const results = await Promise.allSettled(
      segments.map((segment) => this.prepare(segment)),
    );
    const ready: string[] = [];
    const failed: string[] = [];
    results.forEach((result, index) => {
      const segment = segments[index];
      if (!segment) return;
      (result.status === "fulfilled" ? ready : failed).push(segment.id);
    });
    return { ready, failed };
  }

  async activate(segment: MediaSegment, localMs: number): Promise<void> {
    const order = ++this.requestOrder;
    await this.ensureAudio();
    const session = await this.prepare(segment);
    if (order !== this.requestOrder) return;
    if (this.activeId && this.activeId !== segment.id) {
      this.sessions.get(this.activeId)?.pause();
    }
    this.activeId = segment.id;
    await session.activate(localMs, this.volume);
    if (order !== this.requestOrder) session.pause();
  }

  async cue(segment: MediaSegment, localMs: number): Promise<void> {
    const order = ++this.requestOrder;
    const session = await this.prepare(segment);
    if (order !== this.requestOrder) return;
    if (this.activeId && this.activeId !== segment.id) {
      this.sessions.get(this.activeId)?.pause();
    }
    this.activeId = segment.id;
    session.pause();
    await session.seek(localMs);
  }

  pause(): void {
    this.requestOrder += 1;
    this.sessions.get(this.activeId)?.pause();
  }

  async seek(localMs: number): Promise<void> {
    await this.sessions.get(this.activeId)?.seek(localMs);
  }

  draw(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): boolean {
    const session = this.sessions.get(this.activeId);
    return session?.draw(context, width, height) ?? false;
  }

  get currentTimeMs(): number {
    return this.sessions.get(this.activeId)?.currentTimeMs ?? 0;
  }

  get activeSegmentId(): string {
    return this.activeId;
  }

  get activeEnded(): boolean {
    return this.sessions.get(this.activeId)?.ended ?? false;
  }

  getPreloadMap(): PreloadMap {
    const result: PreloadMap = {};
    this.sessions.forEach((session, id) => {
      result[id] = session.state;
    });
    return result;
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.masterGain && this.audioContext) {
      this.masterGain.gain.setTargetAtTime(
        this.volume,
        this.audioContext.currentTime,
        0.02,
      );
    }
  }

  disposeSegment(segmentId: string): void {
    if (this.activeId === segmentId) this.activeId = "";
    this.sessions.get(segmentId)?.dispose();
    this.sessions.delete(segmentId);
  }
}

function drawCover(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
): void {
  context.fillStyle = "#050708";
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
}

function waitForEvent(
  target: EventTarget,
  event: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      target.removeEventListener(event, handleEvent);
      reject(new Error(`${event} 超时`));
    }, timeoutMs);
    function handleEvent(): void {
      window.clearTimeout(timer);
      resolve();
    }
    target.addEventListener(event, handleEvent, { once: true });
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) {
      throw new Error("媒体元数据加载超时");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 25));
  }
}
