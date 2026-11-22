/**
 * 同步标记生成器。
 * 每次发射同时触发：
 * - Canvas 全屏闪光（requestAnimationFrame 对齐显示刷新）；
 * - WebAudio 1200Hz、80ms 短促正弦蜂鸣（按 AudioContext 时钟精确调度）。
 * 返回 T0（performance.now 基准）以及音频硬件时间，供多时钟对齐。
 */

export interface MarkerShot {
  seq: number;
  t0Performance: number;
  t0Audio: number;
  scheduledAt: number;
}

export interface FlashTarget {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
}

export class MarkerGenerator {
  private readonly audioContext: AudioContext;
  private readonly flash: FlashTarget;
  private readonly injectionTarget: AudioNode | null;
  private seq = 0;
  private readonly beepHz: number;
  private readonly beepSeconds: number;

  constructor(
    audioContext: AudioContext,
    flash: FlashTarget,
    injectionTarget: AudioNode | null = null,
    options: { beepHz?: number; beepSeconds?: number } = {},
  ) {
    this.audioContext = audioContext;
    this.flash = flash;
    this.injectionTarget = injectionTarget;
    this.beepHz = options.beepHz ?? 1200;
    this.beepSeconds = options.beepSeconds ?? 0.08;
  }

  reset(): void {
    this.seq = 0;
  }

  nextSeq(): number {
    return this.seq;
  }

  /** 发射一个标记，闪光与蜂鸣尽量对齐到同一个未来时刻。 */
  fire(): MarkerShot {
    const seq = this.seq;
    this.seq += 1;
    const startAudio = this.audioContext.currentTime + 0.05;
    this.scheduleBeep(startAudio);
    this.scheduleFlash();
    return {
      seq,
      t0Performance: performance.now() + 50,
      t0Audio: startAudio,
      scheduledAt: performance.now(),
    };
  }

  private scheduleBeep(startAudio: number): void {
    const oscillator = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = this.beepHz;
    gain.gain.setValueAtTime(0, startAudio);
    gain.gain.linearRampToValueAtTime(0.35, startAudio + 0.008);
    gain.gain.setValueAtTime(0.35, startAudio + this.beepSeconds - 0.01);
    gain.gain.linearRampToValueAtTime(0, startAudio + this.beepSeconds);
    oscillator.connect(gain);
    if (this.injectionTarget) {
      gain.connect(this.injectionTarget);
    } else {
      gain.connect(this.audioContext.destination);
    }
    oscillator.start(startAudio);
    oscillator.stop(startAudio + this.beepSeconds + 0.02);
  }

  private scheduleFlash(): void {
    requestAnimationFrame(() => {
      const { context, width, height } = this.flash;
      context.save();
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.restore();
      setTimeout(() => {
        context.clearRect(0, 0, width, height);
      }, 90);
    });
  }
}
