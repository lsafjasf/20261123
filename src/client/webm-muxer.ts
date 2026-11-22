/**
 * Minimal Matroska/WebM muxer built only on the standard library.
 * Encoded chunks are collected into clusters in memory; Cues are assembled
 * when finalize() is called. Output plays through MediaSource and downloads
 * as a standard .webm file.
 */

const EBML_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const INFO_ID = 0x1549a966;
const TIMECODE_SCALE_ID = 0x2ad7b1;
const MUXING_APP_ID = 0x4d80;
const TRACKS_ID = 0x1654ae6b;
const TRACK_ENTRY_ID = 0xae;
const TRACK_NUMBER_ID = 0xd7;
const TRACK_UID_ID = 0x73c5;
const FLAG_LACING_ID = 0x9c28;
const CODEC_ID = 0x86;
const VIDEO_ID = 0xe0;
const PIXEL_WIDTH_ID = 0xb0;
const PIXEL_HEIGHT_ID = 0xba;
const AUDIO_ID = 0xe1;
const SAMPLING_ID = 0xb5;
const CHANNELS_ID = 0x9f;
const CLUSTER_ID = 0x1f43b675;
const TIMECODE_ID = 0xe7;
const SIMPLE_BLOCK_ID = 0xa3;
const CUES_ID = 0x1c53bb6b;
const CUE_POINT_ID = 0xbb;
const CUE_TIME_ID = 0xb3;
const CUE_TRACK_POSITIONS_ID = 0xb7;
const CUE_TRACK_ID = 0xf7;
const CUE_CLUSTER_POSITION_ID = 0xf1;
const DURATION_ID = 0x4489;

export interface MuxedTrack {
  number: number;
  codecId: string;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
}

interface CueEntry {
  timeMs: number;
  trackNumber: number;
  clusterIndex: number;
}

export class WebMMuxer {
  private readonly tracks: MuxedTrack[] = [];
  private readonly clusters: Uint8Array[] = [];
  private readonly cues: CueEntry[] = [];
  private clusterTimeMs = -1;
  private clusterBytes = 0;
  private currentCluster: number[] = [];
  private totalDurationMs = 0;
  private clusterIndex = -1;

  addTrack(track: MuxedTrack): number {
    this.tracks.push(track);
    return track.number;
  }

  addVideoChunk(
    trackNumber: number,
    chunk: EncodedVideoChunk,
    _description: BufferSource | undefined,
  ): void {
    const bytes = copyChunk(chunk);
    this.writeBlock(trackNumber, Math.round(chunk.timestamp / 1000), {
      key: chunk.type === 'key',
      bytes,
    });
    this.totalDurationMs = Math.max(
      this.totalDurationMs,
      (chunk.timestamp + (chunk.duration ?? 0)) / 1000,
    );
  }

  addAudioChunk(trackNumber: number, chunk: EncodedAudioChunk): void {
    const bytes = copyChunk(chunk);
    this.writeBlock(trackNumber, Math.round(chunk.timestamp / 1000), {
      key: true,
      bytes,
    });
    this.totalDurationMs = Math.max(
      this.totalDurationMs,
      (chunk.timestamp + (chunk.duration ?? 0)) / 1000,
    );
  }

  private writeBlock(
    trackNumber: number,
    timeMs: number,
    block: { key: boolean; bytes: Uint8Array },
  ): void {
    if (this.clusterTimeMs < 0 || timeMs - this.clusterTimeMs >= 30000) {
      this.flushCluster();
      this.clusterTimeMs = timeMs;
      this.clusterIndex += 1;
    }
    if (this.currentCluster.length === 0) {
      const tc = element(TIMECODE_ID, fixedWidthUint(this.clusterTimeMs, 8));
      this.push(tc);
    }
    const relative = timeMs - this.clusterTimeMs;
    const header = new Uint8Array(4);
    header.set([vintByte(trackNumber), 0, 0, block.key ? 0x80 : 0]);
    const view = new DataView(header.buffer);
    view.setInt16(1, relative, false);
    const simpleBlock = element(
      SIMPLE_BLOCK_ID,
      concat(header, block.bytes),
    );
    this.push(simpleBlock);
    if (block.key) {
      this.cues.push({
        timeMs,
        trackNumber,
        clusterIndex: this.clusterIndex,
      });
    }
  }

  private push(bytes: Uint8Array): void {
    this.currentCluster.push(...bytes);
    this.clusterBytes += bytes.length;
  }

  private flushCluster(): void {
    if (this.currentCluster.length === 0) return;
    const body = Uint8Array.from(this.currentCluster);
    this.clusters.push(element(CLUSTER_ID, body));
    this.currentCluster = [];
    this.clusterBytes = 0;
  }

