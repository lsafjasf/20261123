import type { Fraction } from "./fraction.ts";
import {
  ZERO,
  clamp,
  compare,
  framesToMicroseconds,
  fraction,
} from "./fraction.ts";
import type {
  AudioSink,
  AudioSinkFactory,
  DeviceFormat,
  MigrationReason,
  PlaybackControllerOptions,
  PlaybackSnapshot,
  PlaybackStatus,
  PositionUpdate,
  SinkSnapshot,
} from "./types.ts";

const FALLBACK_POSITION = ZERO;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshotFor(sink: AudioSink): Promise<SinkSnapshot> {
  return sink.handoff();
}

export class PlaybackController {
  private readonly durationFrames: number;
  private readonly sampleRate: number;
  private readonly sinkFactory: AudioSinkFactory;
  private readonly onChange: ((snapshot: PlaybackSnapshot) => void) | undefined;
  private readonly durationPosition: Fraction;

  private status: PlaybackStatus = "idle";
  private position: Fraction;
  private sink: AudioSink | null = null;
  private device: DeviceFormat | null = null;
  private preferredDevice: DeviceFormat | null = null;
  private desiredPlaying = false;
  private recoverable = false;
  private lastError: string | null = null;
  private revision = 0;
  private seekRevision = 0;
  private sinkGeneration = 0;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: PlaybackControllerOptions) {
    if (!Number.isInteger(options.durationFrames) || options.durationFrames < 0) {
      throw new RangeError("durationFrames must be a non-negative integer");
    }
    if (!Number.isInteger(options.sampleRate) || options.sampleRate <= 0) {
      throw new RangeError("sampleRate must be a positive integer");
    }
    this.durationFrames = options.durationFrames;
    this.sampleRate = options.sampleRate;
    this.sinkFactory = options.sinkFactory;
    this.onChange = options.onChange;
    this.durationPosition = fraction(options.durationFrames);
    this.position = clamp(
      options.initialPosition ?? FALLBACK_POSITION,
      ZERO,
      this.durationPosition,
    );
  }

  get snapshot(): PlaybackSnapshot {
    return {
      status: this.status,
      position: this.position,
      durationFrames: this.durationFrames,
      positionSeconds:
        framesToMicroseconds(this.position, this.sampleRate) / 1_000_000,
      durationSeconds: this.durationFrames / this.sampleRate,
      device: this.device,
      resumeIntent: this.desiredPlaying,
      recoverable: this.recoverable,
      revision: this.revision,
      lastError: this.lastError,
    };
  }

  open(device: DeviceFormat): Promise<PlaybackSnapshot> {
    return this.enqueue(async () => {
      this.preferredDevice = device;
      this.desiredPlaying = false;
      await this.closeCurrentSink();
      this.status = "loading";
      this.lastError = null;
      this.publish();

      const opened = await this.openSink(device);
      if (opened) {
        this.status = "paused";
        this.recoverable = false;
      } else {
        this.status = "interrupted";
      }
      this.publish();
      return this.snapshot;
    });
  }

  play(): Promise<PlaybackSnapshot> {
    this.desiredPlaying = true;
    return this.enqueue(async () => {
      if (this.disposed) {
        return this.snapshot;
      }
      if (this.status === "ended" || compare(this.position, this.durationPosition) >= 0) {
        this.position = this.durationPosition;
        this.status = "ended";
        this.publish();
        return this.snapshot;
      }
      if (this.sink === null) {
        const device = this.preferredDevice;
        if (device === null || !(await this.openSink(device))) {
          this.status = "interrupted";
          this.publish();
          return this.snapshot;
        }
      }

      const sink = this.sink;
      if (sink === null) {
        return this.snapshot;
      }
      this.status = "playing";
      this.publish();
      try {
        await sink.play();
        this.recoverable = false;
        this.lastError = null;
      } catch (error) {
        await this.markInterrupted(error);
      }
      this.publish();
      return this.snapshot;
    });
  }

  pause(): Promise<PlaybackSnapshot> {
    this.desiredPlaying = false;
    return this.enqueue(async () => {
      const sink = this.sink;
      if (sink !== null) {
        try {
          const paused = await sink.pause();
          if (paused.generation === this.sinkGeneration) {
            this.position = this.clampPosition(paused.position);
          }
          this.status = "paused";
        } catch (error) {
          await this.markInterrupted(error);
        }
      } else if (this.status !== "interrupted") {
        this.status = "paused";
      }
      this.publish();
      return this.snapshot;
    });
  }

  seek(position: Fraction): Promise<PlaybackSnapshot> {
    this.position = this.clampPosition(position);
    this.seekRevision += 1;
    this.sinkGeneration += 1;
    return this.enqueue(async () => {
      const sink = this.sink;
      if (sink === null) {
        if (this.status === "playing") {
          this.status = "paused";
        }
        this.publish();
        return this.snapshot;
      }

      const generation = this.sinkGeneration;
      try {
        const result = await sink.seek(this.position, generation);
        if (result.generation === generation) {
          this.position = this.clampPosition(result.position);
        }
        if (this.desiredPlaying) {
          await sink.play();
          this.status = "playing";
        } else {
          this.status = "paused";
        }
        this.recoverable = false;
        this.lastError = null;
      } catch (error) {
        await this.markInterrupted(error);
      }
      this.publish();
      return this.snapshot;
    });
  }

  switchDevice(
    format: DeviceFormat,
    _reason: MigrationReason = "device-switch",
  ): Promise<PlaybackSnapshot> {
    return this.enqueue(async () => {
      const oldSink = this.sink;
      const seekRevisionAtHandoff = this.seekRevision;
      this.preferredDevice = format;
      this.status = "migrating";
      this.publish();

      if (oldSink !== null) {
        const handedOff = await this.handoff(oldSink);
        if (
          handedOff !== null &&
          this.seekRevision === seekRevisionAtHandoff
        ) {
          this.position = this.clampPosition(handedOff.position);
        }
        await this.closeSink(oldSink);
      }

      this.sink = null;
      this.device = null;
      this.publish();

      const opened = await this.openSink(format);
      if (!opened) {
        this.status = "interrupted";
        this.publish();
        return this.snapshot;
      }

      if (this.seekRevision !== seekRevisionAtHandoff && this.sink !== null) {
        try {
          const result = await this.sink.seek(this.position, this.sinkGeneration);
          if (result.generation === this.sinkGeneration) {
            this.position = this.clampPosition(result.position);
          }
        } catch (error) {
          await this.markInterrupted(error);
          this.publish();
          return this.snapshot;
        }
      }

      if (this.desiredPlaying) {
        try {
          await this.sink?.play();
          this.status = "playing";
        } catch (error) {
          await this.markInterrupted(error);
        }
      } else {
        this.status = "paused";
      }
      this.publish();
      return this.snapshot;
    });
  }

  deviceLost(message = "audio output device disappeared"): Promise<PlaybackSnapshot> {
    return this.enqueue(async () => {
      if (this.sink === null) {
        return this.snapshot;
      }
      const lostSink = this.sink;
      this.sink = null;
      this.device = null;
      this.sinkGeneration += 1;
      try {
        await lostSink.close();
      } catch {
        // The device is already gone; the saved transport position is still valid.
      }
      this.status = "interrupted";
      this.recoverable = true;
      this.lastError = message;
      this.publish();
      return this.snapshot;
    });
  }

  recover(format?: DeviceFormat): Promise<PlaybackSnapshot> {
    return this.enqueue(async () => {
      const target = format ?? this.preferredDevice;
      if (target === null) {
        this.status = "interrupted";
        this.recoverable = true;
        this.lastError = "no output device is available";
        this.publish();
        return this.snapshot;
      }
      this.preferredDevice = target;
      await this.closeCurrentSink();
      if (!(await this.openSink(target))) {
        this.status = "interrupted";
        this.publish();
        return this.snapshot;
      }
      if (this.desiredPlaying) {
        try {
          await this.sink?.play();
          this.status = "playing";
        } catch (error) {
          await this.markInterrupted(error);
        }
      } else {
        this.status = "paused";
      }
      this.recoverable = false;
      this.publish();
      return this.snapshot;
    });
  }

  acceptPositionUpdate(update: PositionUpdate): void {
    if (this.sink !== update.sink || this.status !== "playing") {
      return;
    }
    if (update.snapshot.generation !== this.sinkGeneration) {
      return;
    }
    const next = this.clampPosition(update.snapshot.position);
    if (compare(next, this.position) >= 0) {
      this.position = next;
      this.publish();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.desiredPlaying = false;
    await this.enqueue(async () => {
      await this.closeCurrentSink();
      this.status = "idle";
      this.sink = null;
      this.device = null;
      this.publish();
    });
  }

  private async openSink(device: DeviceFormat): Promise<boolean> {
    let sink: AudioSink | null = null;
    try {
      sink = await this.sinkFactory.create(device);
      this.sinkGeneration += 1;
      await sink.open(this.position, this.sinkGeneration);
      this.sink = sink;
      this.device = sink.format;
      this.recoverable = false;
      this.lastError = null;
      return true;
    } catch (error) {
      if (sink !== null) {
        await this.closeSink(sink);
      }
      this.sink = null;
      this.device = null;
      this.recoverable = true;
      this.lastError = errorMessage(error);
      return false;
    }
  }

  private async handoff(sink: AudioSink): Promise<SinkSnapshot | null> {
    try {
      const snapshot = await snapshotFor(sink);
      if (snapshot.generation === this.sinkGeneration) {
        return snapshot;
      }
      return null;
    } catch (error) {
      this.recoverable = true;
      this.lastError = errorMessage(error);
      return null;
    }
  }

  private async closeCurrentSink(): Promise<void> {
    const sink = this.sink;
    this.sink = null;
    this.device = null;
    if (sink !== null) {
      await this.closeSink(sink);
    }
  }

  private async closeSink(sink: AudioSink): Promise<void> {
    try {
      await sink.close();
    } catch (error) {
      this.lastError = errorMessage(error);
    }
  }

  private async markInterrupted(error: unknown): Promise<void> {
    const sink = this.sink;
    this.sink = null;
    this.device = null;
    this.sinkGeneration += 1;
    if (sink !== null) {
      await this.closeSink(sink);
    }
    this.status = "interrupted";
    this.recoverable = true;
    this.lastError = errorMessage(error);
  }

  private clampPosition(position: Fraction): Fraction {
    return clamp(position, ZERO, this.durationPosition);
  }

  private publish(): void {
    this.revision += 1;
    this.onChange?.(this.snapshot);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
