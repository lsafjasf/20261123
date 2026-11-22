// 极简 EBML / Matroska / WebM 解封装器，零依赖。
// 输出带时间戳的编码块（供 VideoDecoder/AudioDecoder）以及 CodecPrivate（供 MSE SourceBuffer）。

export interface EncodedPacket {
  track: number;
  timestampUs: number;
  keyframe: boolean;
  data: Uint8Array;
}

export interface WebMTrack {
  number: number;
  type: "video" | "audio";
  codecId: string;
  codecPrivate: Uint8Array | null;
}

export interface DemuxResult {
  tracks: WebMTrack[];
  packets: EncodedPacket[];
  durationMs: number;
}

const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMESCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  CLUSTER: 0x1f43b675,
  TIMESTAMP: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1
} as const;

interface ElementHeader {
  id: number;
  headerSize: number;
  size: number;
}

function readVint(view: DataView, offset: number, keepLengthBit = false): { value: number; length: number } {
  const first = view.getUint8(offset);
  // VINT 长度 = 首字节前导零个数 + 1，与数据位无关。
  let length = 1;
  while (length <= 8 && (first & (0x80 >>> (length - 1))) === 0) {
    length += 1;
  }
  // 元素 ID 的前导长度位属于 ID 本身（keepLengthBit=true）；普通 VINT（size、轨道号）剥掉长度位。
  let value = keepLengthBit ? first : first & (0xff >>> length);
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + view.getUint8(offset + index);
  }
  return { value, length };
}

function readElement(view: DataView, offset: number): ElementHeader | null {
  if (offset >= view.byteLength) return null;
  const idPart = readVint(view, offset, true);
  const sizePart = readVint(view, offset + idPart.length);
  return {
    id: idPart.value,
    headerSize: idPart.length + sizePart.length,
    size: sizePart.value
  };
}

function findChildren(view: DataView, start: number, end: number, wanted: Set<number>) {
  const found: { id: number; start: number; size: number }[] = [];
  let offset = start;
  while (offset < end) {
    const header = readElement(view, offset);
    if (!header || header.size === 0) break;
    if (wanted.has(header.id)) {
      found.push({ id: header.id, start: offset + header.headerSize, size: header.size });
    }
    offset += header.headerSize + header.size;
  }
  return found;
}

function readFloat(view: DataView, offset: number, size: number): number {
  return size === 4 ? view.getFloat32(offset, false) : view.getFloat64(offset, false);
}

export function demuxWebm(buffer: ArrayBuffer): DemuxResult {
  const view = new DataView(buffer);
  const tracks = new Map<number, WebMTrack>();
  const packets: EncodedPacket[] = [];
  let timecodeScale = 1_000_000;
  let durationUs = 0;

  if (buffer.byteLength === 0) {
    return { tracks: [], packets: [], durationMs: 0 };
  }

  let offset = 0;
  while (offset < view.byteLength) {
    const header = readElement(view, offset);
    if (!header) break;
    const bodyStart = offset + header.headerSize;
    const bodyEnd = bodyStart + header.size;

    if (header.id === ID.SEGMENT) {
      let cursor = bodyStart;
      while (cursor < bodyEnd) {
        const child = readElement(view, cursor);
        if (!child) break;
        const childStart = cursor + child.headerSize;
        const childEnd = childStart + child.size;

        if (child.id === ID.INFO) {
          for (const info of findChildren(view, childStart, childEnd, new Set([ID.TIMESCALE, ID.DURATION]))) {
            if (info.id === ID.TIMESCALE) timecodeScale = view.getUint32(info.start);
            if (info.id === ID.DURATION) {
              // Duration 以 TimecodeScale 为单位（纳秒刻度），换算为微秒。
              durationUs = (readFloat(view, info.start, info.size) * timecodeScale) / 1000;
            }
          }
        } else if (child.id === ID.TRACKS) {
          for (const entry of findChildren(view, childStart, childEnd, new Set([ID.TRACK_ENTRY]))) {
            let number = 0;
            let type = 0;
            let codecId = "";
            let codecPrivate: Uint8Array | null = null;
            for (const field of findChildren(
              view,
              entry.start,
              entry.start + entry.size,
              new Set([ID.TRACK_NUMBER, ID.TRACK_TYPE, ID.CODEC_ID, ID.CODEC_PRIVATE])
            )) {
              if (field.id === ID.TRACK_NUMBER) number = readVint(view, field.start).value;
              if (field.id === ID.TRACK_TYPE) type = view.getUint8(field.start);
              if (field.id === ID.CODEC_ID) {
                codecId = new TextDecoder().decode(new Uint8Array(buffer, field.start, field.size));
              }
              if (field.id === ID.CODEC_PRIVATE) {
                codecPrivate = new Uint8Array(buffer, field.start, field.size);
              }
            }
            tracks.set(number, {
              number,
              type: type === 1 ? "video" : "audio",
              codecId,
              codecPrivate
            });
          }
        } else if (child.id === ID.CLUSTER) {
          let clusterTime = 0;
          let blockCursor = childStart;
          while (blockCursor < childEnd) {
            const block = readElement(view, blockCursor);
            if (!block) break;
            const blockStart = blockCursor + block.headerSize;
            if (block.id === ID.TIMESTAMP) clusterTime = view.getInt16(blockStart);
            if (block.id === ID.SIMPLE_BLOCK || block.id === ID.BLOCK) {
              const trackVint = readVint(view, blockStart);
              const track = trackVint.value;
              const relativeTime = view.getInt16(blockStart + trackVint.length);
              const flags = view.getUint8(blockStart + trackVint.length + 2);
              const payloadOffset = blockStart + trackVint.length + 3;
              const payload = new Uint8Array(buffer, payloadOffset, block.size - (payloadOffset - blockStart));
              packets.push({
                track,
                timestampUs: (clusterTime + relativeTime) * timecodeScale / 1000,
                keyframe: (flags & 0x80) === 0x80,
                data: payload
              });
            }
            blockCursor += block.headerSize + block.size;
          }
        }
        cursor += child.headerSize + child.size;
      }
      offset = bodyEnd;
    } else {
      offset = bodyEnd;
    }
  }

  return {
    tracks: Array.from(tracks.values()),
    packets,
    durationMs: durationUs / 1000
  };
}

/** 把 WebM codecId 映射为 WebCodecs / MSE 可识别的 codec 字符串。 */
export function webmCodecString(track: WebMTrack): string {
  if (track.codecId === "V_VP9") return "vp09.00.10.08";
  if (track.codecId === "V_VP8") return "vp8";
  if (track.codecId === "V_AV1") return "av01.0.04M.08";
  if (track.codecId.startsWith("A_OPUS")) return "opus";
  if (track.codecId.startsWith("A_VORBIS")) return "vorbis";
  return track.codecId.toLowerCase();
}
