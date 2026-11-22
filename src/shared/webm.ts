// 极简 WebM(EBML) 封装器：纯字节操作，Node 与浏览器通用，零依赖。
// 仅支持单视频轨（VP8/VP9），用于把 WebCodecs VideoEncoder 的输出封装成可播放文件。

export interface EncodedChunkLike {
  type: 'key' | 'delta';
  timestamp: number; // 微秒
  duration?: number | null;
  data: Uint8Array;
}

const IDs = {
  EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2, EBMLMaxSizeLength: 0x42f3, DocType: 0x4282,
  DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1,
  MuxingApp: 0x4d80, WritingApp: 0x5741, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5,
  TrackType: 0x83, CodecID: 0x86, FlagLacing: 0x9c, Video: 0xe0,
  PixelWidth: 0xb0, PixelHeight: 0xba,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3,
};

function u8(v: number): Uint8Array { return new Uint8Array([v & 0xff]); }

function uintBytes(v: number, len?: number): Uint8Array {
  // 选最小可表示长度（EBML 无符号整数）
  let n = len ?? 1;
  if (len === undefined) {
    while (n < 8 && v >= 2 ** (n * 8)) n++;
  }
  const out = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
  return out;
}

function idBytes(id: number): Uint8Array {
  if (id > 0xffffff) return uintBytes(id, 4);
  if (id > 0xffff) return uintBytes(id, 3);
  if (id > 0xff) return uintBytes(id, 2);
  return u8(id);
}

/** EBML 变长尺寸；len 缺省自动选择 */
function sizeBytes(v: number, len?: number): Uint8Array {
  let n = len ?? 1;
  if (len === undefined) {
    while (n < 8 && v >= 2 ** (7 * n) - 1) n++;
  }
  const out = uintBytes(v, n);
  out[0] |= 1 << (8 - n);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function elem(id: number, payload: Uint8Array): Uint8Array {
  return concat([idBytes(id), sizeBytes(payload.length), payload]);
}

function uintElem(id: number, v: number): Uint8Array { return elem(id, uintBytes(v)); }

function strElem(id: number, s: string): Uint8Array {
  return elem(id, new TextEncoder().encode(s));
}

function floatElem(id: number, v: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, v);
  return elem(id, buf);
}

function header(): Uint8Array {
  return elem(IDs.EBML, concat([
    uintElem(IDs.EBMLVersion, 1), uintElem(IDs.EBMLReadVersion, 1),
    uintElem(IDs.EBMLMaxIDLength, 4), uintElem(IDs.EBMLMaxSizeLength, 8),
    strElem(IDs.DocType, 'webm'), uintElem(IDs.DocTypeVersion, 4),
    uintElem(IDs.DocTypeReadVersion, 2),
  ]));
}

function info(durationMs: number): Uint8Array {
  return elem(IDs.Info, concat([
    uintElem(IDs.TimecodeScale, 1000000), // 1 tick = 1ms
    strElem(IDs.MuxingApp, 'pad-video-sync'),
    strElem(IDs.WritingApp, 'pad-video-sync'),
    floatElem(IDs.Duration, durationMs),
  ]));
}

function tracks(codec: 'V_VP8' | 'V_VP9', width: number, height: number): Uint8Array {
  return elem(IDs.Tracks, elem(IDs.TrackEntry, concat([
    uintElem(IDs.TrackNumber, 1), uintElem(IDs.TrackUID, 1),
    uintElem(IDs.TrackType, 1), uintElem(IDs.FlagLacing, 0),
    strElem(IDs.CodecID, codec),
    elem(IDs.Video, concat([uintElem(IDs.PixelWidth, width), uintElem(IDs.PixelHeight, height)])),
  ])));
}

function simpleBlock(chunk: EncodedChunkLike, clusterStartMs: number): Uint8Array {
  const relMs = Math.round(chunk.timestamp / 1000) - clusterStartMs;
  const track = new Uint8Array([0x81]); // track 1, vint
  const tc = new Uint8Array(2);
  new DataView(tc.buffer).setInt16(0, relMs);
  const flags = u8(chunk.type === 'key' ? 0x80 : 0x00);
  return elem(IDs.SimpleBlock, concat([track, tc, flags, chunk.data]));
}

/**
 * 把编码块封装为完整 WebM 文件。
 * 每遇到一个关键帧（首块除外）且距上一簇 >= clusterMs 时开新簇。
 */
export function muxWebM(
  chunks: EncodedChunkLike[],
  opts: { codec: 'V_VP8' | 'V_VP9'; width: number; height: number; clusterMs?: number },
): Uint8Array {
  if (chunks.length === 0) throw new Error('没有可封装的数据块');
  if (chunks[0].type !== 'key') throw new Error('首块必须是关键帧');
  const clusterMs = opts.clusterMs ?? 4000;
  const startMs = Math.round(chunks[0].timestamp / 1000);
  const endMs = Math.round((chunks[chunks.length - 1].timestamp + (chunks[chunks.length - 1].duration ?? 0)) / 1000);

  const clusters: Uint8Array[] = [];
  let cur: Uint8Array[] = [];
  let curStart = startMs;
  const flush = () => {
    if (cur.length === 0) return;
    clusters.push(elem(IDs.Cluster, concat([uintElem(IDs.Timecode, curStart), ...cur])));
    cur = [];
  };
  for (const c of chunks) {
    const tMs = Math.round(c.timestamp / 1000);
    if (cur.length > 0 && c.type === 'key' && tMs - curStart >= clusterMs) {
      flush();
      curStart = tMs;
    }
    cur.push(simpleBlock(c, curStart));
  }
  flush();

  const body = concat([
    info(Math.max(1, endMs - startMs)),
    tracks(opts.codec, opts.width, opts.height),
    ...clusters,
  ]);
  // Segment 尺寸已知（一次性封装），便于普通播放器解析
  return concat([header(), idBytes(IDs.Segment), sizeBytes(body.length), body]);
}
