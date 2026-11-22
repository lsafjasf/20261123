/**
 * Minimal WebM (EBML) muxer for a single VP8/VP9 video track.
 * Input: encoded chunks from WebCodecs VideoEncoder. One cluster.
 */
export interface MuxChunk {
  data: Uint8Array;
  timestampMs: number;
  keyframe: boolean;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function vint(n: number): Uint8Array {
  let len = 1;
  while (n >= 2 ** (7 * len) - 1) len++;
  const out = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 1; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
  out[0] = v | (1 << (8 - len));
  return out;
}

function elem(id: number[], payload: Uint8Array): Uint8Array {
  return concat([Uint8Array.from(id), vint(payload.length), payload]);
}

function uintElem(id: number[], value: number, bytes = 0): Uint8Array {
  let len = bytes;
  if (!len) {
    len = 1;
    while (value >= 2 ** (8 * len)) len++;
  }
  const out = new Uint8Array(len);
  let v = value;
  for (let i = len - 1; i >= 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
  return elem(id, out);
}

function strElem(id: number[], s: string): Uint8Array {
  return elem(id, new TextEncoder().encode(s));
}

function floatElem(id: number[], value: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, value);
  return elem(id, buf);
}

export function muxWebM(
  chunks: MuxChunk[],
  opts: { width: number; height: number; codecId: string; durationMs: number },
): Uint8Array {
  const header = elem([0x1a, 0x45, 0xdf, 0xa3], concat([
    uintElem([0x42, 0x86], 1),
    uintElem([0x42, 0xf7], 1),
    uintElem([0x42, 0xf2], 4),
    uintElem([0x42, 0xf3], 8),
    strElem([0x42, 0x82], "webm"),
    uintElem([0x42, 0x87], 4),
    uintElem([0x42, 0x85], 2),
  ]));

  const info = elem([0x15, 0x49, 0xa9, 0x66], concat([
    uintElem([0x2a, 0xd7, 0xb1], 1_000_000), // 1 ms ticks
    strElem([0x4d, 0x80], "frame-safe"),
    strElem([0x57, 0x41], "frame-safe webm muxer"),
    floatElem([0x44, 0x89], opts.durationMs),
  ]));

  const video = elem([0xe0], concat([
    uintElem([0xb0], opts.width),
    uintElem([0xba], opts.height),
  ]));
  const trackEntry = elem([0xae], concat([
    uintElem([0xd7], 1),
    uintElem([0x73, 0xc5], 1),
    uintElem([0x83], 1), // video
    strElem([0x86], opts.codecId),
    video,
  ]));
  const tracks = elem([0x16, 0x54, 0xae, 0x6b], trackEntry);

  const blocks: Uint8Array[] = [uintElem([0xe7], 0)];
  for (const c of chunks) {
    const tc = Math.round(c.timestampMs);
    if (tc > 32767) throw new Error("segment too long for a single cluster");
    const head = new Uint8Array(4);
    head[0] = 0x81; // track 1
    new DataView(head.buffer).setInt16(1, tc);
    head[3] = c.keyframe ? 0x80 : 0x00;
    blocks.push(elem([0xa3], concat([head, c.data])));
  }
  const cluster = elem([0x1f, 0x43, 0xb6, 0x75], concat(blocks));

  const segment = elem([0x18, 0x53, 0x80, 0x67], concat([info, tracks, cluster]));
  return concat([header, segment]);
}
