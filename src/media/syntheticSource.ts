// 离线合成画面源：无需任何素材文件，用 Canvas 程序化生成含色阶/灰阶/高饱和块的测试帧。
// 同时提供合成音频（WebAudio 振荡器），用于在没有视频文件时完整体验 A/V 同步与调色流程。

export class SyntheticSource {
  readonly width = 640;
  readonly height = 360;
  private frameIndex = 0;
  private readonly fps = 30;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("无法创建 2D Canvas 上下文");
    this.context = context;
  }

  /** 推进到下一帧并返回时间戳；画面绘制在内部 canvas 上，由渲染层 drawImage 抽取。 */
  nextFrame(): number {
    const timestampMs = (this.frameIndex * 1000) / this.fps;
    const ctx = this.context;
    const w = this.width;
    const h = this.height;
    ctx.fillStyle = "#101418";
    ctx.fillRect(0, 0, w, h);

    // 顶部灰阶条：覆盖 0..255，用于观察过曝裁切阈值。
    const grayBars = 8;
    for (let index = 0; index < grayBars; index += 1) {
      const value = Math.round((index / (grayBars - 1)) * 255);
      ctx.fillStyle = `rgb(${value},${value},${value})`;
      ctx.fillRect((index * w) / grayBars, 0, w / grayBars + 1, 60);
    }

    // 中部高饱和 RGB 块，用于观察越界与色偏。
    const swatches = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#ff00ff", "#ffffff", "#000000"];
    swatches.forEach((color, index) => {
      ctx.fillStyle = color;
      ctx.fillRect((index * w) / swatches.length, 70, w / swatches.length + 1, 90);
    });

    // 底部随时间缓慢变化的色相渐变，让过渡动画可见。
    const shift = (this.frameIndex * 4) % 360;
    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    for (let stop = 0; stop <= 6; stop += 1) {
      gradient.addColorStop(stop / 6, `hsl(${(shift + stop * 60) % 360}, 80%, 55%)`);
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 170, w, h - 170);

    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "20px monospace";
    ctx.fillText(`frame ${this.frameIndex}  t=${(timestampMs / 1000).toFixed(2)}s`, 16, h - 20);

    this.frameIndex += 1;
    return timestampMs;
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  reset(): void {
    this.frameIndex = 0;
  }

  get currentTimestampMs(): number {
    return (this.frameIndex * 1000) / this.fps;
  }
}

/** 合成音频：振荡器生成轻柔双音和弦，并暴露 AnalyserNode 供音量表使用。 */
export class SyntheticAudio {
  private context: AudioContext | null = null;
  private oscillators: OscillatorNode[] = [];
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;

  async start(): Promise<void> {
    if (this.context) {
      await this.context.resume();
      return;
    }
    this.context = new AudioContext();
    this.gain = this.context.createGain();
    this.gain.gain.value = 0.06;
    this.analyser = this.context.createAnalyser();
    this.gain.connect(this.analyser);
    this.analyser.connect(this.context.destination);
    for (const frequency of [220, 330]) {
      const oscillator = this.context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(this.gain);
      oscillator.start();
      this.oscillators.push(oscillator);
    }
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  setVolume(value: number): void {
    if (this.gain && this.context) this.gain.gain.setValueAtTime(value, this.context.currentTime);
  }

  stop(): void {
    for (const oscillator of this.oscillators) oscillator.stop();
    this.oscillators = [];
    if (this.context) void this.context.close();
    this.context = null;
    this.analyser = null;
  }
}
