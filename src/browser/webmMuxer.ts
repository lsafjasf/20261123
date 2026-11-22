/**
 * 最小可用的 WebM/Matroska（EBML）复用器。
 * 输出包含 EBML 头、SegmentInfo、一条 VP9 视频轨、一条 Opus 音频轨及 Clusters，
 * 可被 Chrome 的 MediaSource 直接播放。仅依赖 ArrayBuffer/DataView。
 */

export interface MuxerTrack {
  kind: "video" | "audio";
  codec: string;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  chunks: EncodedVideoChunk[] | EncodedAudioChunk[];
}

class EbmlBuilder {
  private parts: Uint8Array[] = [];
  private total = 0;

  bytes(): Uint8Array {
    const output = new Uint8Array(this.total);
    let offset = 0;
    for (const part of this.parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  raw(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.total += bytes.length;
  }

  element(id: number[], payload: Uint8Array): void {
    this.raw(Uint8Array.from(id));
    this.vint(payload.length, 8);
    this.raw(payload);
  }

  unsigned(id: number[], value: number): void {
    const bytes: number[] = [];
    let current = value;
    do {
      bytes.unshift(current & 0xff);
      current = Math.floor(current / 256);
    } while (current > 0);
    this.element(id, Uint8Array.from(bytes));
  }

  float(id: number[], value: number): void {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value);
    this.element(id, new Uint8Array(buffer));
  }

  string(id: number[], value: string): void {
    this.element(id, new TextEncoder().encode(value));
  }

  /** EBML 可变长整数；length 为占位字节数 */
  vint(value: number, length: number): void {
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);
    let rest = value;
    for (let index = length - 1; index > 0; index--) {
      view.setUint8(index, rest & 0xff);
      rest = Math.floor(rest / 256);
    }
    view.setUint8(0, (rest & 0x7f) | (1 << (8 - length)));
    this.raw(new Uint8Array(buffer));
  }
}

function chunkBytes(chunk: EncodedVideoChunk | EncodedAudioChunk): Uint8Array {
  const buffer = new ArrayBuffer(chunk.byteLength);
  chunk.copyTo(new Uint8Array(buffer));
  return new Uint8Array(buffer);
}

export function encodeWebmSegment(tracks: MuxerTrack[]): Uint8Array {
  const builder = new EbmlBuilder();

  // EBML header
  const header = new EbmlBuilder();
  header.unsigned([0x42, 0x86], 1); // EBMLVersion
  header.unsigned([0x42, 0xf7], 1); // EBMLReadVersion
  header.unsigned([0x42, 0xf2], 4); // EBMLMaxIDLength
  header.unsigned([0x42, 0xf3], 8); // EBMLMaxSizeLength
  header.string([0x42, 0x82], "webm"); // DocType
  header.unsigned([0x42, 0x87], 2); // DocTypeVersion
  header.unsigned([0x42, 0x85], 2); // DocTypeReadVersion
  builder.element([0x1a, 0x45, 0xdf, 0xa3], header.bytes());

  const segmentBody = new EbmlBuilder();

  // Info
  const info = new EbmlBuilder();
  info.unsigned([0x2a, 0xd7, 0xb1], 1_000_000); // TimecodeScale: 1ms
  info.string([0x4d, 0x80], "local-scheduler");
  info.float([0x44, 0x89], 1); // Duration 占位
  segmentBody.element([0x15, 0x49, 0xa9, 0x66], info.bytes());

  // Tracks
  const tracksBuilder = new EbmlBuilder();
  tracks.forEach((track, trackIndex) => {
    const entry = new EbmlBuilder();
    entry.unsigned([0xd7], trackIndex + 1); // TrackNumber
    entry.unsigned([0x73, 0xc5], trackIndex + 1); // TrackUID
    entry.unsigned([0x9c], 0); // FlagLacing
    if (track.kind === "video") {
      entry.unsigned([0x83], 1); // TrackType=video
      entry.string([0x86], `V_VP9`); // CodecID
      const video = new EbmlBuilder();
      video.unsigned([0xb0], track.width ?? 320);
      video.unsigned([0xba], track.height ?? 180);
      entry.element([0xe0], video.bytes());
      entry.unsigned([0x23, 0xe3, 0x83], Math.round((track.fps ?? 30) * 1000)); // DefaultDuration 单位 ns
    } else {
      entry.unsigned([0x83], 2); // TrackType=audio
      entry.string([0x86], "A_OPUS");
      const audio = new EbmlBuilder();
      audio.unsigned([0xb5], track.sampleRate ?? 48000);
      audio.unsigned([0x9f], track.channels ?? 1);
      entry.element([0xe1], audio.bytes());
    }
    tracksBuilder.element([0xae], entry.bytes());
  });
  segmentBody.element([0x16, 0x54, 0xae, 0x6b], tracksBuilder.bytes());

  // Clusters：每个编码块一个 SimpleBlock
  const cluster = new EbmlBuilder();
  cluster.unsigned([0xe7], 0); // Timecode
  for (const track of tracks) {
    for (const chunk of track.chunks) {
      const data = chunkBytes(chunk);
      const block = new EbmlBuilder();
      block.vint(track.kind === "video" ? 1 : 2, 1); // track number vint
      const timeMs = Math.max(0, Math.round(chunk.timestamp / 1_000_000));
      block.raw(Uint8Array.from([(timeMs >> 8) & 0xff, timeMs & 0xff]));
      block.raw(Uint8Array.from([0x80])); // flags: keyframe
      block.raw(data);
      cluster.element([0xa3], block.bytes());
    }
  }
  segmentBody.element([0x1f, 0x43, 0xb6, 0x75], cluster.bytes());

  // Segment 容器尺寸用未知长度（一字节 0xff），流式分段友好
  builder.raw(Uint8Array.from([0x18, 0x53, 0x80, 0x67]));
  builder.raw(Uint8Array.from([0xff]));
  builder.raw(segmentBody.bytes());
  return builder.bytes();
}
