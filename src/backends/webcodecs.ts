import type { DecoderBackend } from '../backend.ts';
import type { CodecConfig, DecodedFrame, EncodedPacket, ProbeResult } from '../types.ts';

const CODEC_STRINGS: Record<string, string> = {
  h264: 'avc1.640028',
  h265: 'hev1.1.6.L120.90',
  vp9: 'vp09.00.40.08',
  av1: 'av01.0.08M.08',
};

interface VideoDecoderLike {
  configure(config: Record<string, unknown>): void;
  decode(chunk: unknown): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

interface WebCodecsGlobal {
  VideoDecoder: {
    isConfigSupported(config: Record<string, unknown>): Promise<{ supported?: boolean }>;
    new (init: Record<string, unknown>): VideoDecoderLike;
  };
  EncodedVideoChunk: new (init: Record<string, unknown>) => unknown;
}

function webcodecs(): WebCodecsGlobal | null {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.VideoDecoder === 'function' && typeof g.EncodedVideoChunk === 'function') {
    return g as unknown as WebCodecsGlobal;
  }
  return null;
}

/**
 * Hardware decode via WebCodecs. In browsers without H.265 support (or
 * without WebCodecs at all, e.g. Node) probe reports unsupported, so the
 * player falls back before any decoder is opened.
 */
export class WebCodecsHardwareBackend implements DecoderBackend {
  readonly kind = 'hardware' as const;
  private decoder: VideoDecoderLike | null = null;
  private config: CodecConfig | null = null;
  private pending: Array<{
    resolve: (frame: DecodedFrame) => void;
    reject: (err: unknown) => void;
  }> = [];

  async probe(config: CodecConfig): Promise<ProbeResult> {
    const wc = webcodecs();
    if (!wc) return { supported: false, reason: 'WebCodecs unavailable' };
    const support = await wc.VideoDecoder.isConfigSupported({
      codec: CODEC_STRINGS[config.codec],
      codedWidth: config.width,
      codedHeight: config.height,
      hardwareAcceleration: 'prefer-hardware',
    });
    return support.supported
      ? { supported: true }
      : { supported: false, reason: `no hardware decoder for ${config.codec}` };
  }

  async open(config: CodecConfig): Promise<void> {
    const wc = webcodecs();
    if (!wc) throw new Error('WebCodecs unavailable');
    this.config = config;
    this.decoder = new wc.VideoDecoder({
      output: (frame: { timestamp: number; duration?: number | null; close(): void }) => {
        const waiter = this.pending.shift();
        frame.close();
        waiter?.resolve({
          timestamp: frame.timestamp,
          duration: frame.duration ?? 0,
          width: config.width,
          height: config.height,
          source: 'hardware',
          data: new Uint8Array(0),
        });
      },
      error: (err: unknown) => {
        const waiter = this.pending.shift();
        waiter?.reject(err);
      },
    });
    this.decoder.configure({
      codec: CODEC_STRINGS[config.codec],
      codedWidth: config.width,
      codedHeight: config.height,
      hardwareAcceleration: 'prefer-hardware',
    });
  }

  async decode(packet: EncodedPacket): Promise<DecodedFrame> {
    const wc = webcodecs();
    if (!wc || !this.decoder) throw new Error('decoder not open');
    const frame = new Promise<DecodedFrame>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
    this.decoder.decode(
      new wc.EncodedVideoChunk({
        type: packet.isKeyframe ? 'key' : 'delta',
        timestamp: packet.timestamp,
        duration: packet.duration,
        data: packet.data,
      }),
    );
    return frame;
  }

  async pause(): Promise<void> {}

  async resume(): Promise<void> {}

  async reset(): Promise<void> {
    this.decoder?.reset();
    if (this.config) {
      this.decoder?.configure({
        codec: CODEC_STRINGS[this.config.codec],
        codedWidth: this.config.width,
        codedHeight: this.config.height,
        hardwareAcceleration: 'prefer-hardware',
      });
    }
  }

  async release(): Promise<void> {
    try {
      this.decoder?.close();
    } catch {
      // close() throws if already closed; release must stay idempotent.
    }
    this.decoder = null;
    this.pending = [];
  }
}
