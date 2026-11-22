/** Shared types for the decoder lifecycle. */

export type CodecId = 'h264' | 'h265' | 'vp9' | 'av1';

export interface CodecConfig {
  codec: CodecId;
  width: number;
  height: number;
  /** Optional codec-specific description (e.g. hvcC / avcC box). */
  description?: Uint8Array;
  /** Hint that the caller prefers hardware acceleration. */
  preferHardware?: boolean;
}

export interface EncodedPacket {
  data: Uint8Array;
  /** Presentation timestamp in microseconds. */
  timestamp: number;
  /** Duration in microseconds. */
  duration: number;
  isKeyframe: boolean;
}

export interface DecodedFrame {
  timestamp: number;
  duration: number;
  width: number;
  height: number;
  /** Which backend produced this frame. */
  source: 'hardware' | 'software';
  /** Raw frame payload (backend-defined pixel format). */
  data: Uint8Array;
}

export interface ProbeResult {
  supported: boolean;
  /** Why the codec is not supported, when known. */
  reason?: string;
}

/** Unified lifecycle states shared by hardware and software decoders. */
export type DecoderState =
  | 'idle'
  | 'probing'
  | 'opening'
  | 'ready'
  | 'decoding'
  | 'paused'
  | 'resetting'
  | 'releasing'
  | 'released'
  | 'failed';

/** Where in the lifecycle an error surfaced; drives fallback policy. */
export type FailurePhase = 'probe' | 'open' | 'first-frame' | 'mid-stream';

export class DecoderError extends Error {
  readonly phase: FailurePhase;
  readonly backendKind: 'hardware' | 'software';
  /** Errors that must not trigger a fallback (e.g. caller sent a bad packet). */
  readonly fatal: boolean;

  constructor(
    message: string,
    opts: {
      phase: FailurePhase;
      backendKind: 'hardware' | 'software';
      fatal?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: opts.cause });
    this.name = 'DecoderError';
    this.phase = opts.phase;
    this.backendKind = opts.backendKind;
    this.fatal = opts.fatal ?? false;
  }
}
