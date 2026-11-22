/**
 * 接收端声卡输出 AudioWorklet。
 * 上游 MediaElementSource 把 MediaSource 解码后的音频送入本节点，
 * 节点透传到 destination（真正推动声卡），同时：
 * - 能量检测标记蜂鸣，回传 output 阶段时间点 T8；
 * - 检测静音帧（解码欠载导致的输出丢样）并上报 underrun。
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

interface WorkletConfig {
  type: 'config' | 'reset';
  threshold?: number;
  silentFloor?: number;
}

class OutputProcessor extends AudioWorkletProcessor {
  private threshold = 0.1;
  private silentFloor = 0.01;
  private underrunCount = 0;
  private cooldown = 0;
  private readonly refractoryFrames: number;
  private silentStreak = 0;

  constructor() {
    super();
    const scope = globalThis as { sampleRate: number; port: MessagePort };
    this.refractoryFrames = Math.round((0.18 * scope.sampleRate) / 128);
    scope.port.onmessage = (
      event: MessageEvent<WorkletConfig>,
    ) => {
      if (event.data.type === 'reset') {
        this.underrunCount = 0;
        this.cooldown = 0;
        this.silentStreak = 0;
        return;
      }
      if (event.data.threshold !== undefined) {
        this.threshold = event.data.threshold;
      }
      if (event.data.silentFloor !== undefined) {
        this.silentFloor = event.data.silentFloor;
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) {
      return true;
    }
    const scope = globalThis as AudioWorkletGlobalScope;
    if (!input) {
      output.fill(0);
      return true;
    }
    output.set(input);
    let peak = 0;
    for (let i = 0; i < input.length; i += 1) {
      const magnitude = Math.abs(input[i]);
      if (magnitude > peak) {
        peak = magnitude;
      }
    }
    if (peak < this.silentFloor) {
      this.silentStreak += 1;
      if (this.silentStreak === Math.round(scope.sampleRate / 128 / 20)) {
        this.underrunCount += 1;
        scope.port.postMessage({
          type: 'underrun',
          count: this.underrunCount,
          audioTime: scope.currentTime,
        });
      }
    } else {
      this.silentStreak = 0;
    }
    if (this.cooldown > 0) {
      this.cooldown -= 1;
    } else if (peak >= this.threshold) {
      this.cooldown = this.refractoryFrames;
      scope.port.postMessage({
        type: 'marker-output',
        audioTime: scope.currentTime,
        frame: scope.currentFrame,
        peak,
      });
    }
    return true;
  }
}

(globalThis as AudioWorkletGlobalScope).registerProcessor(
  'output-processor',
  OutputProcessor,
);

export {};
