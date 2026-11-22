/**
 * 面向 MediaSource 的实时 Opus-in-WebM 复用器。
 * 输出：1 个 EBML 头 + 1 个带未知长度的 Segment（live 流），
 * 随后按时间片持续输出 Cluster。
 */

import {
  concatBytes,
  element,
  encodeElement,
  floatElement,
  masterElement,
  stringElement,
  uintElement,
} from './ebml.ts';

const ID_EBML = 0x1a45dfa3;
const ID_EBML_VERSION = 0x4286;
const ID_EBML_READ_VERSION = 0x42f7;
const ID_EBML_MAX_ID_LENGTH = 0x42f2;
const ID_EBML_MAX_SIZE_LENGTH = 0x42f3;
const ID_DOCTYPE = 0x4282;
const ID_DOCTYPE_VERSION = 0x4287;
const ID_DOCTYPE_READ_VERSION = 0x4285;

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_MUXING_APP = 0x4d80;
const ID_WRITING_APP = 0x5741;
const ID_DURATION = 0x4489;

const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_UID = 0x73c5;
const ID_FLAG_LACING = 0x9c;
const ID_LANGUAGE = 0x22b59c;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_AUDIO = 0xe1;
const ID_SAMPLING_FREQUENCY = 0xb5;
const ID_CHANNELS = 0x9f;
const ID_BIT_DEPTH = 0x6264;

const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;

const UNKNOWN_SIZE = 0x01ffffffffffffff;

export interface OpusConfig {
  sampleRate: number;
  channels: number;
}

export interface OpusPacket {
  data: Uint8Array;
  /** 相对流起点的时间戳，毫秒。 */
  timestampMs: number;
  keyframe: boolean;
}

/** 生成 OpusHead（Codecprivate），按 A_OPUS 规范。 */
export function buildOpusHead(config: OpusConfig): Uint8Array {
  const out = new Uint8Array(19);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('OpusHead'), 0);
  out[8] = 1;
  out[9] = config.channels;
  view.setUint16(10, 0, true);
  view.setUint32(12, config.sampleRate, true);
  view.setUint16(16, 0, true);
  out[18] = 0;
  return out;
}

function buildEbmlHeader(): Uint8Array {
  const children = [
    uintElement(ID_EBML_VERSION, 1, 1),
    uintElement(ID_EBML_READ_VERSION, 1, 1),
    uintElement(ID_EBML_MAX_ID_LENGTH, 1, 4),
    uintElement(ID_EBML_MAX_SIZE_LENGTH, 1, 8),
    stringElement(ID_DOCTYPE, 2, 'webm'),
    uintElement(ID_DOCTYPE_VERSION, 2, 4),
    uintElement(ID_DOCTYPE_READ_VERSION, 2, 2),
  ];
  return encodeElement(masterElement(ID_EBML, 4, children));
}

function buildInfo(): Uint8Array {
  const children = [
    uintElement(ID_TIMECODE_SCALE, 3, 1_000_000),
    stringElement(ID_MUXING_APP, 2, 'rlp-probe'),
    stringElement(ID_WRITING_APP, 2, 'rlp-probe'),
    floatElement(ID_DURATION, 2, 0),
  ];
  return encodeElement(masterElement(ID_INFO, 4, children));
}

function buildTracks(config: OpusConfig): Uint8Array {
  const entry = masterElement(ID_TRACK_ENTRY, 1, [
    uintElement(ID_TRACK_NUMBER, 1, 1),
    uintElement(ID_TRACK_UID, 2, 1),
    uintElement(ID_FLAG_LACING, 1, 0),
    stringElement(ID_LANGUAGE, 3, 'und'),
    stringElement(ID_CODEC_ID, 1, 'A_OPUS'),
    element(ID_CODEC_PRIVATE, 2, buildOpusHead(config)),
    masterElement(ID_AUDIO, 1, [
      floatElement(ID_SAMPLING_FREQUENCY, 2, config.sampleRate),
      uintElement(ID_CHANNELS, 1, config.channels),
      uintElement(ID_BIT_DEPTH, 2, 32),
    ]),
  ]);
  return encodeElement(masterElement(ID_TRACKS, 4, [entry]));
}

function encodeUnknownSize(): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(UNKNOWN_SIZE), false);
  return bytes;
}

/**
 * SimpleBlock：track 号 VINT（轨道 1 => 0x81），
 * 后接 int16 相对 Cluster 时间码（毫秒）、flags、Opus 包。
 */
export function buildSimpleBlock(
  track: number,
  relativeTimeMs: number,
  keyframe: boolean,
  packet: Uint8Array,
): Uint8Array {
  const body = new Uint8Array(4 + packet.length);
  body[0] = 0x80 | track;
  new DataView(body.buffer).setInt16(1, relativeTimeMs, false);
  body[3] = keyframe ? 0x80 : 0;
  body.set(packet, 4);
  return encodeElement(element(ID_SIMPLE_BLOCK, 1, body));
}

export class WebmMuxer {
  private readonly config: OpusConfig;
  private clusterStartMs = -1;

  constructor(config: OpusConfig) {
    this.config = config;
  }

  /** 初始化分片：EBML 头 + 未知长度 Segment + Info + Tracks。 */
  initializationSegment(): Uint8Array {
    const header = buildEbmlHeader();
    const segmentId = new Uint8Array([0x18, 0x53, 0x80, 0x67]);
    const segmentSize = encodeUnknownSize();
    const info = buildInfo();
    const tracks = buildTracks(this.config);
    return concatBytes([header, segmentId, segmentSize, info, tracks]);
  }

  /**
   * 追加一个 Opus 包，返回需要刷给 SourceBuffer 的字节。
   * 每 500ms 或首包时开启新 Cluster，保证 live 低延迟。
   */
  appendPacket(packet: OpusPacket): Uint8Array {
    const parts: Uint8Array[] = [];
    if (
      this.clusterStartMs < 0 ||
      packet.timestampMs - this.clusterStartMs >= 500
    ) {
      this.clusterStartMs = Math.floor(packet.timestampMs);
      const timecode = encodeElement(
        uintElement(ID_TIMECODE, 1, this.clusterStartMs),
      );
      const clusterHead = concatBytes([
        new Uint8Array([0x1f, 0x43, 0xb6, 0x75]),
        encodeUnknownSize(),
        timecode,
      ]);
      parts.unshift(clusterHead);
    }
    const relative = Math.max(
      0,
      Math.round(packet.timestampMs - this.clusterStartMs),
    );
    const block = buildSimpleBlock(1, relative, packet.keyframe, packet.data);
    parts.push(block);
    return concatBytes(parts);
  }
}
