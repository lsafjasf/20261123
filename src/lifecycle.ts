import type { DecoderBackend } from './backend.ts';
import {
  DecoderError,
  type CodecConfig,
  type DecodedFrame,
  type DecoderState,
  type EncodedPacket,
  type FailurePhase,
  type ProbeResult,
} from './types.ts';

/**
 * Legal transitions of the unified decoder lifecycle. The same table drives
 * hardware and software backends, so probe/open/feed/pause/reset/release all
 * behave identically regardless of what sits underneath.
 */
const TRANSITIONS: Record<DecoderState, readonly DecoderState[]> = {
  idle: ['probing', 'releasing'],
  probing: ['opening', 'failed', 'releasing'],
  opening: ['ready', 'failed', 'releasing'],
  ready: ['decoding', 'resetting', 'paused', 'releasing'],
  decoding: ['paused', 'resetting', 'failed', 'releasing'],
  paused: ['decoding', 'resetting', 'releasing'],
  resetting: ['ready', 'failed', 'releasing'],
  releasing: ['released'],
  released: [],
  failed: ['resetting', 'releasing'],
};

export interface StateChange {
  from: DecoderState;
  to: DecoderState;
  backendKind: 'hardware' | 'software';
}

export class DecoderLifecycle {
  readonly backend: DecoderBackend;
  private current: DecoderState = 'idle';
  private config: CodecConfig | null = null;
  private framesProduced = 0;
  private listeners: Array<(change: StateChange) => void> = [];

  constructor(backend: DecoderBackend) {
    this.backend = backend;
  }

  get state(): DecoderState {
    return this.current;
  }

  get kind(): 'hardware' | 'software' {
    return this.backend.kind;
  }

  get hasProducedFrames(): boolean {
    return this.framesProduced > 0;
  }

  onStateChange(listener: (change: StateChange) => void): void {
    this.listeners.push(listener);
  }

  private transition(to: DecoderState): void {
    const allowed = TRANSITIONS[this.current];
    if (!allowed.includes(to)) {
      throw new DecoderError(
        `illegal transition ${this.current} -> ${to} (${this.kind} backend)`,
        { phase: 'mid-stream', backendKind: this.kind, fatal: true },
      );
    }
    const from = this.current;
    this.current = to;
    for (const listener of this.listeners) {
      listener({ from, to, backendKind: this.kind });
    }
  }

  private fail(message: string, phase: FailurePhase, cause?: unknown): never {
    if (this.current !== 'failed') {
      const allowed = TRANSITIONS[this.current];
      if (allowed.includes('failed')) this.transition('failed');
    }
    throw new DecoderError(message, { phase, backendKind: this.kind, cause });
  }

  async probe(config: CodecConfig): Promise<ProbeResult> {
    this.transition('probing');
    try {
      const result = await this.backend.probe(config);
      if (!result.supported) {
        this.fail(result.reason ?? 'codec not supported', 'probe');
      }
      return result;
    } catch (err) {
      if (err instanceof DecoderError) throw err;
      this.fail('probe failed', 'probe', err);
    }
  }

  async open(config: CodecConfig): Promise<void> {
    if (this.current === 'idle') {
      // Allow skipping an explicit probe; the backend probes during open.
      this.transition('probing');
    }
    this.transition('opening');
    try {
      await this.backend.open(config);
      this.config = config;
      this.transition('ready');
    } catch (err) {
      this.fail('open failed', 'open', err);
    }
  }

  async decode(packet: EncodedPacket): Promise<DecodedFrame> {
    if (this.current === 'ready' || this.current === 'paused') {
      this.transition('decoding');
    } else if (this.current !== 'decoding') {
      this.transition('decoding'); // throws: illegal transition
    }
    const phase: FailurePhase = this.framesProduced === 0 ? 'first-frame' : 'mid-stream';
    try {
      const frame = await this.backend.decode(packet);
      this.framesProduced += 1;
      return frame;
    } catch (err) {
      this.fail(`decode failed during ${phase}`, phase, err);
    }
  }

  async pause(): Promise<void> {
    this.transition('paused');
    await this.backend.pause();
  }

  async resume(): Promise<void> {
    if (this.current !== 'paused') {
      throw new DecoderError(`cannot resume from ${this.current}`, {
        phase: 'mid-stream',
        backendKind: this.kind,
        fatal: true,
      });
    }
    await this.backend.resume();
    this.transition('decoding');
  }

  /** Reset flushes pending frames and returns the decoder to `ready`. */
  async reset(): Promise<void> {
    this.transition('resetting');
    try {
      await this.backend.reset();
      this.framesProduced = 0;
      this.transition('ready');
    } catch (err) {
      this.fail('reset failed', 'mid-stream', err);
    }
  }

  /** Release is idempotent and reachable from every state. */
  async release(): Promise<void> {
    if (this.current === 'released') return;
    if (this.current !== 'releasing') this.transition('releasing');
    try {
      await this.backend.release();
    } finally {
      this.transition('released');
    }
  }
}
