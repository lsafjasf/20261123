/**
 * 采集端 AudioWorklet。
 * 职责：
 * 1. 透传麦克风采到的 PCM（128 样本一帧）到主线程编码；
 * 2. 能量检测识别注入的短促标记音，命中后回传 capture 阶段时间点；
 * 3. 统计采集帧数与样本数，供丢样判断。
 * 该文件会被类型擦除后直接作为 worklet 模块加载，不能引入普通模块。
 */

declare global {
  interface AudioWorkletGlobalScope {
    currentFrame: number;
    currentTime: number;
    sampleRate: number;
    port: MessagePort;
    registerProcessor: (
      name: string,
      ctor: new () => AudioWorkletProcessor,
    ) => void;
  }
}

interface WorkletMessage {
  type: 'reset' | 'config';
  threshold?: number;
  refractoryMs?: number;
}

class CaptureProcessor extends AudioWorkletProcessor {
  private threshold: number;
  private refractoryFrames: number;
  private cooldown = 0;
  private frameCount = 0;
  private sampleCount = 0;

  constructor() {
    super();
    this.threshold = 0.12;
    this.refractoryFrames = Math.round(
      (0.18 * (globalThis as { sampleRate: number }).sampleRate) / 128,
    );
    (globalThis as { port: MessagePort }).port.onmessage = (
      event: MessageEvent<WorkletMessage>,
    ) => {
      if (event.data.type === 'config') {
        this.threshold = event.data.threshold ?? this.threshold;
        this.refractoryFrames = Math.round(
          ((event.data.refractoryMs ?? 180) / 1000) *
            (globalThis as { sampleRate: number }).sampleRate /
            128,
        );
      } else if (event.data.type === 'reset') {
        this.frameCount = 0;
        this.sampleCount = 0;
        this.cooldown = 0;
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input) {
      return true;
    }
    if (output) {
      output.set(input);
    }
    this.frameCount += 1;
    this.sampleCount += input.length;

    let peak = 0;
    for (let i = 0; i < input.length; i += 1) {
      const magnitude = Math.abs(input[i]);
      if (magnitude > peak) {
        peak = magnitude;
      }
    }
    if (this.cooldown > 0) {
      this.cooldown -= 1;
    } else if (peak >= this.threshold) {
      this.cooldown = this.refractoryFrames;
      const scope = globalThis as AudioWorkletGlobalScope;
      scope.port.postMessage({
        type: 'marker-detected',
        stage: 'capture',
        audioTime: scope.currentTime,
        frame: scope.currentFrame,
        peak,
      });
    }
    scopePort().postMessage({
      type: 'pcm',
      samples: input.slice(0),
      audioTime: (globalThis as AudioWorkletGlobalScope).currentTime,
    });
    return true;
  }
}

function scopePort(): MessagePort {
  return (globalThis as { port: MessagePort }).port;
}

(globalThis as AudioWorkletGlobalScope).registerProcessor(
  'capture-processor',
  CaptureProcessor,
);

export {};
