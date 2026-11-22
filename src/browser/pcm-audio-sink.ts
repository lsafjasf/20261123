import type { Fraction } from "../core/fraction.ts";
import { fraction, toNumber } from "../core/fraction.ts";
import type { PcmSource } from "../core/pcm-source.ts";
import type {
  AudioSink,
  AudioSinkFactory,
  DeviceFormat,
  SinkSnapshot,
} from "../core/types.ts";

interface SnapshotMessage {
  readonly type: "snapshot" | "progress";
  readonly requestId?: number;
  readonly generation: number;
  readonly position: number;
  readonly outputFrames: number;
  readonly snapshotScale: number;
}

interface PendingRequest {
  readonly resolve: (snapshot: SinkSnapshot) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface SinkCapableContext extends AudioContext {
  setSinkId?: (sinkId: string) => Promise<void>;
}

export interface PcmAudioSinkHooks {
  readonly onPosition?: (sink: PcmAudioSink, snapshot: SinkSnapshot) => void;
  readonly onLost?: (sink: PcmAudioSink, error: Error) => void;
}

export interface PcmAudioSinkFactoryOptions extends PcmAudioSinkHooks {
  readonly workletUrl?: string;
}

const SNAPSHOT_TIMEOUT_MS = 2_000;

function channelLayout(channelCount: number): DeviceFormat["channelLayout"] {
  return channelCount <= 1 ? "mono" : channelCount === 2 ? "stereo" : "surround";
}

function positionToFraction(position: number, scale: number): Fraction {
  const whole = Math.floor(position);
  const phase = Math.round((position - whole) * scale);
  return fraction(whole * scale + phase, scale);
}

function createContext(sampleRate: number): SinkCapableContext {
  const Context = globalThis.AudioContext;
  if (Context === undefined) {
    throw new Error("WebAudio is not available in this browser");
  }
  try {
    return new Context({
      sampleRate,
      latencyHint: "interactive",
    }) as SinkCapableContext;
  } catch {
    return new Context({ latencyHint: "interactive" }) as SinkCapableContext;
  }
}

export class PcmAudioSink implements AudioSink {
  readonly format: DeviceFormat;
  readonly snapshotScale = 2 ** 24;
  private readonly context: SinkCapableContext;
  private readonly source: PcmSource;
  private readonly hooks: PcmAudioSinkHooks;
  private node: AudioWorkletNode | null = null;
  private generation = 0;
  private requestCounter = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private lastSnapshot: SinkSnapshot;
  private closing = false;
  private lostNotified = false;

  constructor(
    context: SinkCapableContext,
    source: PcmSource,
    format: DeviceFormat,
    hooks: PcmAudioSinkHooks,
  ) {
    this.context = context;
    this.source = source;
    this.format = format;
    this.hooks = hooks;
    this.lastSnapshot = {
      position: fraction(0),
      renderedOutputFrames: 0,
      generation: 0,
    };
    this.context.onstatechange = () => this.handleStateChange();
  }

  async prepare(workletUrl: string): Promise<void> {
    await this.context.audioWorklet.addModule(workletUrl);
    this.node = new AudioWorkletNode(this.context, "pcm-migrator", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.format.channelCount],
      channelCount: this.format.channelCount,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    this.node.port.onmessage = (event: MessageEvent<SnapshotMessage>) => {
      this.handleMessage(event.data);
    };
    this.node.connect(this.context.destination);
  }

  async open(position: Fraction, generation: number): Promise<void> {
    const node = this.node;
    if (node === null) {
      throw new Error("audio worklet has not been prepared");
    }
    this.generation = generation;
    this.lastSnapshot = {
      position,
      renderedOutputFrames: 0,
      generation,
    };
    node.port.postMessage({
      type: "configure",
      sourceRate: this.source.sampleRate,
      sourceChannels: this.source.channelCount,
      outputChannels: this.format.channelCount,
      generation,
      position: toNumber(position),
    });
    for (const chunk of this.source.getChunks()) {
      const channels = chunk.channels.map((channel) => new Float32Array(channel));
      node.port.postMessage(
        {
          type: "append",
          startFrame: chunk.startFrame,
          channels,
        },
        channels.map((channel) => channel.buffer),
      );
    }
  }

