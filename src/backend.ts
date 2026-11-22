import type { CodecConfig, DecodedFrame, EncodedPacket, ProbeResult } from './types.ts';

/**
 * A decoder backend implements the primitives; DecoderLifecycle owns the
 * state machine and calls these only from valid states.
 */
export interface DecoderBackend {
  readonly kind: 'hardware' | 'software';
  probe(config: CodecConfig): Promise<ProbeResult>;
  open(config: CodecConfig): Promise<void>;
  decode(packet: EncodedPacket): Promise<DecodedFrame>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  reset(): Promise<void>;
  release(): Promise<void>;
}

export type BackendFactory = () => DecoderBackend;
