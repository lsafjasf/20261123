/**
 * WebM cluster 组装状态机：接收 WebCodecs 输出的 chunk 字节，
 * 按 clusterMaxMs 切分 cluster，记录 cue 位置，最终输出完整 Uint8Array。
 */

import {
  EBML,
  buildCues,
  buildHeader,
  concat,
  element,
  simpleBlock,
  uintElement,
  type AudioTrackConfig,
  type CueEntry,
  type VideoTrackConfig,
} from "./webm.ts";

export interface ChunkInput {
  kind: "video" | "audio";
  /** 微秒时间戳（WebCodecs timestamp 单位）。 */
  timestampUs: number;
  data: Uint8Array;
  keyframe: boolean;
}

const US_PER_MS = 1000;

export class WebmWriter {
  private readonly chunks: Uint8Array[] = [];
  private totalLength = 0;
  private readonly cues: CueEntry[] = [];
  private clusterStartUs = -1;
  private clusterParts: Uint8Array[] = [];
  private clusterPosition = 0;

  private readonly video: VideoTrackConfig;
  private readonly audio: AudioTrackConfig;
  private readonly clusterMaxMs: number;

  // SimpleBlock 相对时间戳是 int16 毫秒，cluster 必须短于 32767ms；
  // 取 500ms 既安全又能保证 seek 粒度。
  constructor(video: VideoTrackConfig, audio: AudioTrackConfig, clusterMaxMs = 500) {
    this.video = video;
    this.audio = audio;
    this.clusterMaxMs = clusterMaxMs;
  }

  start(): void {
    const header = buildHeader(this.video, this.audio);
    this.push(header);
  }

  private push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.totalLength += bytes.length;
  }

  private flushCluster(): void {
    if (this.clusterParts.length === 0) return;
    const timecodeMs = Math.round(this.clusterStartUs / US_PER_MS);
    const body = concat([
      uintElement(EBML.Timecode, timecodeMs),
      ...this.clusterParts,
    ]);
    const cluster = element(EBML.Cluster, body);
    this.cues.push({ timeMs: timecodeMs, clusterPosition: this.totalLength });
    this.push(cluster);
    this.clusterParts = [];
    this.clusterStartUs = -1;
  }

  addChunk(chunk: ChunkInput): void {
    const timestampMs = chunk.timestampUs / US_PER_MS;
    if (this.clusterStartUs < 0) {
      this.clusterStartUs = chunk.timestampUs;
      this.clusterPosition = this.totalLength;
    }
    const relativeMs = Math.max(0, Math.round(timestampMs - this.clusterStartUs / US_PER_MS));
    if (relativeMs >= this.clusterMaxMs) {
      this.flushCluster();
      this.clusterStartUs = chunk.timestampUs;
      this.clusterPosition = this.totalLength;
    }
    const track = chunk.kind === "video" ? 1 : 2;
    this.clusterParts.push(simpleBlock(track, relativeMs, chunk.keyframe, chunk.data));
  }

  finish(): Uint8Array {
    this.flushCluster();
    this.push(buildCues(this.cues));
    return concat(this.chunks);
  }

  get byteLength(): number {
    return this.totalLength;
  }
}
