/**
 * AudioWorklet 处理器：精确播放循环。
 * 该文件运行在 AudioWorkletGlobalScope，通过独立模块 URL 加载，
 * 因此不 import 工程内其他模块，类型在此就地声明。
 *
 * 冻结语义：主线程把 MediaClock 置为冻结态后停止 postMessage，
 * 已入队的少量样本播完即静默；恢复后从同一 PTS 的帧继续，画面仍停在最后一帧。
 */

interface ClockAudioWorkletOptions extends AudioWorkletNodeOptions {
  processorOptions: {
    readonly channelCount: number;
  };
}

interface PcmFrameMessage {
  readonly type: 'pcm';
  readonly ptsMs: number;
  readonly sampleRate: number;
  /** 交错 PCM 浮点样本。 */
  readonly channels: Float32Array[];
}

interface ControlMessage {
  readonly type: 'reset' | 'suspend' | 'resume';
}

type IncomingMessage = PcmFrameMessage | ControlMessage;

class ClockAudioProcessor extends AudioWorkletProcessor {
  private readonly queue: Float32Array[] = [];
  private readonly outputChannels: number;
  private suspended = false;

  constructor(options: ClockAudioWorkletOptions) {
    super();
    this.outputChannels = options.processorOptions.channelCount;
    this.port.onmessage = (event: MessageEvent<IncomingMessage>) => {
      const message = event.data;
      if (message.type === 'reset') {
        this.queue.length = 0;
        this.suspended = false;
        return;
      }
      if (message.type === 'suspend') {
        this.suspended = true;
        this.queue.length = 0;
        return;
      }
      if (message.type === 'resume') {
        this.suspended = false;
        return;
      }
      this.enqueue(message);
    };
  }

  private enqueue(message: PcmFrameMessage): void {
    const frameLength = message.channels[0]?.length ?? 0;
    const interleaved = new Float32Array(frameLength * this.outputChannels);
    for (let sample = 0; sample < frameLength; sample += 1) {
      for (let channel = 0; channel < this.outputChannels; channel += 1) {
        interleaved[sample * this.outputChannels + channel] =
          message.channels[channel]?.[sample] ?? 0;
      }
    }
    this.queue.push(interleaved);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output) {
      return true;
    }
    const blockLength = output[0]?.length ?? 128;
    if (this.suspended) {
      for (const channel of output) {
        channel.fill(0);
      }
      return true;
    }

    let offset = 0;
    while (offset < blockLength) {
      const chunk = this.queue[0];
      if (!chunk) {
        for (const channel of output) {
          channel.fill(0, offset);
        }
        break;
      }
      const availableFrames = chunk.length / this.outputChannels;
      const take = Math.min(blockLength - offset, availableFrames);
      for (let frame = 0; frame < take; frame += 1) {
        for (let channel = 0; channel < this.outputChannels; channel += 1) {
          const target = output[channel];
          if (target) {
            target[offset + frame] = chunk[(frame * this.outputChannels) + channel] ?? 0;
          }
        }
      }
      offset += take;
      if (take >= availableFrames) {
        this.queue.shift();
      } else {
        this.queue[0] = chunk.subarray(take * this.outputChannels);
      }
    }
    return true;
  }
}

registerProcessor('clock-audio-processor', ClockAudioProcessor);
