// Minimal streaming WebM muxer (EBML) for WebCodecs output.
// Uses unknown-size Segment/Cluster elements, the same trick
// MediaRecorder uses, so MediaSource accepts it incrementally.

type Bytes = Uint8Array;

function concat(parts: Bytes[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function vint(value: number): Bytes {
  // EBML variable-length integer for element sizes (known values).
  for (let len = 1; len <= 8; len++) {
    const max = 2 ** (7 * len) - 2; // reserve all-ones as "unknown"
    if (value <= max) {
      const out = new Uint8Array(len);
      for (let i = len - 1; i >= 0; i--) {
        out[i] = value & 0xff;
        value >>= 8;
      }
      out[0] |= 1 << (8 - len);
      return out;
    }
  }
  throw new RangeError('vint too large');
}

function elem(id: Bytes, data: Bytes): Bytes {
  return concat([id, vint(data.length), data]);
}

function elemUnknownSize(id: Bytes, data: Bytes): Bytes {
  return concat([id, new Uint8Array([0xff]), data]); // 1-byte all-ones = unknown
}

function uint(value: number, bytes: number): Bytes {
  const out = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return out;
}

function str(s: string): Bytes {
  return new TextEncoder().encode(s);
}

const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  EBMLVersion: [0x42, 0x86],
  EBMLReadVersion: [0x42, 0xf7],
  EBMLMaxIDLength: [0x42, 0xf2],
  EBMLMaxSizeLength: [0x42, 0xf3],
  DocType: [0x42, 0x82],
  DocTypeVersion: [0x42, 0x87],
  DocTypeReadVersion: [0x42, 0x85],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimestampScale: [0x2a, 0xd7, 0xb1],
  MuxingApp: [0x4d, 0x80],
  WritingApp: [0x57, 0x41],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  TrackUID: [0x73, 0xc5],
  TrackType: [0x83],
  CodecID: [0x86],
  Video: [0xe0],
  PixelWidth: [0xb0],
  PixelHeight: [0xba],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Timestamp: [0xe7],
  SimpleBlock: [0xa3],
} as const;

const bytes = (id: readonly number[]) => new Uint8Array(id);

export class WebmMuxer {
  private header: Bytes;
  private clusterOpen = false;
  private clusterStartMs = 0;

  constructor(width: number, height: number, codecId: 'V_VP9' | 'V_VP8') {
    const ebml = elem(bytes(ID.EBML), concat([
      elem(bytes(ID.EBMLVersion), uint(1, 1)),
      elem(bytes(ID.EBMLReadVersion), uint(1, 1)),
      elem(bytes(ID.EBMLMaxIDLength), uint(4, 1)),
      elem(bytes(ID.EBMLMaxSizeLength), uint(8, 1)),
      elem(bytes(ID.DocType), str('webm')),
      elem(bytes(ID.DocTypeVersion), uint(4, 1)),
      elem(bytes(ID.DocTypeReadVersion), uint(2, 1)),
    ]));
    const info = elem(bytes(ID.Info), concat([
      elem(bytes(ID.TimestampScale), uint(1_000_000, 3)), // 1 ms
      elem(bytes(ID.MuxingApp), str('foley-frame-sync')),
      elem(bytes(ID.WritingApp), str('foley-frame-sync')),
    ]));
    const tracks = elem(bytes(ID.Tracks), elem(bytes(ID.TrackEntry), concat([
      elem(bytes(ID.TrackNumber), uint(1, 1)),
      elem(bytes(ID.TrackUID), uint(1, 4)),
      elem(bytes(ID.TrackType), uint(1, 1)), // 1 = video
      elem(bytes(ID.CodecID), str(codecId)),
      elem(bytes(ID.Video), concat([
        elem(bytes(ID.PixelWidth), uint(width, 2)),
        elem(bytes(ID.PixelHeight), uint(height, 2)),
      ])),
    ])));
    // EBML header is a sibling of Segment, not a child.
    this.header = concat([ebml, elemUnknownSize(bytes(ID.Segment), concat([info, tracks]))]);
  }

  /** Segment header + track info; append this to the SourceBuffer first. */
  initialSegment(): Bytes {
    return this.header;
  }

  private openCluster(timestampMs: number): Bytes {
    this.clusterOpen = true;
    this.clusterStartMs = timestampMs;
    return elemUnknownSize(bytes(ID.Cluster), elem(bytes(ID.Timestamp), uint(timestampMs, 4)));
  }

  /** One encoded video frame. Starts a new cluster on keyframes. */
  addFrame(data: Bytes, timestampMs: number, keyframe: boolean): Bytes {
    const parts: Bytes[] = [];
    if (!this.clusterOpen || keyframe || timestampMs - this.clusterStartMs > 30_000) {
      parts.push(this.openCluster(timestampMs));
    }
    const rel = Math.round(timestampMs - this.clusterStartMs);
    const block = concat([
      new Uint8Array([0x81]), // track 1, vint-encoded
      new Uint8Array([(rel >> 8) & 0xff, rel & 0xff]), // int16 relative timestamp
      new Uint8Array([keyframe ? 0x80 : 0x00]),
      data,
    ]);
    parts.push(elem(bytes(ID.SimpleBlock), block));
    return concat(parts);
  }
}
