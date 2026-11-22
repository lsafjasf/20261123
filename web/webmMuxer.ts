// 最小 WebM (Matroska/EBML) 封装器：接收 WebCodecs 编码块，产出可被
// MediaSource SourceBuffer 接受的流式分片。无第三方依赖。
// 视频 VP9/VP8/AV1；音频 A_OPUS（WebAudio 侧编码为 Opus 包）。

export interface MuxChunk {
  data: Uint8Array;
  timestampMicros: number;
  isKey: boolean;
}

export interface WebmTrack {
  id: number;
  kind: 'video' | 'audio';
  codec: string;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
}

export class WebmMuxer {
  private readonly encoder = new TextEncoder();
  private readonly videoTrack: WebmTrack;
  private readonly audioTrack: WebmTrack | null;
  private readonly buffered: Uint8Array[] = [];

  constructor(video: WebmTrack, audio: WebmTrack | null = null) {
    this.videoTrack = video;
    this.audioTrack = audio;
  }

  /**
   * 编码一块并缓存；关键帧自动开新 Cluster。
   * 为保证产出标准定长、可寻址、MSE 兼容的 WebM，这里先缓存全部块，
   * 最终由 build() 一次性写入带正确长度的 Segment。
   */
  muxVideo(chunk: MuxChunk): Uint8Array {
    const out = this.clusterChunk(this.videoTrack.id, chunk);
    this.buffered.push(out);
    return out;
  }

  muxAudio(chunk: MuxChunk): Uint8Array {
    const out = this.clusterChunk(this.audioTrack!.id, chunk);
    this.buffered.push(out);
    return out;
  }

  /** 生成完整、定长、可被 MediaSource 直接消费的 WebM 字节。 */
  build(): Uint8Array {
    const ebmlHeader = this.element(0x1a45dfa3, [
      this.uintElement(0x4286, 1),
      this.uintElement(0x42f7, 1),
      this.uintElement(0x42f2, 4),
      this.uintElement(0x42f3, 8),
      this.element(0x4282, this.encoder.encode('matroska')),
      this.uintElement(0x4287, 4),
      this.uintElement(0x4285, 2),
    ]);
    const info = this.element(0x1549a966, [
      this.uintElement(0x2ad7b1, 1_000_000),
      this.element(0x4d80, [this.uintElement(0x55b0, 0x3f)]),
    ]);
    const segmentBody = concat(info, this.tracksElement(), ...this.buffered);
    const segment = this.element(0x18538067, [segmentBody]);
    return concat(ebmlHeader, segment);
  }

  private tracksElement(): Uint8Array {
    const video = this.element(0xae, [
      this.uintElement(0xd7, this.videoTrack.id),
      this.uintElement(0x73c5, 1),
      this.element(0x83, this.codecId(this.videoTrack.codec)),
      this.element(0xe0, [
        this.uintElement(0xb0, this.videoTrack.width!),
        this.uintElement(0xba, this.videoTrack.height!),
      ]),
    ]);
    const children = [video];
    if (this.audioTrack) {
      children.push(this.element(0xae, [
        this.uintElement(0xd7, this.audioTrack.id),
        this.uintElement(0x73c5, 2),
        this.element(0x83, this.codecId('opus')),
        this.element(0xe1, [
          this.floatElement(0xb5, this.audioTrack.sampleRate!),
          this.uintElement(0x9f, this.audioTrack.channels!),
        ]),
      ]));
    }
    return this.element(0x1654ae6b, children);
  }

  private codecId(codec: string): Uint8Array {
    const map: Record<string, string> = {
      vp9: 'V_VP9', vp8: 'V_VP8', av1: 'V_AV1', opus: 'A_OPUS',
    };
    return this.encoder.encode(map[codec] ?? codec);
  }

  private clusterStart = -1;
  private clusterTime = 0;

  /** 按需开/复用 Cluster，返回本块字节（含可能的新 Cluster 头）。 */
  private clusterChunk(trackId: number, chunk: MuxChunk): Uint8Array {
    const parts: Uint8Array[] = [];
    const isVideo = trackId === this.videoTrack.id;
    if (isVideo && (chunk.isKey || this.clusterStart < 0)) {
      this.clusterTime = chunk.timestampMicros;
      parts.push(this.element(0x1f43b675, [this.uintElement(0xe7, this.clusterTime)]));
      this.clusterStart = this.clusterTime;
    }
    const relTime = Math.max(0, chunk.timestampMicros - this.clusterTime);
    parts.push(this.simpleBlock(trackId, relTime, chunk.data, isVideo && chunk.isKey));
    return concat(...parts);
  }

  /** 兼容旧接口：定长模式下收尾无需额外字节。 */
  flush(): Uint8Array {
    this.clusterStart = -1;
    return new Uint8Array(0);
  }

  private simpleBlock(trackId: number, relTimeMicros: number, data: Uint8Array, key: boolean): Uint8Array {
    const trackVint = new Uint8Array([0x80 | trackId]);
    const time = new Uint8Array([
      (relTimeMicros >> 8) & 0xff,
      relTimeMicros & 0xff,
    ]);
    const flags = new Uint8Array([key ? 0x80 : 0x00]);
    return this.element(0xa3, concat(trackVint, time, flags, data));
  }

  private element(id: number, children: Uint8Array[] | Uint8Array): Uint8Array {
    const body = Array.isArray(children) ? concat(...children) : children;
    return concat(this.vint(id, false), this.vint(body.length, true), body);
  }

  private uintElement(id: number, value: number): Uint8Array {
    const bytes: number[] = [];
    let v = value;
    do {
      bytes.unshift(v & 0xff);
      v = Math.floor(v / 256);
    } while (v > 0);
    return this.element(id, new Uint8Array(bytes));
  }

  private floatElement(id: number, value: number): Uint8Array {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value);
    return this.element(id, new Uint8Array(buf));
  }

  /** EBML 可变长整数 / 元素 ID 编码。 */
  private vint(value: number, asLength: boolean): Uint8Array {
    if (!asLength) {
      // 元素 ID：保留长度前缀位
      const bytes: number[] = [];
      let v = value;
      while (v > 0) {
        bytes.unshift(v & 0xff);
        v >>= 8;
      }
      const prefix = 0x80 >> (bytes.length - 1);
      bytes[0] |= prefix;
      return new Uint8Array(bytes);
    }
    const bytes: number[] = [];
    let v = value;
    do {
      bytes.unshift(v & 0xff);
      v = Math.floor(v / 256);
    } while (v > 0);
    bytes[0] |= 0x80 >> (bytes.length - 1);
    return new Uint8Array(bytes);
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
