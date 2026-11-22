import type { VideoConfig } from "./types.ts";
import {
  concatBytes,
  encodeElement,
  encodeFloat,
  encodeString,
  encodeUint,
  idBytes,
  unsignedVint,
} from "./ebml.ts";
import {
  AUDIO,
  AV1_CODEC_ID,
  CHANNELS,
  CLUSTER,
  CLUSTER_TIMESTAMP,
  CODEC_ID,
  CODEC_PRIVATE,
  CUES,
  CUE_CLUSTER_POSITION,
  CUE_POINT,
  CUE_TIME,
  CUE_TRACK,
  CUE_TRACK_POSITIONS,
  DOC_TYPE,
  DOC_TYPE_READ_VERSION,
  DOC_TYPE_VERSION,
  DURATION,
  EBML_ID,
  EBML_MAX_ID_LENGTH,
  EBML_MAX_SIZE_LENGTH,
  EBML_READ_VERSION,
  EBML_VERSION,
  FLAG_LACING,
  INFO,
  LANGUAGE,
  MILLISECOND_TIMESTAMP_SCALE,
  MUXING_APP,
  OPUS_CODEC_ID,
  PIXEL_HEIGHT,
  PIXEL_WIDTH,
  SAMPLING_FREQ,
  SEGMENT,
  SIMPLE_BLOCK,
  TIMESTAMP_SCALE,
  TRACK_ENTRY,
  TRACK_NUMBER,
  TRACK_UID,
  TRACKS,
  VIDEO,
  VP8_CODEC_ID,
  VP9_CODEC_ID,
  WRITING_APP,
} from "./webm-ids.ts";

export type MuxerCodec = "vp9" | "vp8" | "av1" | "opus";

export interface VideoTrackOptions {
  kind: "video";
  number: number;
  codec: Exclude<MuxerCodec, "opus">;
  video: VideoConfig;
}

export interface AudioTrackOptions {
  kind: "audio";
  number: number;
  sampleRate: number;
  channels: number;
}

export type TrackOptions = VideoTrackOptions | AudioTrackOptions;

export interface MuxerFrame {
  trackNumber: number;
  timestampMs: number;
  data: Uint8Array;
  keyframe: boolean;
}

interface BlockRecord extends MuxerFrame {
  clusterMs: number;
}

const CLUSTER_MAX_MS = 1000;
const APP_NAME = "kenburns-documentary";

function magic(data: Uint8Array, text: string): boolean {
  const bytes = new TextEncoder().encode(text);
  if (data.byteLength < bytes.length) {
    return false;
  }
  return bytes.every((byte, index) => data[index] === byte);
}

export class WebMMuxer {
  private readonly tracks: TrackOptions[];
  private readonly blocks: BlockRecord[] = [];
  private opusHeader: Uint8Array | undefined;

  constructor(tracks: TrackOptions[]) {
    if (tracks.length === 0) {
      throw new Error("at least one track is required");
    }
    this.tracks = tracks;
  }

  addFrame(frame: MuxerFrame): void {
    const track = this.tracks.find((item) => item.number === frame.trackNumber);
    if (!track) {
      throw new Error(`unknown track number ${frame.trackNumber}`);
    }
    if (track.kind === "audio") {
      if (magic(frame.data, "OpusHead")) {
        this.opusHeader = frame.data;
        return;
      }
      if (magic(frame.data, "OpusTags")) {
        return;
      }
    }
    this.blocks.push({ ...frame, clusterMs: 0 });
  }

  private buildEbmlHeader(): Uint8Array {
    const payload = concatBytes([
      encodeUint(idBytes(EBML_VERSION), 1),
      encodeUint(idBytes(EBML_READ_VERSION), 1),
      encodeUint(idBytes(EBML_MAX_ID_LENGTH), 4),
      encodeUint(idBytes(EBML_MAX_SIZE_LENGTH), 8),
      encodeString(idBytes(DOC_TYPE), "webm"),
      encodeUint(idBytes(DOC_TYPE_VERSION), 4),
      encodeUint(idBytes(DOC_TYPE_READ_VERSION), 2),
    ]);
    return encodeElement(idBytes(EBML_ID), payload);
  }

  private buildTrackEntry(track: TrackOptions): Uint8Array {
    const parts: Uint8Array[] = [
      encodeUint(idBytes(TRACK_NUMBER), track.number),
      encodeUint(idBytes(TRACK_UID), track.number),
      encodeUint(idBytes(FLAG_LACING), 0),
      encodeString(idBytes(LANGUAGE), "und"),
    ];
    if (track.kind === "video") {
      const codecId = track.codec === "vp8"
        ? VP8_CODEC_ID
        : track.codec === "av1"
          ? AV1_CODEC_ID
          : VP9_CODEC_ID;
      parts.push(encodeString(idBytes(CODEC_ID), codecId));
      parts.push(encodeElement(idBytes(VIDEO), concatBytes([
        encodeUint(idBytes(PIXEL_WIDTH), track.video.width),
        encodeUint(idBytes(PIXEL_HEIGHT), track.video.height),
      ])));
    } else {
      parts.push(encodeString(idBytes(CODEC_ID), OPUS_CODEC_ID));
      if (this.opusHeader) {
        parts.push(encodeElement(idBytes(CODEC_PRIVATE), this.opusHeader));
      }
      parts.push(encodeElement(idBytes(AUDIO), concatBytes([
        encodeFloat(idBytes(SAMPLING_FREQ), track.sampleRate),
        encodeUint(idBytes(CHANNELS), track.channels),
      ])));
    }
    return encodeElement(idBytes(TRACK_ENTRY), concatBytes(parts));
  }