  finalize(): Blob {
    this.flushCluster();
    const header = this.buildHeader();
    const info = this.buildInfo();
    const tracks = this.buildTracks();
    const clusterPositions: number[] = [];
    let offset = info.length + tracks.length;
    for (const cluster of this.clusters) {
      clusterPositions.push(offset);
      offset += cluster.length;
    }
    this.clusterPositions = clusterPositions;
    const segmentBody = concat(
      info,
      tracks,
      ...this.clusters,
      this.buildCues(),
    );
    const segment = element(SEGMENT_ID, segmentBody, true);
    return new Blob([header, segment], { type: 'video/webm' });
  }

  private clusterPositions: number[] = [];

  private buildHeader(): Uint8Array {
    const doctype = concat(
      stringElement(0x4282, 'webm'),
      uintElement(0x4287, 4),
      uintElement(0x4285, 2),
    );
    return element(
      EBML_ID,
      concat(uintElement(0x42f1, 1), doctype),
    );
  }

  private buildInfo(): Uint8Array {
    return element(
      INFO_ID,
      concat(
        uintElement(TIMECODE_SCALE_ID, 1_000_000),
        floatElement(DURATION_ID, this.totalDurationMs),
        stringElement(MUXING_APP_ID, 'esports-multiview/1.0'),
      ),
    );
  }

  private buildTracks(): Uint8Array {
    const entries = this.tracks.map((track) => {
      const parts = [
        uintElement(TRACK_NUMBER_ID, track.number),
        uintElement(TRACK_UID_ID, track.number * 10 + 1),
        uintElement(FLAG_LACING_ID, 0),
        stringElement(CODEC_ID, track.codecId),
      ];
      if (track.width && track.height) {
        parts.push(
          element(
            VIDEO_ID,
            concat(
              uintElement(PIXEL_WIDTH_ID, track.width),
              uintElement(PIXEL_HEIGHT_ID, track.height),
            ),
          ),
        );
      }
      if (track.sampleRate && track.channels) {
        parts.push(
          element(
            AUDIO_ID,
            concat(
              floatElement(SAMPLING_ID, track.sampleRate),
              uintElement(CHANNELS_ID, track.channels),
            ),
          ),
        );
      }
      return element(TRACK_ENTRY_ID, concat(...parts));
    });
    return element(TRACKS_ID, concat(...entries));
  }

  private buildCues(): Uint8Array {
    const points = this.cues.map((cue) =>
      element(
        CUE_POINT_ID,
        concat(
          uintElement(CUE_TIME_ID, cue.timeMs),
          element(
            CUE_TRACK_POSITIONS_ID,
            concat(
              uintElement(CUE_TRACK_ID, cue.trackNumber),
              uintElement(
                CUE_CLUSTER_POSITION_ID,
                this.clusterPositions[cue.clusterIndex] ?? 0,
              ),
            ),
          ),
        ),
      ),
    );
    return points.length ? element(CUES_ID, concat(...points)) : new Uint8Array(0);
  }
}

function copyChunk(chunk: EncodedVideoChunk | EncodedAudioChunk): Uint8Array {
  const size = chunk.byteLength;
  const buffer = new Uint8Array(size);
  chunk.copyTo(buffer);
  return buffer;
}

function element(
  id: number,
  payload: Uint8Array,
  unknownSize = false,
): Uint8Array {
  const idBytes = idToBytes(id);
  const sizeBytes = unknownSize
    ? new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    : vint(payload.length);
  return concat(idBytes, sizeBytes, payload);
}

function idToBytes(id: number): Uint8Array {
  const out: number[] = [];
  let value = id;
  while (value > 0) {
    out.unshift(value & 0xff);
    value = Math.floor(value / 0x100);
  }
  return Uint8Array.from(out);
}

function vint(value: number): Uint8Array {
  let length = 1;
  let max = 2 ** 7 - 2;
  while (value > max && length < 8) {
    length += 1;
    max = 2 ** (7 * length) - 2;
  }
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 0x100);
  }
  out[0] |= 0x80 >>> (length - 1);
  return out;
}

function vintByte(value: number): number {
  if (value < 1 || value > 126) throw new Error(`vint byte overflow: ${value}`);
  return value | 0x80;
}

function fixedWidthUint(value: number, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let remaining = value;
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 0x100);
  }
  return out;
}

function uintElement(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 0x100);
  } while (remaining > 0);
  return element(id, Uint8Array.from(bytes));
}

function stringElement(id: number, value: string): Uint8Array {
  return element(id, new TextEncoder().encode(value));
}

function floatElement(id: number, value: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return element(id, new Uint8Array(buffer));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
