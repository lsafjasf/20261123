import type { DecoderBackend } from '../backend.ts';
import type { CodecConfig, DecodedFrame, EncodedPacket, ProbeResult } from '../types.ts';

export interface SimulatedScript {
  /** What probe() reports. Defaults to supported. */
  probeResult?: ProbeResult;
  /** If set, open() rejects with this error. */
  openError?: Error;
  /** If set, decode() throws after this many successful frames. */
  failDecodeAfter?: number;
  /** Error thrown by decode() once failDecodeAfter is reached. */
  decodeError?: Error;
}

/**
 * Scripted backend for tests and offline development. Covers the two nasty
 * real-world cases: a driver that declares support but cannot open, and a
 * decoder that dies mid-stream.
 */
export class SimulatedBackend implements DecoderBackend {
  readonly kind: 'hardware' | 'software';
  readonly calls: string[] = [];
  private script: SimulatedScript;
  private decoded = 0;

  constructor(kind: 'hardware' | 'software', script: SimulatedScript = {}) {
    this.kind = kind;
    this.script = script;
  }

  async probe(_config: CodecConfig): Promise<ProbeResult> {
    this.calls.push('probe');
    return this.script.probeResult ?? { supported: true };
  }

  async open(_config: CodecConfig): Promise<void> {
    this.calls.push('open');
    if (this.script.openError) throw this.script.openError;
  }

  async decode(packet: EncodedPacket): Promise<DecodedFrame> {
    this.calls.push('decode');
    if (
      this.script.failDecodeAfter !== undefined &&
      this.decoded >= this.script.failDecodeAfter
    ) {
      throw this.script.decodeError ?? new Error('simulated decode failure');
    }
    this.decoded += 1;
    return {
      timestamp: packet.timestamp,
      duration: packet.duration,
      width: 2,
      height: 2,
      source: this.kind,
      data: new Uint8Array(packet.data),
    };
  }

  async pause(): Promise<void> {
    this.calls.push('pause');
  }

  async resume(): Promise<void> {
    this.calls.push('resume');
  }

  async reset(): Promise<void> {
    this.calls.push('reset');
    this.decoded = 0;
  }

  async release(): Promise<void> {
    this.calls.push('release');
  }
}

/** Declares support in probe, but open() always fails (broken driver). */
export function declaresSupportButCannotOpen(): SimulatedBackend {
  return new SimulatedBackend('hardware', {
    probeResult: { supported: true },
    openError: new Error('driver rejected decoder instance'),
  });
}

/** Opens fine, decodes `framesBeforeError` packets, then dies mid-stream. */
export function midStreamFailure(framesBeforeError: number): SimulatedBackend {
  return new SimulatedBackend('hardware', {
    failDecodeAfter: framesBeforeError,
    decodeError: new Error('hardware decoder hung'),
  });
}