  async play(): Promise<void> {
    await this.context.resume();
    this.post({ type: "play", generation: this.generation });
  }

  async pause(): Promise<SinkSnapshot> {
    return this.request("pause");
  }

  async seek(position: Fraction, generation: number): Promise<SinkSnapshot> {
    this.generation = generation;
    this.lastSnapshot = {
      position,
      renderedOutputFrames: 0,
      generation,
    };
    return this.request("seek", toNumber(position));
  }

  async handoff(): Promise<SinkSnapshot> {
    return this.request("handoff");
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("audio sink closed"));
    }
    this.pending.clear();
    if (this.node !== null) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    if (this.context.state !== "closed") {
      await this.context.close();
    }
  }

  private request(
    type: "pause" | "handoff" | "seek",
    position?: number,
  ): Promise<SinkSnapshot> {
    const requestId = ++this.requestCounter;
    return new Promise<SinkSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${type} acknowledgement timed out`));
      }, SNAPSHOT_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.post({
        type,
        generation: this.generation,
        requestId,
        position,
      });
      if (this.context.state === "suspended") {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(this.lastSnapshot);
      }
    });
  }

  private post(message: object): void {
    const node = this.node;
    if (node === null) {
      throw new Error("audio worklet is not connected");
    }
    node.port.postMessage(message);
  }

  private handleMessage(message: SnapshotMessage): void {
    const snapshot: SinkSnapshot = {
      position: positionToFraction(message.position, message.snapshotScale),
      renderedOutputFrames: message.outputFrames,
      generation: message.generation,
    };
    if (snapshot.generation === this.generation) {
      this.lastSnapshot = snapshot;
    }
    if (message.type === "progress") {
      this.hooks.onPosition?.(this, snapshot);
      return;
    }
    if (message.requestId === undefined) {
      return;
    }
    const request = this.pending.get(message.requestId);
    if (request === undefined) {
      return;
    }
    clearTimeout(request.timer);
    this.pending.delete(message.requestId);
    request.resolve(snapshot);
  }

  private handleStateChange(): void {
    if (this.closing || this.lostNotified) {
      return;
    }
    const state = this.context.state as string;
    if (state === "interrupted" || state === "closed") {
      this.lostNotified = true;
      this.hooks.onLost?.(
        this,
        new Error(`audio output entered ${state} state`),
      );
    }
  }
}

export class PcmAudioSinkFactory implements AudioSinkFactory {
  private readonly source: PcmSource;
  private readonly options: PcmAudioSinkFactoryOptions;
  private readonly workletUrl: string;

  constructor(source: PcmSource, options: PcmAudioSinkFactoryOptions = {}) {
    this.source = source;
    this.options = options;
    this.workletUrl =
      options.workletUrl ??
      new URL("./pcm-player.worklet.js", import.meta.url).href;
  }

  async create(requestedFormat: DeviceFormat): Promise<AudioSink> {
    const context = createContext(requestedFormat.sampleRate);
    try {
      if (
        requestedFormat.deviceId !== "" &&
        requestedFormat.deviceId !== "default"
      ) {
        if (typeof context.setSinkId !== "function") {
          throw new Error("this browser cannot route WebAudio to a chosen device");
        }
        await context.setSinkId(requestedFormat.deviceId);
      }

      const maximumChannels = Math.max(
        1,
        context.destination.maxChannelCount || requestedFormat.channelCount,
      );
      const channelCount = Math.max(
        1,
        Math.min(requestedFormat.channelCount, maximumChannels),
      );
      try {
        context.destination.channelCount = channelCount;
        context.destination.channelCountMode = "explicit";
        context.destination.channelInterpretation = "speakers";
      } catch {
        // Some browsers expose a fixed destination layout; the worklet still
        // downmixes explicitly before the hardware boundary.
      }

      const actualFormat: DeviceFormat = {
        ...requestedFormat,
        sampleRate: context.sampleRate,
        channelCount,
        channelLayout: channelLayout(channelCount),
      };
      const sink = new PcmAudioSink(
        context,
        this.source,
        actualFormat,
        this.options,
      );
      await sink.prepare(this.workletUrl);
      return sink;
    } catch (error) {
      if (context.state !== "closed") {
        await context.close().catch(() => undefined);
      }
      throw error;
    }
  }
}
