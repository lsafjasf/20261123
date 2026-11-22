/**
 * 纯 TypeScript WebM（Matroska 子集）封装器：把 WebCodecs AudioEncoder 输出的
 * Opus EncodedAudioChunk 封进可流式喂给 MediaSource SourceBuffer 的字节流。
 * 不依赖任何第三方库；EBML/VINT 编码严格按 Matroska 规范实现。
 */

function vint(value: number, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let v = value;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >>> (width - 1);
  return out;
}

function unknownVint(value: number): Uint8Array {
  let width = 1;
  let max = 0x7f;
  while (value > max && width < 8) {
    width++;
    max = max * 256 + 0xff;
  }
  return vint(value, width);
}

function element(id: number, payload: Uint8Array): Uint8Array {
  const idBytes = idToBytes(id);
  const sizeBytes = unknownVint(payload.length);
  const out = new Uint8Array(idBytes.length + sizeBytes.length + payload.length);
  out.set(idBytes, 0);
  out.set(sizeBytes, idBytes.length);
  out.set(payload, idBytes.length + sizeBytes.length);
  return out;
}

function idToBytes(id: number): Uint8Array {
  const bytes: number[] = [];
  let v = id;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array(bytes);
}

function uintElement(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return element(id, new Uint8Array(bytes));
}

function floatElement(id: number, value: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value);
  return element(id, new Uint8Array(buffer));
}

function stringElement(id: number, text: string): Uint8Array {
  return element(id, new TextEncoder().encode(text));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface OpusChunk {
  data: Uint8Array;
  timestamp: number; // 微秒
  duration: number; // 微秒
}

const IDS = {
  EBML: 0x1a45dfa3,
  EBML_VERSION: 0x4286,
  EBML_READ_VERSION: 0x42f7,
  EBML_MAX_ID_LENGTH: 0x42f2,
  EBML_MAX_SIZE_LENGTH: 0x42f3,
  DOC_TYPE: 0x4282,
  DOC_TYPE_VERSION: 0x4287,
  DOC_TYPE_READ_VERSION: 0x4285,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  MUXING_APP: 0x4d80,
  WRITING_APP: 0x5741,
  DURATION: 0x4489,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_UID: 0x73c5,
  TRACK_TYPE: 0x83,
  AUDIO: 0xe1,
  SAMPLING_FREQ: 0xb5,
  CHANNELS: 0x9f,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
};

/** OpusHead（CodecPrivate）：WebM 中 Opus 轨道必需 */
function opusHead(sampleRate: number, channels: number): Uint8Array {
  const signature = new TextEncoder().encode('OpusHead');
  const out = new Uint8Array(19);
  out.set(signature, 0);
  out[8] = 1; // version
  out[9] = channels;
  new DataView(out.buffer).setUint16(10, 0, true); // pre-skip
  new DataView(out.buffer).setUint32(12, sampleRate, true);
  new DataView(out.buffer).setUint16(16, 0, true); // gain
  out[18] = 0; // channel mapping family
  return out;
}

export class WebmOpusMuxer {
  private clusterTime = 0;
  private clusterOpen = false;

  private readonly sampleRate: number;
  private readonly channels: number;

  constructor(sampleRate: number, channels = 2) {
    this.sampleRate = sampleRate;
    this.channels = channels;
  }

  header(durationSeconds: number): Uint8Array {
    const ebml = element(
      IDS.EBML,
      concat([
        uintElement(IDS.EBML_VERSION, 1),
        uintElement(IDS.EBML_READ_VERSION, 1),
        uintElement(IDS.EBML_MAX_ID_LENGTH, 4),
        uintElement(IDS.EBML_MAX_SIZE_LENGTH, 8),
        stringElement(IDS.DOC_TYPE, 'webm'),
        uintElement(IDS.DOC_TYPE_VERSION, 4),
        uintElement(IDS.DOC_TYPE_READ_VERSION, 2),
      ]),
    );

    const info = element(
      IDS.INFO,
      concat([
        uintElement(IDS.TIMECODE_SCALE, 1_000_000), // 时间戳单位 = 1ms
        stringElement(IDS.MUXING_APP, 'collision-mixer'),
        stringElement(IDS.WRITING_APP, 'collision-mixer'),
        floatElement(IDS.DURATION, durationSeconds * 1000),
      ]),
    );

    const track = element(
      IDS.TRACK_ENTRY,
      concat([
        uintElement(IDS.TRACK_NUMBER, 1),
        uintElement(IDS.TRACK_UID, 1),
        uintElement(IDS.TRACK_TYPE, 1), // audio
        stringElement(IDS.CODEC_ID, 'A_OPUS'),
        element(IDS.CODEC_PRIVATE, opusHead(this.sampleRate, this.channels)),
        element(
          IDS.AUDIO,
          concat([
            floatElement(IDS.SAMPLING_FREQ, this.sampleRate),
            uintElement(IDS.CHANNELS, this.channels),
          ]),
        ),
      ]),
    );

    // Segment 使用未知长度（VINT 全 1），适配 MediaSource 流式追加
    const segmentHead = concat([
      idToBytes(IDS.SEGMENT),
      new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      info,
      element(IDS.TRACKS, track),
    ]);
    return concat([ebml, segmentHead]);
  }

  /**
   * 封一个 Opus chunk，返回本次应追加到 SourceBuffer 的全部字节
   * （开新簇时会带上 Cluster 头与 Timecode）。按 ~1s 滚动新 Cluster。
   */
  addChunk(chunk: OpusChunk): Uint8Array {
    const timeMs = Math.round(chunk.timestamp / 1000);
    const parts: Uint8Array[] = [];
    const needNewCluster =
      !this.clusterOpen || timeMs - this.clusterTime >= 1000;
    if (needNewCluster) {
      this.clusterTime = timeMs;
      this.clusterOpen = true;
      parts.push(
        idToBytes(IDS.CLUSTER),
        new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
        uintElement(IDS.TIMECODE, this.clusterTime),
      );
    }

    const relative = timeMs - this.clusterTime;
    const blockHeader = concat([
      vint(1, 1), // track 1
      int16(relative),
      new Uint8Array([0]), // flags
    ]);
    const simpleBlock = element(
      IDS.SIMPLE_BLOCK,
      concat([blockHeader, chunk.data]),
    );
    parts.push(simpleBlock);
    return concat(parts);
  }
}

function int16(value: number): Uint8Array {
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setInt16(0, value);
  return new Uint8Array(buffer);
}
