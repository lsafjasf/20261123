/**
 * 极简 WebM(EBML) 封装器，只覆盖本项目需要的 VP9 + Opus 两条轨道。
 * 输入是 WebCodecs EncodedVideoChunk / EncodedAudioChunk 的字节，
 * 输出可直接喂给 Blob + MediaSource 或下载成 .webm。
 *
 * 参考：Matroska EBML 元素 ID 与 WebM 规范中的固定编号。
 */

export const EBML = {
  Header: 0x1a45dfa3,
  Version: 0x4286,
  ReadVersion: 0x42f7,
  MaxIdLength: 0x42f2,
  MaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUid: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  DefaultDuration: 0x23e383,
  Name: 0x536e,
  CodecId: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
} as const;

/** EBML 元素 ID 编码（按数值有效字节长度，前置 VINT 位）。 */
export function encodeId(id: number): Uint8Array {
  const bytes: number[] = [];
  let value = id;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }
  return Uint8Array.from(bytes);
}

/** EBML VINT 尺寸编码。 */
export function encodeVintSize(size: number): Uint8Array {
  if (size <= 2 ** 7 - 2) return Uint8Array.of(0x80 | size);
  if (size <= 2 ** 14 - 2) {
    return Uint8Array.of(0x40 | (size >> 8), size & 0xff);
  }
  if (size <= 2 ** 21 - 2) {
    return Uint8Array.of(0x20 | (size >> 16), (size >> 8) & 0xff, size & 0xff);
  }
  if (size <= 2 ** 28 - 2) {
    return Uint8Array.of(
      0x10 | (size >> 24),
      (size >> 16) & 0xff,
      (size >> 8) & 0xff,
      size & 0xff,
    );
  }
  // 8 字节未知长度占位（本封装器不使用，保留完整性）。
  return Uint8Array.of(0x01, 0, 0, 0, 0, 0, 0, 0);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 组装一个 EBML 元素。 */
export function element(id: number, ...children: Uint8Array[]): Uint8Array {
  const body = concat(children);
  return concat([encodeId(id), encodeVintSize(body.length), body]);
}

export function uintElement(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return element(id, Uint8Array.from(bytes));
}

export function floatElement(id: number, value: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return element(id, new Uint8Array(buffer));
}

export function stringElement(id: number, text: string): Uint8Array {
  return element(id, new TextEncoder().encode(text));
}

/** SimpleBlock：track VINT + int16 时间戳（相对 cluster，毫秒）+ flags + 数据。 */
export function simpleBlock(
  trackNumber: number,
  relativeMs: number,
  keyframe: boolean,
  data: Uint8Array,
): Uint8Array {
  const head = Uint8Array.of(
    0x80 | trackNumber,
    (relativeMs >> 8) & 0xff,
    relativeMs & 0xff,
    keyframe ? 0x80 : 0x00,
  );
  return element(EBML.SimpleBlock, head, data);
}

export interface VideoTrackConfig {
  width: number;
  height: number;
  frameRate: number;
}

export interface AudioTrackConfig {
  sampleRate: number;
  channels: number;
  codecPrivate: Uint8Array;
}

/** 写 EBML 文件头 + Segment 头 + Info + Tracks，返回后续 cluster 可追加的字节。 */
export function buildHeader(
  video: VideoTrackConfig,
  audio: AudioTrackConfig,
): Uint8Array {
  const ebmlHeader = element(
    EBML.Header,
    uintElement(EBML.Version, 1),
    uintElement(EBML.ReadVersion, 1),
    uintElement(EBML.MaxIdLength, 4),
    uintElement(EBML.MaxSizeLength, 8),
    stringElement(EBML.DocType, "webm"),
    uintElement(EBML.DocTypeVersion, 4),
    uintElement(EBML.DocTypeReadVersion, 2),
  );

  const info = element(
    EBML.Info,
    uintElement(EBML.TimecodeScale, 1_000_000), // 时间戳单位 = 毫秒
    stringElement(EBML.MuxingApp, "beatcut/0"),
    stringElement(EBML.WritingApp, "beatcut/0"),
    floatElement(EBML.Duration, 0), // 流式导出，占位 0
  );

  const videoTrack = element(
    EBML.TrackEntry,
    uintElement(EBML.TrackNumber, 1),
    uintElement(EBML.TrackUid, 1),
    uintElement(EBML.TrackType, 1),
    uintElement(EBML.FlagLacing, 0),
    uintElement(EBML.DefaultDuration, Math.round(1_000_000_000 / video.frameRate)),
    stringElement(EBML.Name, "video"),
    stringElement(EBML.CodecId, "V_VP9"),
    element(
      EBML.Video,
      uintElement(EBML.PixelWidth, video.width),
      uintElement(EBML.PixelHeight, video.height),
    ),
  );

  const audioTrack = element(
    EBML.TrackEntry,
    uintElement(EBML.TrackNumber, 2),
    uintElement(EBML.TrackUid, 2),
    uintElement(EBML.TrackType, 2),
    uintElement(EBML.FlagLacing, 0),
    stringElement(EBML.Name, "audio"),
    stringElement(EBML.CodecId, "A_OPUS"),
    element(EBML.CodecPrivate, audio.codecPrivate),
    element(
      EBML.Audio,
      floatElement(EBML.SamplingFrequency, audio.sampleRate),
      uintElement(EBML.Channels, audio.channels),
    ),
  );

  const tracks = element(EBML.Tracks, videoTrack, audioTrack);
  // Segment 尺寸未知：写 8 字节 VINT 未知长度标记 0x01ff..ff。
  const segmentHead = concat([
    encodeId(EBML.Segment),
    Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
  ]);
  return concat([ebmlHeader, segmentHead, info, tracks]);
}

export interface CueEntry {
  timeMs: number;
  clusterPosition: number;
}

/** 写文件尾部 Cues（指向各 cluster），帮助 seek。 */
export function buildCues(entries: CueEntry[]): Uint8Array {
  const points = entries.map((entry) =>
    element(
      EBML.CuePoint,
      uintElement(EBML.CueTime, entry.timeMs),
      element(
        EBML.CueTrackPositions,
        uintElement(EBML.CueTrack, 1),
        uintElement(EBML.CueClusterPosition, entry.clusterPosition),
      ),
    ),
  );
  return element(EBML.Cues, ...points);
}