  private buildInfo(durationMs: number): Uint8Array {
    const parts = [
      encodeUint(idBytes(TIMESTAMP_SCALE), MILLISECOND_TIMESTAMP_SCALE),
      encodeFloat(idBytes(DURATION), durationMs),
      encodeString(idBytes(MUXING_APP), APP_NAME),
      encodeString(idBytes(WRITING_APP), APP_NAME),
    ];
    return encodeElement(idBytes(INFO), concatBytes(parts));
  }

  private buildSimpleBlock(block: BlockRecord): Uint8Array {
    const relative = Math.max(0, Math.round(block.timestampMs - block.clusterMs));
    if (relative > 0x7fff) {
      throw new Error("block timestamp overflows the 16-bit SimpleBlock timecode");
    }
    const timeBytes = new Uint8Array(2);
    new DataView(timeBytes.buffer).setInt16(0, relative, false);
    const header = concatBytes([unsignedVint(block.trackNumber), timeBytes, Uint8Array.of(block.keyframe ? 0x80 : 0)]);
    return encodeElement(idBytes(SIMPLE_BLOCK), concatBytes([header, block.data]));
  }

  private groupClusters(): BlockRecord[][] {
    const clusters: BlockRecord[][] = [];
    let current: BlockRecord[] = [];
    let clusterStart = 0;
    for (const block of this.blocks) {
      const flush = current.length > 0 && (
        (block.trackNumber === this.tracks[0].number &&
          block.keyframe &&
          block.timestampMs - clusterStart >= 100) ||
        block.timestampMs - clusterStart >= CLUSTER_MAX_MS
      );
      if (flush) {
        clusters.push(current);
        current = [];
        clusterStart = block.timestampMs;
      }
      if (current.length === 0) {
        clusterStart = block.timestampMs;
      }
      current.push({ ...block, clusterMs: clusterStart });
    }
    if (current.length > 0) {
      clusters.push(current);
    }
    return clusters;
  }

  private buildClusters(): { bytes: Uint8Array; timeMs: number; position: number }[] {
    const groups = this.groupClusters();
    return groups.map((blocks) => {
      const clusterMs = blocks[0].clusterMs;
      const payload = concatBytes([
        encodeUint(idBytes(CLUSTER_TIMESTAMP), Math.round(clusterMs)),
        ...blocks.map((block) => this.buildSimpleBlock(block)),
      ]);
      return {
        bytes: encodeElement(idBytes(CLUSTER), payload),
        timeMs: clusterMs,
        position: 0,
      };
    });
  }

  private buildCues(clusterRefs: { timeMs: number; position: number }[], videoTrackNumber: number): Uint8Array {
    const points = clusterRefs.map((ref) => encodeElement(idBytes(CUE_POINT), concatBytes([
      encodeUint(idBytes(CUE_TIME), Math.round(ref.timeMs)),
      encodeElement(idBytes(CUE_TRACK_POSITIONS), concatBytes([
        encodeUint(idBytes(CUE_TRACK), videoTrackNumber),
        encodeUint(idBytes(CUE_CLUSTER_POSITION), ref.position),
      ])),
    ])));
    return encodeElement(idBytes(CUES), concatBytes(points));
  }

  build(): Uint8Array {
    this.blocks.sort((a, b) => a.timestampMs - b.timestampMs || a.trackNumber - b.trackNumber);
    const durationMs = this.blocks.reduce((max, block) => Math.max(max, block.timestampMs), 0);
    const info = this.buildInfo(durationMs);
    const tracks = encodeElement(
      idBytes(TRACKS),
      concatBytes(this.tracks.map((track) => this.buildTrackEntry(track))),
    );
    const clusters = this.buildClusters();
    const videoTrack = this.tracks.find((track) => track.kind === "video");

    const clusterPayloadBytes = clusters.reduce((sum, cluster) => sum + cluster.bytes.byteLength, 0);
    const payloadSizeWithoutCues = info.byteLength + tracks.byteLength + clusterPayloadBytes;
    let segmentHeaderSize = idBytes(SEGMENT).byteLength + unsignedVint(payloadSizeWithoutCues).byteLength;
    const ebmlHeader = this.buildEbmlHeader();
    let cues = new Uint8Array(0);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let offset = info.byteLength + tracks.byteLength;
      for (const cluster of clusters) {
        cluster.position = ebmlHeader.byteLength + segmentHeaderSize + offset;
        offset += cluster.bytes.byteLength;
      }
      cues = videoTrack ? this.buildCues(clusters, videoTrack.number) : new Uint8Array(0);
      const payloadSize = info.byteLength + tracks.byteLength + clusterPayloadBytes + cues.byteLength;
      const nextHeaderSize = idBytes(SEGMENT).byteLength + unsignedVint(payloadSize).byteLength;
      if (nextHeaderSize === segmentHeaderSize) {
        break;
      }
      segmentHeaderSize = nextHeaderSize;
    }

    const segmentPayload = concatBytes([
      info,
      tracks,
      ...clusters.map((cluster) => cluster.bytes),
      cues,
    ]);
    const segment = encodeElement(idBytes(SEGMENT), segmentPayload);
    return concatBytes([ebmlHeader, segment]);
  }
}
