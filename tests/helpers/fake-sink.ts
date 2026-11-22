import type { Fraction } from "../../src/core/fraction.ts";
import { ZERO } from "../../src/core/fraction.ts";
import { PcmSource } from "../../src/core/pcm-source.ts";
import { SourceRenderer } from "../../src/core/source-renderer.ts";
import type {
  AudioSink,
  AudioSinkFactory,
  DeviceFormat,
  SinkSnapshot,
} from "../../src/core/types.ts";

export interface EmittedBlock {
  readonly sinkId: string;
  readonly start: Fraction;
  readonly end: Fraction;
  readonly channels: readonly Float32Array[];
}

export class FakeSink implements AudioSink {
  readonly format: DeviceFormat;
  readonly source: PcmSource;
  readonly emitted: EmittedBlock[] = [];
  readonly openedAt: Fraction[] = [];
  renderer: SourceRenderer;
  generation = 0;
  outputFrames = 0;
  closed = false;
  playing = false;
  failOpen = false;
  failPlay = false;
  handoffGate: Promise<void> | null = null;
  handoffStarted: (() => void) | null = null;

  constructor(format: DeviceFormat, source: PcmSource) {
    if (format.sampleRate <= 0 || format.channelCount <= 0) {
      throw new RangeError("invalid fake sink format");
    }
    this.format = format;
    this.source = source;
    this.renderer = new SourceRenderer(
      source,
      format.sampleRate,
      format.channelCount,
    );
  }

  async open(position: Fraction, generation: number): Promise<void> {
    if (this.failOpen) {
      throw new Error(`failed to open ${this.format.deviceId}`);
    }
    this.renderer = new SourceRenderer(
      this.source,
      this.format.sampleRate,
      this.format.channelCount,
      position,
    );
    this.generation = generation;
    this.openedAt.push(position);
  }

  async play(): Promise<void> {
    if (this.failPlay) {
      throw new Error(`failed to start ${this.format.deviceId}`);
    }
    this.playing = true;
  }

  async pause(): Promise<SinkSnapshot> {
    this.playing = false;
    return this.currentSnapshot();
  }

  async seek(position: Fraction, generation: number): Promise<SinkSnapshot> {
    this.renderer.position = position;
    this.generation = generation;
    this.outputFrames = 0;
    return this.currentSnapshot();
  }

  async handoff(): Promise<SinkSnapshot> {
    this.playing = false;
    this.handoffStarted?.();
    if (this.handoffGate !== null) {
      await this.handoffGate;
    }
    return this.currentSnapshot();
  }

  async close(): Promise<void> {
    this.playing = false;
    this.closed = true;
  }

  advance(outputFrames: number): void {
    if (!this.playing) {
      return;
    }
    const block = this.renderer.render(outputFrames);
    this.outputFrames += outputFrames;
    this.emitted.push({
      sinkId: this.format.deviceId,
      start: block.start,
      end: block.end,
      channels: block.channels,
    });
  }

  currentSnapshot(): SinkSnapshot {
    return {
      position: this.renderer.position,
      renderedOutputFrames: this.outputFrames,
      generation: this.generation,
    };
  }
}

export class FakeSinkFactory implements AudioSinkFactory {
  readonly source: PcmSource;
  readonly sinks: FakeSink[] = [];
  readonly formats: DeviceFormat[] = [];
  failNextOpen = false;

  constructor(source: PcmSource) {
    this.source = source;
  }

  async create(format: DeviceFormat): Promise<AudioSink> {
    const sink = new FakeSink(format, this.source);
    sink.failOpen = this.failNextOpen;
    this.failNextOpen = false;
    this.sinks.push(sink);
    this.formats.push(format);
    return sink;
  }

  get latest(): FakeSink {
    const sink = this.sinks.at(-1);
    if (sink === undefined) {
      throw new Error("no sink has been created");
    }
    return sink;
  }
}

export function makeSource(
  frameCount: number,
  sampleRate = 48_000,
  channelCount = 2,
): PcmSource {
  const channels = Array.from(
    { length: channelCount },
    (_, channel) => new Float32Array(frameCount),
  );
  for (let channel = 0; channel < channelCount; channel += 1) {
    for (let frame = 0; frame < frameCount; frame += 1) {
      channels[channel][frame] = frame + channel * 0.25;
    }
  }
  return new PcmSource([
    {
      startFrame: 0,
      frameCount,
      sampleRate,
      channelCount,
      channels,
    },
  ]);
}

export const format = (
  deviceId: string,
  sampleRate: number,
  channelCount: number,
): DeviceFormat => ({
  deviceId,
  label: deviceId,
  sampleRate,
  channelCount,
  channelLayout:
    channelCount === 1 ? "mono" : channelCount === 2 ? "stereo" : "surround",
});
