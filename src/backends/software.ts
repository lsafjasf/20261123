import type { DecoderBackend } from '../backend.ts';
import type { CodecConfig, DecodedFrame, EncodedPacket, ProbeResult } from '../types.ts';

const SUPPORTED_CODECS = new Set(['h264', 'h265', 'vp9', 'av1']);

/**
 * Pure-TypeScript software decoder. It is the always-available fallback:
 * probe never lies, open always succeeds for known codecs, and decode is
 * deterministic so tests can assert on output.
 */
export class SoftwareDecoderBackend implements DecoderBackend {
  readonly kind = 'software' as const;
  private config: CodecConfig | null = null;
  private opened = false;

  async probe(config: CodecConfig): Promise<ProbeResult> {
    if (!SUPPORTED_CODECS.has(config.codec)) {
      return { supported: false, reason: `software decoder has no ${config.codec} support` };
    }
    return { supported: true };
  }

  async open(config: CodecConfig): Promise<void> {
    const probe = await this.probe(config);
    if (!probe.supported) throw new Error(probe.reason);
    this.config = config;
    this.opened = true;
  }

  async decode(packet: EncodedPacket): Promise<DecodedFrame> {
    if (!this.opened || !this.config) throw new Error('decoder not open');
    if (packet.data.byteLength === 0) throw new Error('empty packet');
    // Deterministic stand-in for real pixel decoding: a frame-sized buffer
    // seeded from the packet so tests can verify data flows through.
    const pixels = new Uint8Array(this.config.width * this.config.height * 4);
    for (let i = 0; i < packet.data.byteLength; i += 1) {
      pixels[i % pixels.byteLength] ^= packet.data[i];
    }
    return {
      timestamp: packet.timestamp,
      duration: packet.duration,
      width: this.config.width,
      height: this.config.height,
      source: 'software',
      data: pixels,
    };
  }

  async pause(): Promise<void> {}

  async resume(): Promise<void> {}

  async reset(): Promise<void> {
    if (!this.opened) throw new Error('decoder not open');
  }

  async release(): Promise<void> {
    this.opened = false;
    this.config = null;
  }
}
