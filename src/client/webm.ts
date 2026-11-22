// Minimal EBML/WebM muxer for a single video track (VP8/VP9/AV1).
// Produces a seekable file from encoded chunks; also exposes an
// init segment + media segment split for MediaSource playback.

type Bytes = Uint8Array;

function concat(parts: Bytes[]): Bytes {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function vint(value: number): Bytes {
  // EBML variable-length integer (size descriptor included)
  for (let len = 1; len <= 8; len++) {
    const max = 2 ** (7 * len) - 2; // reserve all-ones as "unknown"
    if (value <= max) {
      const out = new Uint8Array(len);
      for (let i = len - 1; i >= 0; i--) { out[i] = value & 0xff; value >>= 8; }
      out[0] |= 1 << (8 - len);
      return out;
    }
  }
  throw new Error('vint too large');
}

function id(code: number): Bytes {
  const out: number[] = [];
  let v = code;
  while (v > 0) { out.unshift(v & 0xff); v >>= 8; }
  return new Uint8Array(out);
}

function el(code: number, data: Bytes): Bytes {
  return concat([id(code), vint(data.length), data]);
}

function uintEl(code: number, value: number, bytes = 0): Bytes {
  const needed = Math.max(bytes, Math.max(1, Math.ceil((Math.floor(Math.log2(value || 1)) + 1) / 8)));
  const out = new Uint8Array(needed);
  for (let i = needed - 1; i >= 0; i--) { out[i] = value & 0xff; value = Math.floor(value / 256); }
  return el(code, out);
}

function strEl(code: number, s: string): Bytes {
  return el(code, new TextEncoder().encode(s));
}

function floatEl(code: number, value: number): Bytes {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value);
  return el(code, new Uint8Array(buf));
}

export interface MuxerConfig {
  width: number;
  height: number;
  codecId: 'V_VP9' | 'V_VP8' | 'V_AV1';
}

interface Frame {
  data: Bytes;
  timeMs: number;
  keyframe: boolean;
}

export class WebmMuxer {
  private cfg: MuxerConfig;
  private frames: Frame[] = [];

  constructor(cfg: MuxerConfig) {
    this.cfg = cfg;
  }

  addFrame(data: Bytes, timeMs: number, keyframe: boolean): void {
    this.frames.push({ data: new Uint8Array(data), timeMs, keyframe });
  }

  private header(): Bytes {
    return el(0x1a45dfa3, concat([
      uintEl(0x4286, 1), uintEl(0x42f7, 1), uintEl(0x42f2, 4), uintEl(0x42f3, 8),
      strEl(0x4282, 'webm'), uintEl(0x4287, 4), uintEl(0x4285, 2),
    ]));
  }

  private tracks(): Bytes {
    const video = el(0xe0, concat([
      uintEl(0xb0, this.cfg.width),
      uintEl(0xb9, this.cfg.height),
    ]));
    return el(0x1654ae6b, el(0xae, concat([
      uintEl(0xd7, 1),           // TrackNumber
      uintEl(0x73c5, 1),         // TrackUID
      uintEl(0x83, 1),           // TrackType = video
      uintEl(0x9c, 0),           // FlagLacing = none
      strEl(0x86, this.cfg.codecId),
      strEl(0x22b59c, 'und'),    // Language
      video,
    ])));
  }

  private info(withDuration: boolean): Bytes {
    const parts: Bytes[] = [
      uintEl(0x2ad7b1, 1_000_000), // TimecodeScale: 1ms
      strEl(0x4d80, 'timelapse-studio'),
      strEl(0x5741, 'timelapse-studio'),
    ];
    if (withDuration && this.frames.length) {
      const last = this.frames[this.frames.length - 1];
      parts.push(floatEl(0x4489, last.timeMs + 1));
    }
    return el(0x1549a966, concat(parts));
  }

  private simpleBlock(f: Frame): Bytes {
    const head = new Uint8Array(4);
    head[0] = 0x81; // track 1
    new DataView(head.buffer).setInt16(1, Math.round(f.timeMs), false);
    head[3] = f.keyframe ? 0x80 : 0x00;
    return el(0xa3, concat([head, f.data]));
  }

  private cluster(): Bytes {
    const blocks = this.frames.map((f) => this.simpleBlock(f));
    return el(0x1f43b675, concat([uintEl(0xe7, 0), ...blocks]));
  }

  // Init segment suitable for MediaSource (segment size unknown).
  initSegment(): Bytes {
    const segBody = concat([this.info(false), this.tracks()]);
    const segment = concat([id(0x18538067), new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), segBody]);
    return concat([this.header(), segment]);
  }

  // Media segment (one cluster with every frame).
  mediaSegment(): Bytes {
    return this.cluster();
  }

  // Complete standalone file with sizes patched in.
  finalize(): Bytes {
    const body = concat([this.info(true), this.tracks(), this.cluster()]);
    return concat([this.header(), el(0x18538067, body)]);
  }
}
