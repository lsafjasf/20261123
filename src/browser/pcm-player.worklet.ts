declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: typeof AudioWorkletProcessor,
): void;

interface WorkletChunk {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly channels: readonly Float32Array[];
}

interface ConfigureMessage {
  readonly type: "configure";
  readonly sourceRate: number;
  readonly sourceChannels: number;
  readonly outputChannels: number;
  readonly generation: number;
  readonly position: number;
}

interface AppendMessage {
  readonly type: "append";
  readonly startFrame: number;
  readonly channels: readonly Float32Array[];
}

interface TransportMessage {
  readonly type: "play" | "pause" | "handoff" | "snapshot" | "seek";
  readonly generation: number;
  readonly requestId?: number;
  readonly position?: number;
}

type IncomingMessage = ConfigureMessage | AppendMessage | TransportMessage;

const PROGRESS_INTERVAL_QUANTA = 8;
const SNAPSHOT_SCALE = 2 ** 24;
const FADE_SECONDS = 0.006;

function mapChannels(
  source: readonly number[],
  targetChannelCount: number,
): number[] {
  const output = new Array<number>(targetChannelCount).fill(0);
  if (targetChannelCount === 0 || source.length === 0) {
    return output;
  }
  if (source.length === 1) {
    return output.fill(source[0]);
  }
  if (targetChannelCount === 1) {
    let sum = 0;
    for (const sample of source) {
      sum += sample;
    }
    output[0] = sum / source.length;
    return output;
  }
  const copied = Math.min(source.length, targetChannelCount);
  for (let channel = 0; channel < copied; channel += 1) {
    output[channel] = source[channel];
  }
  return output;
}

class PcmMigratorProcessor extends AudioWorkletProcessor {
  private chunks: WorkletChunk[] = [];
  private sourceRate = 48_000;
  private sourceChannels = 2;
  private outputChannels = 2;
  private position = 0;
  private generation = 0;
  private playing = false;
  private outputFrames = 0;
  private quantaSinceProgress = 0;
  private gain = 0;
  private gainTarget = 0;
  private stopAfterFade: number | undefined;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<IncomingMessage>) => {
      this.handleMessage(event.data);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (output === undefined || output.length === 0) {
      return true;
    }
    const frameCount = output[0].length;
    for (const channel of output) {
      channel.fill(0);
    }
    if (!this.playing) {
      return true;
    }

    const step = this.sourceRate / sampleRate;
    const gainStep = 1 / (FADE_SECONDS * sampleRate);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const chunk = this.findChunk(this.position);
      if (chunk === null) {
        this.playing = false;
        if (this.stopAfterFade !== undefined) {
          const requestId = this.stopAfterFade;
          this.stopAfterFade = undefined;
          this.postSnapshot(requestId);
        }
        break;
      }
      const samples = this.readSourceFrame(this.position, chunk);
      const mapped = mapChannels(samples, this.outputChannels);
      this.gain = nextGain(this.gain, this.gainTarget, gainStep);
      for (let channel = 0; channel < output.length; channel += 1) {
        output[channel][frame] = (mapped[channel] ?? 0) * this.gain;
      }
      this.position += step;
      this.outputFrames += 1;
      if (this.gain === 0 && this.stopAfterFade !== undefined) {
        this.playing = false;
        const requestId = this.stopAfterFade;
        this.stopAfterFade = undefined;
        this.postSnapshot(requestId);
        break;
      }
    }
    this.maybeReportProgress();
    return true;
  }

  private handleMessage(message: IncomingMessage): void {
    if (message.type === "configure") {
      this.configure(message);
      return;
    }
    if (message.type === "append") {
      this.append(message);
      return;
    }
    if (message.generation !== this.generation) {
      return;
    }
    if (message.type === "play") {
      this.playing = true;
      this.gainTarget = 1;
      return;
    }
    if (message.type === "seek" && message.position !== undefined) {
      this.position = Math.max(0, message.position);
      this.outputFrames = 0;
      this.gain = 0;
      this.gainTarget = this.playing ? 1 : 0;
      this.postSnapshot(message.requestId);
      return;
    }
    if (message.type === "pause" || message.type === "handoff") {
      if (!this.playing || this.gain === 0) {
        this.playing = false;
        this.postSnapshot(message.requestId);
      } else {
        this.gainTarget = 0;
        this.stopAfterFade = message.requestId;
      }
      return;
    }
    if (message.type === "snapshot") {
      this.postSnapshot(message.requestId);
    }
  }

  private configure(message: ConfigureMessage): void {
    this.chunks = [];
    this.sourceRate = message.sourceRate;
    this.sourceChannels = message.sourceChannels;
    this.outputChannels = message.outputChannels;
    this.position = message.position;
    this.generation = message.generation;
    this.playing = false;
    this.outputFrames = 0;
    this.quantaSinceProgress = 0;
    this.gain = 0;
    this.gainTarget = 0;
    this.stopAfterFade = undefined;
  }

  private append(message: AppendMessage): void {
    const frameCount = message.channels[0]?.length ?? 0;
    if (frameCount === 0) {
      return;
    }
    this.chunks.push({
      startFrame: message.startFrame,
      endFrame: message.startFrame + frameCount,
      channels: message.channels,
    });
    this.chunks.sort((left, right) => left.startFrame - right.startFrame);
  }

  private findChunk(framePosition: number): WorkletChunk | null {
    const frame = Math.floor(framePosition);
    let low = 0;
    let high = this.chunks.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const chunk = this.chunks[middle];
      if (frame < chunk.startFrame) {
        high = middle - 1;
      } else if (frame >= chunk.endFrame) {
        low = middle + 1;
      } else {
        return chunk;
      }
    }
    return null;
  }

  private readSourceFrame(
    framePosition: number,
    chunk: WorkletChunk,
  ): number[] {
    const lowerFrame = Math.floor(framePosition);
    const phase = framePosition - lowerFrame;
    const lowerIndex = lowerFrame - chunk.startFrame;
    const upperIndex = Math.min(lowerIndex + 1, chunk.endFrame - chunk.startFrame - 1);
    const nextChunk =
      lowerIndex + 1 >= chunk.endFrame - chunk.startFrame
        ? this.findChunk(lowerFrame + 1)
        : null;
    const samples = new Array<number>(this.sourceChannels).fill(0);
    for (let channel = 0; channel < this.sourceChannels; channel += 1) {
      const data = chunk.channels[channel];
      if (data === undefined) {
        continue;
      }
      const lower = data[lowerIndex] ?? 0;
      const upper =
        nextChunk?.channels[channel]?.[0] ?? data[upperIndex] ?? lower;
      samples[channel] = lower + (upper - lower) * phase;
    }
    return samples;
  }

  private maybeReportProgress(): void {
    this.quantaSinceProgress += 1;
    if (this.quantaSinceProgress < PROGRESS_INTERVAL_QUANTA) {
      return;
    }
    this.quantaSinceProgress = 0;
    this.port.postMessage({
      type: "progress",
      generation: this.generation,
      position: this.position,
      outputFrames: this.outputFrames,
      snapshotScale: SNAPSHOT_SCALE,
    });
  }

  private postSnapshot(requestId?: number): void {
    this.port.postMessage({
      type: "snapshot",
      requestId,
      generation: this.generation,
      position: this.position,
      outputFrames: this.outputFrames,
      snapshotScale: SNAPSHOT_SCALE,
    });
  }
}

function nextGain(current: number, target: number, step: number): number {
  if (current < target) {
    return Math.min(target, current + step);
  }
  return Math.max(target, current - step);
}

registerProcessor("pcm-migrator", PcmMigratorProcessor);
