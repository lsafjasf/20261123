import type { BackendFactory, DecoderBackend } from './backend.ts';
import { DecoderLifecycle, type StateChange } from './lifecycle.ts';
import { SoftwareDecoderBackend } from './backends/software.ts';
import { WebCodecsHardwareBackend } from './backends/webcodecs.ts';
import {
  DecoderError,
  type CodecConfig,
  type DecodedFrame,
  type DecoderState,
  type EncodedPacket,
  type FailurePhase,
} from './types.ts';

export interface FallbackEvent {
  from: 'hardware' | 'software';
  to: 'hardware' | 'software';
  phase: FailurePhase;
  error: DecoderError;
  fallbacksUsed: number;
}

export interface PlayerOptions {
  hardwareFactory?: BackendFactory;
  softwareFactory?: BackendFactory;
  /** How many times the player may swap backends. Default 1 (hw -> sw). */
  maxFallbacks?: number;
  onFrame?: (frame: DecodedFrame) => void;
  onFallback?: (event: FallbackEvent) => void;
  onStateChange?: (change: StateChange) => void;
}

/**
 * Owns one active DecoderLifecycle at a time and applies the fallback
 * policy. Probe, open, feed, pause, reset and release all go through the
 * same lifecycle states no matter which backend is active, so the player
 * can never believe a decoder is open when it is not.
 */
export class PlayerDecoder {
  private readonly hwFactory: BackendFactory;
  private readonly swFactory: BackendFactory;
  private readonly maxFallbacks: number;
  private readonly opts: PlayerOptions;

  private active: DecoderLifecycle | null = null;
  private config: CodecConfig | null = null;
  private fallbacksUsed = 0;
  private failedError: DecoderError | null = null;
  /** Packets since (and including) the last keyframe, for mid-stream replay. */
  private replayBuffer: EncodedPacket[] = [];

  constructor(options: PlayerOptions = {}) {
    this.opts = options;
    this.hwFactory = options.hardwareFactory ?? (() => new WebCodecsHardwareBackend());
    this.swFactory = options.softwareFactory ?? (() => new SoftwareDecoderBackend());
    this.maxFallbacks = options.maxFallbacks ?? 1;
  }

  get state(): DecoderState {
    if (this.active) return this.active.state;
    return this.failedError ? 'failed' : 'idle';
  }

  get activeBackend(): 'hardware' | 'software' | null {
    return this.active?.kind ?? null;
  }

  get fallbacks(): number {
    return this.fallbacksUsed;
  }

  private adopt(backend: DecoderBackend): DecoderLifecycle {
    const lifecycle = new DecoderLifecycle(backend);
    if (this.opts.onStateChange) lifecycle.onStateChange(this.opts.onStateChange);
    this.active = lifecycle;
    return lifecycle;
  }

  private async tryOpen(factory: BackendFactory): Promise<DecoderLifecycle> {
    const lifecycle = this.adopt(factory());
    await lifecycle.probe(this.config!);
    await lifecycle.open(this.config!);
    return lifecycle;
  }

  async open(config: CodecConfig): Promise<void> {
    if (this.active) throw new Error('player already open; release() first');
    this.config = config;
    this.failedError = null;
    this.fallbacksUsed = 0;
    this.replayBuffer = [];

    const preferHw = config.preferHardware !== false;
    try {
      if (preferHw) {
        await this.tryOpen(this.hwFactory);
      } else {
        await this.tryOpen(this.swFactory);
      }
    } catch (err) {
      const error = this.asDecoderError(err, 'open');
      await this.discardActive();
      if (!(await this.maybeFallback(error))) throw error;
    }
  }

  async decode(packet: EncodedPacket): Promise<DecodedFrame> {
    this.requireActive();
    if (packet.isKeyframe) this.replayBuffer = [];
    this.replayBuffer.push(packet);
    try {
      const frame = await this.active!.decode(packet);
      this.opts.onFrame?.(frame);
      return frame;
    } catch (err) {
      const error = this.asDecoderError(err, 'mid-stream');
      await this.discardActive();
      if (await this.maybeFallback(error)) {
        return this.replayFromKeyframe();
      }
      throw error;
    }
  }

  async pause(): Promise<void> {
    this.requireActive();
    await this.active!.pause();
  }

  async resume(): Promise<void> {
    this.requireActive();
    await this.active!.resume();
  }

  async reset(): Promise<void> {
    this.requireActive();
    await this.active!.reset();
    this.replayBuffer = [];
  }

  async release(): Promise<void> {
    await this.discardActive();
    this.config = null;
    this.replayBuffer = [];
  }

  private requireActive(): void {
    if (!this.active) {
      throw this.failedError ?? new Error('player is not open');
    }
  }

  private asDecoderError(err: unknown, phase: FailurePhase): DecoderError {
    if (err instanceof DecoderError) return err;
    return new DecoderError(err instanceof Error ? err.message : String(err), {
      phase,
      backendKind: this.active?.kind ?? 'hardware',
      cause: err,
    });
  }

  private async discardActive(): Promise<void> {
    const doomed = this.active;
    this.active = null;
    if (!doomed) return;
    try {
      await doomed.release();
    } catch {
      // A dying backend must not block the fallback path.
    }
  }

  /** Conditions: non-fatal error, budget left, software accepts the codec. */
  private async maybeFallback(error: DecoderError): Promise<boolean> {
    if (error.fatal || this.fallbacksUsed >= this.maxFallbacks || !this.config) {
      this.failedError = error;
      return false;
    }
    const from = error.backendKind;
    const next: BackendFactory = from === 'hardware' ? this.swFactory : this.hwFactory;
    try {
      await this.tryOpen(next);
    } catch (err) {
      this.failedError = this.asDecoderError(err, 'open');
      await this.discardActive();
      return false;
    }
    this.fallbacksUsed += 1;
    this.opts.onFallback?.({
      from,
      to: this.active!.kind,
      phase: error.phase,
      error,
      fallbacksUsed: this.fallbacksUsed,
    });
    return true;
  }

  /** Re-feed everything since the last keyframe into the fresh backend. */
  private async replayFromKeyframe(): Promise<DecodedFrame> {
    const backlog = this.replayBuffer;
    this.replayBuffer = [];
    let last: DecodedFrame | null = null;
    for (const packet of backlog) {
      if (packet.isKeyframe) this.replayBuffer = [];
      this.replayBuffer.push(packet);
      last = await this.active!.decode(packet);
      this.opts.onFrame?.(last);
    }
    if (!last) throw new Error('nothing to replay after fallback');
    return last;
  }
}
