/**
 * 处理端 AudioWorklet：对采集后的 PCM 施加固定增益与一阶低通滤波，
 * 模拟排练链路中的“处理”环节，并在输出侧做第二次标记能量检测，
 * 回传 process 阶段时间点与样本计数。
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

interface ProcessConfig {
  type: 'config' | 'reset';
  gain?: number;
  cutoffHz?: number;
  threshold?: number;
}

class ProcessProcessor extends AudioWorkletProcessor {
  private gain = 1;
  private alpha = 0.2;
  private threshold = 0.1;
  private previous = 0;
  private cooldown = 0;
  private refractoryFrames: number;
  private outFrameCount = 0;
  private outSampleCount = 0;

  constructor() {
    super();
    const scope = globalThis as { sampleRate: number; port: MessagePort };
    this.refractoryFrames = Math.round((0.18 * scope.sampleRate) / 128);
    scope.port.onmessage = (event: MessageEvent<ProcessConfig>) => {
      if (event.data.type === 'reset') {
        this.previous = 0;
        this.cooldown = 0;
        this.outFrameCount = 0;
        this.outSampleCount = 0;
        return;
      }
      if (event.data.gain !== undefined) {
        this.gain = event.data.gain;
      }
      if (event.data.threshold !== undefined) {
        this.threshold = event.data.threshold;
      }
      if (event.data.cutoffHz !== undefined) {
        const rc = 1 / (2 * Math.PI * event.data.cutoffHz);
        const dt = 1 / scope.sampleRate;
        this.alpha = dt / (rc + dt);
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) {
      return true;
    }
    let peak = 0;
    for (let i = 0; i < input.length; i += 1) {
      const amplified = input[i] * this.gain;
      const filtered = this.previous + this.alpha * (amplified - this.previous);
      this.previous = filtered;
      output[i] = filtered;
      const magnitude = Math.abs(filtered);
      if (magnitude > peak) {
        peak = magnitude;
      }
    }
    this.outFrameCount += 1;
    this.outSampleCount += output.length;
    if (this.cooldown > 0) {
      this.cooldown -= 1;
    } else if (peak >= this.threshold) {
      this.cooldown = this.refractoryFrames;
      const scope = globalThis as AudioWorkletGlobalScope;
      scope.port.postMessage({
        type: 'marker-detected',
        stage: 'process',
        audioTime: scope.currentTime,
        frame: scope.currentFrame,
        peak,
      });
    }
    return true;
  }
}

(globalThis as AudioWorkletGlobalScope).registerProcessor(
  'process-processor',
  ProcessProcessor,
);

export {};
