import type { ReplayFrame, ReplaySnapshot } from "./ring-buffer.ts";

export interface WebMOptions {
  width: number;
  height: number;
  audioSampleRate?: number;
  audioChannels?: number;
}

export interface WebMResult {
  bytes: Uint8Array;
  mimeType: string;
  durationMs: number;
  clusterCount: number;
  videoFrameCount: number;
  audioFrameCount: number;
}

const ID = {
  ebml: [0x1a, 0x45, 0xdf, 0xa3],
  ebmlVersion: [0x42, 0x86],
  ebmlReadVersion: [0x42, 0xf7],
  ebmlMaxIdLength: [0x42, 0xf2],
  ebmlMaxSizeLength: [0x42, 0xf3],
  docType: [0x42, 0x82],
  docTypeVersion: [0x42, 0x87],
  docTypeReadVersion: [0x42, 0x85],
  segment: [0x18, 0x53, 0x80, 0x67],
  info: [0x15, 0x49, 0xa9, 0x66],
  timecodeScale: [0x2a, 0xd7, 0xb1],
  duration: [0x44, 0x89],
  muxingApp: [0x4d, 0x80],
  writingApp: [0x57, 0x41],
  tracks: [0x16, 0x54, 0xae, 0x6b],
  trackEntry: [0xae],
  trackNumber: [0xd7],
  trackUid: [0x73, 0xc5],
  trackType: [0x83],
  flagDefault: [0x88],
  flagLacing: [0x9c],
  codecId: [0x86],
  codecPrivate: [0x63, 0xa2],
  codecDelay: [0x56, 0xaa],
  defaultDuration: [0x23, 0xe3, 0x83],
  video: [0xe0],
  pixelWidth: [0xb0],
  pixelHeight: [0xba],
  audio: [0xe1],
  samplingFrequency: [0xb5],
  channels: [0x9f],
  cluster: [0x1f, 0x43, 0xb6, 0x75],
  clusterTimecode: [0xe7],
  simpleBlock: [0xa3],
} as const;

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function vint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid EBML variable integer: ${value}`);
  }
  let length = 1;
  while (value >= 2 ** (7 * length) - 1) {
    length += 1;
  }
  const output = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  output[0] |= 1 << (8 - length);
  return output;
}

function element(id: readonly number[], payload: Uint8Array): Uint8Array {
  return concat([bytes(...id), vint(payload.byteLength), payload]);
}

function uint(value: number): Uint8Array {
  const output = new Uint8Array(8);
  let remaining = value;
  let length = 1;
  for (let index = 7; index >= 0; index -= 1) {
    output[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
    if (remaining > 0) {
      length += 1;
    }
  }
  return output.slice(8 - length);
}

function uintElement(id: readonly number[], value: number): Uint8Array {
  return element(id, uint(value));
}

function floatElement(id: readonly number[], value: number): Uint8Array {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setFloat64(0, value, false);
  return element(id, payload);
}

function stringElement(id: readonly number[], value: string): Uint8Array {
  return element(id, encoder.encode(value));
}

function makeOpusHead(channels: number): Uint8Array {
  const payload = new Uint8Array(19);
  payload.set(encoder.encode("OpusHead"));
  payload[8] = 1;
  payload[9] = channels;
  payload[10] = 0x38;
  payload[11] = 0x01;
  payload[12] = 0x80;
  payload[13] = 0xbb;
  return payload;
}

function trackEntry(track: "video" | "audio", width: number, height: number, channels: number): Uint8Array {
  if (track === "video") {
    return element(ID.trackEntry, concat([
      uintElement(ID.trackNumber, 1),
      uintElement(ID.trackUid, 1),
      uintElement(ID.trackType, 1),
      uintElement(ID.flagDefault, 1),
      uintElement(ID.flagLacing, 0),
      stringElement(ID.codecId, "V_VP8"),
      uintElement(ID.defaultDuration, 33_333_333),
      element(ID.video, concat([
        uintElement(ID.pixelWidth, width),
        uintElement(ID.pixelHeight, height),
      ])),
    ]));
  }
  return element(ID.trackEntry, concat([
    uintElement(ID.trackNumber, 2),
    uintElement(ID.trackUid, 2),
    uintElement(ID.trackType, 2),
    uintElement(ID.flagDefault, 1),
    uintElement(ID.flagLacing, 0),
    stringElement(ID.codecId, "A_OPUS"),
    element(ID.codecPrivate, makeOpusHead(channels)),
    uintElement(ID.codecDelay, 6_500_000),
    uintElement(ID.defaultDuration, 20_000_000),
    element(ID.audio, concat([
      floatElement(ID.samplingFrequency, 48_000),
      uintElement(ID.channels, channels),
    ])),
  ]));
}

function simpleBlock(frame: ReplayFrame, clusterStartMs: number): Uint8Array {
  const trackNumber = frame.track === "video" ? 0x81 : 0x82;
  const relative = Math.max(-32_768, Math.min(32_767, Math.round(frame.timestampUs / 1000) - clusterStartMs));
  const header = new Uint8Array(4);
  header[0] = trackNumber;
  new DataView(header.buffer).setInt16(1, relative, false);
  header[3] = frame.type === "key" ? 0x80 : 0;
  return element(ID.simpleBlock, concat([header, frame.data]));
}

function makeCluster(frames: ReplayFrame[], startMs: number): Uint8Array {
  const blocks = frames.map((frame) => simpleBlock(frame, startMs));
  return element(ID.cluster, concat([uintElement(ID.clusterTimecode, startMs), ...blocks]));
}

export function muxReplaySnapshot(snapshot: ReplaySnapshot, options: WebMOptions): WebMResult {
  if (!snapshot.videoFrames.length || snapshot.videoFrames[0].type !== "key") {
    throw new Error("A replay clip must start with a keyframe");
  }
  const width = Math.max(2, Math.floor(options.width));
  const height = Math.max(2, Math.floor(options.height));
  const channels = Math.max(1, Math.min(2, Math.floor(options.audioChannels ?? 2)));
  const hasAudio = snapshot.audioFrames.length > 0;
  const frames = [...snapshot.videoFrames, ...snapshot.audioFrames].sort((left, right) => {
    return left.timestampUs - right.timestampUs ||
      (left.track === "video" ? -1 : right.track === "video" ? 1 : 0);
  });
  const endUs = frames.reduce((maximum, frame) => Math.max(maximum, frame.timestampUs + frame.durationUs), 0);
  const durationMs = Math.max(1, Math.ceil(endUs / 1000));

  const header = element(ID.ebml, concat([
    uintElement(ID.ebmlVersion, 1),
    uintElement(ID.ebmlReadVersion, 1),
    uintElement(ID.ebmlMaxIdLength, 4),
    uintElement(ID.ebmlMaxSizeLength, 8),
    stringElement(ID.docType, "webm"),
    uintElement(ID.docTypeVersion, 4),
    uintElement(ID.docTypeReadVersion, 2),
  ]));

  const info = element(ID.info, concat([
    uintElement(ID.timecodeScale, 1_000_000),
    stringElement(ID.muxingApp, "TrailReplay local"),
    stringElement(ID.writingApp, "TrailReplay WebCodecs"),
    floatElement(ID.duration, durationMs),
  ]));

  const tracks = element(ID.tracks, concat([
    trackEntry("video", width, height, channels),
    ...(hasAudio ? [trackEntry("audio", width, height, channels)] : []),
  ]));

  const clusters: Uint8Array[] = [];
  let clusterStartMs = 0;
  let clusterFrames: ReplayFrame[] = [];
  const flushCluster = (): void => {
    if (clusterFrames.length) {
      clusters.push(makeCluster(clusterFrames, clusterStartMs));
    }
  };

  for (const frame of frames) {
    const frameMs = Math.max(0, Math.round(frame.timestampUs / 1000));
    if (!clusterFrames.length || frameMs - clusterStartMs >= 5_000) {
      flushCluster();
      clusterStartMs = frameMs;
      clusterFrames = [];
    }
    clusterFrames.push(frame);
  }
  flushCluster();

  const segmentBody = concat([info, tracks, ...clusters]);
  const output = concat([header, element(ID.segment, segmentBody)]);
  return {
    bytes: output,
    mimeType: hasAudio ? 'video/webm; codecs="vp8,opus"' : 'video/webm; codecs="vp8"',
    durationMs,
    clusterCount: clusters.length,
    videoFrameCount: snapshot.videoFrames.length,
    audioFrameCount: snapshot.audioFrames.length,
  };
}
