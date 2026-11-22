export class ViewportRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly preview: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly previewContext: CanvasRenderingContext2D;
  private readonly container: HTMLElement;
  private current: VideoFrame | null = null;
  private previewVisible = false;
  private ratio = 1;

  constructor(container: HTMLElement, canvas: HTMLCanvasElement, preview: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    const previewContext = preview.getContext("2d", { alpha: false, desynchronized: true });
    if (!context || !previewContext) throw new Error("Canvas 2D 不可用");
    this.container = container;
    this.canvas = canvas;
    this.preview = preview;
    this.context = context;
    this.previewContext = previewContext;
    this.resize();
  }

  resize(): void {
    const bounds = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    this.ratio = Math.min(window.devicePixelRatio || 1, 2);
    for (const canvas of [this.canvas, this.preview]) {
      canvas.width = Math.round(width * this.ratio);
      canvas.height = Math.round(height * this.ratio);
    }
    this.resetContext(this.context);
    this.resetContext(this.previewContext);
    if (this.current) this.drawFrame(this.current);
    else this.clearSurface(this.context);
  }

  drawFrame(frame: VideoFrame): void {
    this.current = frame;
    this.clearSurface(this.context);
    const width = this.canvas.width;
    const height = this.canvas.height;
    const scale = Math.min(width / frame.displayWidth, height / frame.displayHeight);
    const drawWidth = Math.max(1, frame.displayWidth * scale);
    const drawHeight = Math.max(1, frame.displayHeight * scale);
    this.context.drawImage(
      frame,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight
    );
  }

  drawPreview(bitmap: ImageBitmap): void {
    this.clearSurface(this.previewContext);
    const width = this.preview.width;
    const height = this.preview.height;
    const scale = Math.min(width / bitmap.width, height / bitmap.height);
    const drawWidth = Math.max(1, bitmap.width * scale);
    const drawHeight = Math.max(1, bitmap.height * scale);
    this.previewContext.imageSmoothingEnabled = true;
    this.previewContext.drawImage(
      bitmap,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight
    );
    this.previewVisible = true;
    this.preview.classList.add("visible");
  }

  clearPreview(): void {
    this.previewVisible = false;
    this.preview.classList.remove("visible");
  }

  reset(): void {
    this.current = null;
    this.clearPreview();
    this.resetContext(this.context);
    this.resetContext(this.previewContext);
  }

  get hasPreview(): boolean {
    return this.previewVisible;
  }

  private clearSurface(context: CanvasRenderingContext2D): void {
    context.fillStyle = "#07090a";
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private resetContext(context: CanvasRenderingContext2D): void {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#07090a";
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
