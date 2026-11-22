export class TrailScene {
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly startedAt = performance.now();
  private cameraVideo: HTMLVideoElement | null = null;
  private animationFrame = 0;
  private running = false;
  private cameraReady = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("Canvas 2D is unavailable");
    }
    this.context = context;
  }

  get usingCamera(): boolean {
    return this.cameraReady;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const draw = (now: number): void => {
      if (!this.running) {
        return;
      }
      this.render(now - this.startedAt);
      this.animationFrame = requestAnimationFrame(draw);
    };
    this.animationFrame = requestAnimationFrame(draw);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.animationFrame);
  }

  async attachStream(stream: MediaStream | null): Promise<boolean> {
    this.detachCamera();
    const track = stream?.getVideoTracks()[0];
    if (!track) {
      return false;
    }

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    this.cameraVideo = video;
    this.cameraReady = false;
    try {
      await video.play();
      this.cameraReady = true;
      return true;
    } catch {
      this.detachCamera();
      return false;
    }
  }

  detachCamera(): void {
    if (this.cameraVideo) {
      this.cameraVideo.pause();
      this.cameraVideo.srcObject = null;
    }
    this.cameraVideo = null;
    this.cameraReady = false;
  }

  private render(elapsedMs: number): void {
    const context = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (this.cameraVideo && this.cameraReady && this.cameraVideo.readyState >= 2) {
      this.drawCover(this.cameraVideo, width, height);
      return;
    }
    this.drawTrail(elapsedMs / 1000, width, height);
  }

  private drawCover(source: CanvasImageSource, width: number, height: number): void {
    const videoWidth = this.cameraVideo?.videoWidth ?? width;
    const videoHeight = this.cameraVideo?.videoHeight ?? height;
    const scale = Math.max(width / videoWidth, height / videoHeight);
    const drawWidth = videoWidth * scale;
    const drawHeight = videoHeight * scale;
    this.context.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  }

  private drawTrail(time: number, width: number, height: number): void {
    const context = this.context;
    const horizon = height * 0.57;

    const sky = context.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, "#13283b");
    sky.addColorStop(0.46, "#46657a");
    sky.addColorStop(0.75, "#d98b63");
    sky.addColorStop(1, "#f0b56f");
    context.fillStyle = sky;
    context.fillRect(0, 0, width, horizon + 4);

    const sunX = width * 0.69 + Math.sin(time * 0.04) * 10;
    const sunY = height * 0.35;
    const glow = context.createRadialGradient(sunX, sunY, 5, sunX, sunY, height * 0.38);
    glow.addColorStop(0, "rgba(255, 226, 170, 0.95)");
    glow.addColorStop(0.18, "rgba(255, 187, 116, 0.34)");
    glow.addColorStop(1, "rgba(255, 156, 91, 0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, width, horizon);
    context.beginPath();
    context.arc(sunX, sunY, height * 0.048, 0, Math.PI * 2);
    context.fillStyle = "#ffe3a6";
    context.fill();

    this.drawClouds(time, width, height, horizon);
    this.drawMountains(width, height, horizon);
    this.drawValley(time, width, height, horizon);
    this.drawForest(width, height, horizon, time);
    this.drawHiker(time, width, height);
    this.drawFilmGrain(time, width, height);
  }

  private drawClouds(time: number, width: number, height: number, horizon: number): void {
    const context = this.context;
    for (let index = 0; index < 5; index += 1) {
      const drift = (time * (7 + index * 2) + index * 260) % (width + 420);
      const x = width + 180 - drift;
      const y = height * (0.12 + index * 0.055);
      const cloudWidth = 150 + index * 38;
      context.save();
      context.globalAlpha = 0.09 + index * 0.018;
      context.fillStyle = "#fff0d6";
      for (let puff = 0; puff < 5; puff += 1) {
        context.beginPath();
        context.ellipse(
          x + puff * cloudWidth * 0.16,
          y + Math.sin(puff * 1.7 + time * 0.05) * 6,
          cloudWidth * (0.2 + puff * 0.015),
          cloudWidth * 0.08,
          0,
          0,
          Math.PI * 2,
        );
        context.fill();
      }
      context.restore();
    }
  }

  private drawMountains(width: number, height: number, horizon: number): void {
    const context = this.context;
    context.beginPath();
    context.moveTo(0, horizon);
    context.lineTo(width * 0.12, horizon - height * 0.14);
    context.lineTo(width * 0.29, horizon - height * 0.06);
    context.lineTo(width * 0.45, horizon - height * 0.24);
    context.lineTo(width * 0.62, horizon - height * 0.1);
    context.lineTo(width * 0.79, horizon - height * 0.19);
    context.lineTo(width, horizon - height * 0.03);
    context.lineTo(width, horizon + 30);
    context.lineTo(0, horizon + 30);
    context.closePath();
    context.fillStyle = "#30414b";
    context.fill();

    context.beginPath();
    context.moveTo(width * 0.38, horizon - height * 0.18);
    context.lineTo(width * 0.45, horizon - height * 0.24);
    context.lineTo(width * 0.52, horizon - height * 0.17);
    context.lineTo(width * 0.49, horizon - height * 0.13);
    context.lineTo(width * 0.45, horizon - height * 0.16);
    context.lineTo(width * 0.41, horizon - height * 0.12);
    context.closePath();
    context.fillStyle = "rgba(235, 223, 202, 0.35)";
    context.fill();
  }

  private drawValley(time: number, width: number, height: number, horizon: number): void {
    const context = this.context;
    const field = context.createLinearGradient(0, horizon, 0, height);
    field.addColorStop(0, "#5a6347");
    field.addColorStop(0.52, "#394a34");
    field.addColorStop(1, "#1c2924");
    context.fillStyle = field;
    context.fillRect(0, horizon, width, height - horizon);

    context.beginPath();
    context.moveTo(width * 0.48, horizon + 6);
    context.bezierCurveTo(width * 0.43, height * 0.75, width * 0.58, height * 0.8, width * 0.35, height);
    context.lineTo(width * 0.66, height);
    context.bezierCurveTo(width * 0.63, height * 0.82, width * 0.52, height * 0.73, width * 0.53, horizon + 6);
    context.closePath();
    const trail = context.createLinearGradient(0, horizon, 0, height);
    trail.addColorStop(0, "#9f8e69");
    trail.addColorStop(1, "#665d48");
    context.fillStyle = trail;
    context.fill();

    context.beginPath();
    context.moveTo(width * 0.12, horizon + 30);
    context.bezierCurveTo(width * 0.3, height * 0.68, width * 0.19, height * 0.82, width * 0.08, height);
    context.lineTo(width * 0.27, height);
    context.bezierCurveTo(width * 0.31, height * 0.84, width * 0.37, height * 0.69, width * 0.21, horizon + 30);
    context.closePath();
    context.fillStyle = "rgba(120, 152, 154, 0.32)";
    context.fill();

    const mist = context.createLinearGradient(0, horizon - 20, 0, horizon + 100);
    mist.addColorStop(0, "rgba(226, 191, 147, 0.16)");
    mist.addColorStop(1, "rgba(226, 191, 147, 0)");
    context.fillStyle = mist;
    context.fillRect(0, horizon - 20, width, 120);
    context.fillStyle = "rgba(255, 208, 153, 0.04)";
    context.fillRect(0, horizon - 20, width, 60 * (0.8 + Math.sin(time * 0.3) * 0.2));
  }

  private drawForest(width: number, height: number, horizon: number, time: number): void {
    const context = this.context;
    const trees = 28;
    for (let index = 0; index < trees; index += 1) {
      const x = ((index * 73 + 19) / trees) * width;
      const base = horizon + 90 + (index % 5) * 24;
      const size = height * (0.055 + ((index * 17) % 7) * 0.009);
      const sway = Math.sin(time * 0.35 + index) * 1.5;
      context.save();
      context.translate(x + sway, base);
      context.strokeStyle = "#203029";
      context.lineWidth = Math.max(2, size * 0.1);
      context.beginPath();
      context.moveTo(0, 0);
      context.lineTo(0, -size * 0.45);
      context.stroke();
      context.fillStyle = index % 2 ? "#1f332d" : "#263d33";
      for (let tier = 0; tier < 3; tier += 1) {
        const tierY = -size * (0.35 + tier * 0.2);
        const half = size * (0.35 - tier * 0.07);
        context.beginPath();
        context.moveTo(0, tierY - size * 0.3);
        context.lineTo(-half, tierY + size * 0.12);
        context.lineTo(half, tierY + size * 0.12);
        context.closePath();
        context.fill();
      }
      context.restore();
    }
  }

  private drawHiker(time: number, width: number, height: number): void {
    const context = this.context;
    const progress = (time * 0.022) % 1;
    const x = width * (0.5 - progress * 0.18);
    const y = height * (0.62 + progress * 0.29);
    const scale = 0.8 + progress * 0.85;
    context.save();
    context.translate(x, y);
    context.scale(scale, scale);
    context.strokeStyle = "rgba(29, 35, 31, 0.88)";
    context.lineWidth = 4;
    context.lineCap = "round";
    context.beginPath();
    context.arc(0, -37, 6, 0, Math.PI * 2);
    context.fillStyle = "#d8a66d";
    context.fill();
    context.beginPath();
    context.moveTo(0, -30);
    context.lineTo(0, -8);
    context.moveTo(0, -25);
    context.lineTo(-9, -13);
    context.moveTo(0, -25);
    context.lineTo(11, -16);
    context.moveTo(0, -8);
    context.lineTo(-7 + Math.sin(time * 8) * 4, 8);
    context.moveTo(0, -8);
    context.lineTo(7 - Math.sin(time * 8) * 4, 8);
    context.stroke();
    context.strokeStyle = "rgba(166, 106, 57, 0.75)";
    context.lineWidth = 3;
    context.beginPath();
    context.arc(-4, -22, 7, Math.PI * 1.2, Math.PI * 2.2);
    context.stroke();
    context.restore();
  }

  private drawFilmGrain(time: number, width: number, height: number): void {
    const context = this.context;
    context.fillStyle = "rgba(255, 238, 204, 0.035)";
    for (let index = 0; index < 18; index += 1) {
      const x = (Math.sin(index * 92.7 + time * 0.7) * 0.5 + 0.5) * width;
      const y = (Math.cos(index * 37.1 + time * 0.4) * 0.5 + 0.5) * height;
      context.fillRect(x, y, 1.2, 1.2);
    }
  }
}
