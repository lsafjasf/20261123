// Minimal WebM (EBML) muxer for a single Opus audio track. No dependencies.

function vint(len: number): number[] {
  // EBML variable-length integer for sizes
  if (len < 127) return [0x80 | len];
  if (len < 16383) return [0x40 | (len >> 8), len & 0xff];
  if (len < 2097151) return [0x20 | (len >> 16), (len >> 8) & 0xff, len & 0xff];
  return [0x10 | (len >> 24), (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff];
}

function el(id: number[], data: Uint8Array): Uint8Array {
  const size = vint(data.length);
  const out = new Uint8Array(id.length + size.length + data.length);
  out.set(id, 0);
  out.set(size, id.length);
  out.set(data, id.length + size.length);
  return out;
}

function u8(...vals: number[]): Uint8Array {
  return Uint8Array.from(vals);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function str(s: string): Uint8Array {
  return Uint8Array.from(Array.from(s).map((c) => c.charCodeAt(0)));
}

export interface OpusPacket {
  data: Uint8Array;
  timestampMs: number;
}

// Build a complete WebM file: one audio track, one cluster per call.
export function muxOpusWebm(
  packets: OpusPacket[],
  sampleRate: number,
  channels: number,
  codecPrivate: Uint8Array,
): Uint8Array {
  const header = el([0x1a, 0x45, 0xdf, 0xa3], concat([
    el([0x42, 0x86], u8(1)),
    el([0x42, 0xf7], u8(1)),
    el([0x42, 0xf2], u8(4)),
    el([0x42, 0xf3], u8(8)),
    el([0x42, 0x82], str("webm")),
    el([0x42, 0x87], u8(4)),
    el([0x42, 0x85], u8(2)),
  ]));

  const sr = new Uint8Array(4);
  new DataView(sr.buffer).setFloat32(0, sampleRate, false);
  const trackEntry = el([0xae], concat([
    el([0xd7], u8(1)), // track number
    el([0x73, 0xc5], u8(1)), // track uid
    el([0x83], u8(1)), // type: audio
    el([0x86], str("A_OPUS")),
    el([0x63, 0xa2], codecPrivate), // CodecPrivate: OpusHead
    el([0xe1], concat([ // Audio
      el([0xb5], sr), // SamplingFrequency (float)
      el([0x9f], u8(channels)),
    ])),
  ]));
  const tracks = el([0x16, 0x54, 0xae, 0x6b], trackEntry);

  const blocks = packets.map((p) => {
    const tc = Math.round(p.timestampMs);
    const block = new Uint8Array(4 + p.data.length);
    block[0] = 0x81; // track 1 (vint)
    block[1] = (tc >> 8) & 0xff;
    block[2] = tc & 0xff;
    block[3] = 0; // flags
    block.set(p.data, 4);
    return el([0xa3], block); // SimpleBlock
  });
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], concat([
    el([0xe7], u8(0)), // Timecode
    ...blocks,
  ]));

  // Segment with unknown size so it can also be streamed.
  const segBody = concat([tracks, cluster]);
  const segment = concat([
    u8(0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
    segBody,
  ]);
  return concat([header, segment]);
}
