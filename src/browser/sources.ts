import { syntheticFrameAt } from "../core/synthetic.js";
import type { RgbaFrame } from "../core/types.js";

export interface SourceInfo {
  kind: "synthetic" | "video";
  name: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationSec: number;
  mediaUrl: string | null;
}

export interface FrameProvider {
  info: SourceInfo;
  getFrame(index: number): Promise<RgbaFrame>;
  dispose(): void;
}

export class SyntheticFrameProvider implements FrameProvider {
  readonly info: SourceInfo;
  private cache = new Map<number, RgbaFrame>();
  private cacheOrder: number[] = [];
  private readonly speed: number;

  constructor(width = 384, height = 216, frameCount = 192, speed = 1) {
    this.speed = speed;
    this.info = {
      kind: "synthetic",
      name: "PAN / ROTATE · GENERATED",
      width,
      height,
      fps: 24,
      frameCount,
      durationSec: frameCount / 24,
      mediaUrl: null
    };
  }

  async getFrame(index: number): Promise<RgbaFrame> {
    const clamped = Math.max(0, Math.min(this.info.frameCount - 1, Math.round(index)));
    const cached = this.cache.get(clamped);
    if (cached) return cached;
    const frame = syntheticFrameAt(
      clamped / this.info.fps,
      this.info.width,
      this.info.height,
      this.speed
    );
    this.cache.set(clamped, frame);
    this.cacheOrder.push(clamped);
    while (this.cacheOrder.length > 36) {
      const expired = this.cacheOrder.shift();
      if (expired !== undefined) this.cache.delete(expired);
    }
    return frame;
  }

  dispose(): void {
    this.cache.clear();
    this.cacheOrder = [];
  }
}

export interface VideoLoadProgress {
  frame: number;
  total: number;
}

export async function createVideoFrameProvider(
  file: File,
  onProgress?: (progress: VideoLoadProgress) => void
): Promise<FrameProvider> {
  const mediaUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = mediaUrl;

  await new Promise<void>((resolve, reject) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error("浏览器无法读取这个视频文件")), {
      once: true
    });
  });

  if (!video.videoWidth || !video.videoHeight) {
    URL.revokeObjectURL(mediaUrl);
    throw new Error("视频没有可用的画面轨道");
  }

  const maxWidth = 384;
  const maxHeight = 216;
  const scale = Math.min(1, maxWidth / video.videoWidth, maxHeight / video.videoHeight);
  const width = Math.max(2, Math.round(video.videoWidth * scale / 2) * 2);
  const height = Math.max(2, Math.round(video.videoHeight * scale / 2) * 2);
  const fps = 24;
  const maxFrames = Math.min(144, Math.floor(video.duration * fps));
  const frameCount = Math.max(2, maxFrames);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D 不可用");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const frames: RgbaFrame[] = new Array(frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    const targetTime = Math.min(
      Math.max(0, video.duration - 0.001),
      (index + 0.5) / fps
    );
    await new Promise<void>((resolve) => {
      video.addEventListener("seeked", () => resolve(), { once: true });
      video.currentTime = targetTime;
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    context.drawImage(video, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    frames[index] = {
      width,
      height,
      data: new Uint8ClampedArray(image.data)
    };
    onProgress?.({ frame: index + 1, total: frameCount });
  }

  video.removeAttribute("src");
  video.load();
  const info: SourceInfo = {
    kind: "video",
    name: file.name,
    width,
    height,
    fps,
    frameCount,
    durationSec: frameCount / fps,
    mediaUrl
  };

  return {
    info,
    async getFrame(index: number): Promise<RgbaFrame> {
      const clamped = Math.max(0, Math.min(frames.length - 1, Math.round(index)));
      return frames[clamped];
    },
    dispose(): void {
      URL.revokeObjectURL(mediaUrl);
    }
  };
}
