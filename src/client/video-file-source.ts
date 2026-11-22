import type { DrawableSource } from './synthetic-source.ts';

/**
 * Local file-backed source. Files are loaded through URL.createObjectURL so
 * nothing is uploaded; playback is driven by the master clock.
 */
export class VideoFileSource implements DrawableSource {
  readonly id: string;
  readonly label: string;
  readonly element: HTMLVideoElement;
  private readonly url: string;

  constructor(file: File) {
    this.id = `file-${file.name}-${file.lastModified}`;
    this.label = file.name;
    this.url = URL.createObjectURL(file);
    this.element = document.createElement('video');
    this.element.src = this.url;
    this.element.muted = true;
    this.element.playsInline = true;
    this.element.preload = 'auto';
    this.element.crossOrigin = 'anonymous';
  }

  get ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.element.addEventListener('loadeddata', () => resolve(), { once: true });
      this.element.addEventListener('error', () => reject(this.element.error), {
        once: true,
      });
    });
  }

  seek(timeSec: number): void {
    if (Math.abs(this.element.currentTime - timeSec) > 0.05) {
      this.element.currentTime = timeSec;
    }
  }

  draw(ctx: CanvasRenderingContext2D, rect: DOMRect): void {
    if (this.element.readyState >= 2) {
      ctx.drawImage(this.element, rect.x, rect.y, rect.width, rect.height);
    }
  }

  thumbnail(): Uint8ClampedArray {
    return new Uint8ClampedArray(0);
  }

  dispose(): void {
    URL.revokeObjectURL(this.url);
  }
}
