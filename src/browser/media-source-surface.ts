export interface VideoPresentation {
  readonly positionSeconds: number;
  readonly playing: boolean;
}

export class MediaSourceSurface {
  readonly video: HTMLVideoElement;
  private readonly mediaSource: MediaSource;
  private readonly objectUrl: string;
  private sourceBuffer: SourceBuffer | null = null;
  private sourceOpen: Promise<void>;
  private disposed = false;

  constructor() {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    this.video = video;

    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    video.src = this.objectUrl;
    this.sourceOpen = new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        this.mediaSource.removeEventListener("sourceopen", onOpen);
        resolve();
      };
      const onError = () => {
        this.mediaSource.removeEventListener("sourceopen", onOpen);
        reject(new Error("MediaSource failed to open"));
      };
      this.mediaSource.addEventListener("sourceopen", onOpen, { once: true });
      this.mediaSource.addEventListener("sourceclose", onError, { once: true });
    });
  }

  async appendMedia(data: ArrayBuffer, mimeType: string): Promise<void> {
    if (this.disposed) {
      throw new Error("video surface is disposed");
    }
    if (!MediaSource.isTypeSupported(mimeType)) {
      throw new Error(`unsupported MediaSource type: ${mimeType}`);
    }
    await this.sourceOpen;
    if (this.sourceBuffer === null) {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
    }
    await this.appendBuffer(this.sourceBuffer, data);
    if (this.mediaSource.readyState === "open") {
      this.mediaSource.endOfStream();
    }
  }

  sync(presentation: VideoPresentation): void {
    const video = this.video;
    if (this.disposed || video.readyState < HTMLMediaElement.HAVE_METADATA) {
      return;
    }
    const target = Math.max(0, presentation.positionSeconds);
    const drift = Math.abs(video.currentTime - target);
    const seekThreshold = presentation.playing ? 0.04 : 0.002;
    if (drift > seekThreshold) {
      try {
        video.currentTime = target;
      } catch {
        // Seeking before the media is seekable will be retried on the next frame.
      }
    }
    if (presentation.playing) {
      if (video.paused) {
        void video.play().catch(() => undefined);
      }
    } else if (!video.paused) {
      video.pause();
    }
  }

  draw(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    timestampSeconds: number,
  ): boolean {
    if (this.disposed || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return false;
    }
    try {
      const frame = new VideoFrame(this.video, {
        timestamp: Math.max(0, Math.round(timestampSeconds * 1_000_000)),
      });
      try {
        context.drawImage(frame, 0, 0, width, height);
      } finally {
        frame.close();
      }
      return true;
    } catch {
      context.drawImage(this.video, 0, 0, width, height);
      return true;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    URL.revokeObjectURL(this.objectUrl);
  }

  private appendBuffer(
    sourceBuffer: SourceBuffer,
    data: ArrayBuffer,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        sourceBuffer.removeEventListener("updateend", onEnd);
        sourceBuffer.removeEventListener("error", onError);
      };
      const onEnd = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("MediaSource append failed"));
      };
      sourceBuffer.addEventListener("updateend", onEnd, { once: true });
      sourceBuffer.addEventListener("error", onError, { once: true });
      try {
        sourceBuffer.appendBuffer(data);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
}
