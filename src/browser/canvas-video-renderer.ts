import type { FrameRenderer } from '../media/sync-engine.ts';
import type { MediaFrame } from '../media/media-types.ts';

/** 视频帧载荷：WebCodecs VideoFrame 或兼容 drawImage 的画布源。 */
export type VideoPayload = CanvasImageSource;

export interface CanvasVideoRendererOptions {
  readonly canvas: HTMLCanvasElement;
  /** 背景色，用于无帧可画的占位状态。 */
  readonly background?: string;
}

/**
 * Canvas 视频渲染器。
 * 冻结期间 SyncEngine 不再调用 render，画布自然保留最后一帧，
 * 与音频挂起共享同一个冻结信号，实现声画同时停住。
 */
export class CanvasVideoRenderer implements FrameRenderer {
  private readonly context: CanvasRenderingContext2D;
  private lastFrame: VideoFrame | null = null;
  private readonly background: string;

  constructor(options: CanvasVideoRendererOptions) {
    const context = options.canvas.getContext('2d');
    if (!context) {
      throw new Error('2d canvas context unavailable');
    }
    this.context = context;
    this.background = options.background ?? '#111';
    this.context.fillStyle = this.background;
    this.context.fillRect(0, 0, options.canvas.width, options.canvas.height);
  }

  render(frame: MediaFrame): void {
    const image = frame.payload as VideoPayload;
    const width = this.context.canvas.width;
    const height = this.context.canvas.height;
    this.context.drawImage(image, 0, 0, width, height);
    if (isVideoFrame(image)) {
      this.lastFrame?.close();
      this.lastFrame = image;
    }
  }

  release(frame: MediaFrame): void {
    const image = frame.payload;
    if (isVideoFrame(image)) {
      image.close();
      if (this.lastFrame === image) {
        this.lastFrame = null;
      }
    }
    void frame;
  }

  freeze(): void {
    // 显式 no-op：保留当前画布内容即“画面冻结”。
  }

  /** 重新绘制最后一帧（例如画布尺寸变化后）。 */
  repaintLastFrame(): void {
    if (this.lastFrame) {
      this.context.drawImage(
        this.lastFrame,
        0,
        0,
        this.context.canvas.width,
        this.context.canvas.height,
      );
    }
  }

  dispose(): void {
    this.lastFrame?.close();
    this.lastFrame = null;
  }
}

function isVideoFrame(value: unknown): value is VideoFrame {
  return (
    typeof VideoFrame !== 'undefined' &&
    value instanceof VideoFrame &&
    typeof (value as VideoFrame).close === 'function'
  );
}
