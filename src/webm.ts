export interface WebMVideoChunk {
  data: Uint8Array;
  timestamp: number;
  duration: number;
  key: boolean;
}

export interface WebMAudioChunk {
  data: Uint8Array;
  timestamp: number;
  duration: number;
}

interface MuxOptions {
  width: number;
  height: number;
  fps: number;
  duration: number;
  videoCodec?: "vp8" | "vp9";
  audioChunks?: WebMAudioChunk[];
  audioSampleRate?: number;
  channels?: number;
}

const ID = {
  EBML: "1a45dfa3",
  EBMLVersion: "4286",
  EBMLReadVersion: "42f7",
  EBMLMaxIDLength: "42f2",
  EBMLMaxSizeLength: "42f3",
  DocType: "4282",
  DocTypeVersion: "4287",
  DocTypeReadVersion: "4285",
  Segment: "18538067",
  Info: "1549a966",
  TimecodeScale: "2ad7b1",
  MuxingApp: "4d80",
  WritingApp: "5741",
  Duration: "4489",
  Tracks: "1654ae6b",
  TrackEntry: "ae",
  TrackNumber: "d7",
  TrackUID: "73c5",
  TrackType: "83",
  FlagLacing: "9c",
  CodecID: "86",
  CodecPrivate: "63a2",
  CodecDelay: "56aa",
  SeekPreRoll: "56bb",
  DefaultDuration: "23e383",
  Video: "e0",
  PixelWidth: "b0",
  PixelHeight: "ba",
  Audio: "e1",
  SamplingFrequency: "b5",
  Channels: "9f",
  Cluster: "1f43b675",
  Timecode: "e7",
  SimpleBlock: "a3",
};

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uintBytes(value: number): Uint8Array {
  let size = 1;
  while (size < 8 && value >= 2 ** (8 * size)) size += 1;
  const out = new Uint8Array(size);
  let rest = Math.max(0, Math.floor(value));
  for (let i = size - 1; i >= 0; i -= 1) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
}

function floatBytes(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, false);
  return out;
}

export function sizeVint(value: number): Uint8Array {
  let length = 1;
  while (length < 8 && value >= 2 ** (7 * length) - 1) length += 1;
  let rest = value;
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] |= 1 << (8 - length);
  return out;
}

function element(id: string, data: Uint8Array | Uint8Array[]): Uint8Array {
  const payload = Array.isArray(data) ? concat(data) : data;
  return concat([hexBytes(id), sizeVint(payload.length), payload]);
}

function uintElement(id: string, value: number): Uint8Array {
  return element(id, uintBytes(value));
}

function floatElement(id: string, value: number): Uint8Array {
  return element(id, floatBytes(value));
}

function stringElement(id: string, value: string): Uint8Array {
  return element(id, new TextEncoder().encode(value));
}

function opusHead(channels: number): Uint8Array {
  const out = new Uint8Array(19);
  out.set(new TextEncoder().encode("OpusHead"), 0);
  const view = new DataView(out.buffer);
  out[8] = 1;
  out[9] = channels;
  view.setUint16(10, 312, true);
  view.setUint32(12, 48000, true);
  view.setInt16(16, 0, true);
  out[18] = 0;
  return out;
}

function trackEntry(index: number, options: MuxOptions): Uint8Array[] {
  const entries = [
    uintElement(ID.TrackNumber, index),
    uintElement(ID.TrackUID, index),
    uintElement(ID.TrackType, index === 1 ? 1 : 2),
    uintElement(ID.FlagLacing, 0),
  ];
  if (index === 1) {
    entries.push(
      stringElement(ID.CodecID, options.videoCodec === "vp9" ? "V_VP9" : "V_VP8"),
      element(ID.Video, [
        uintElement(ID.PixelWidth, options.width),
        uintElement(ID.PixelHeight, options.height),
      ]),
      uintElement(ID.DefaultDuration, Math.round(1_000_000_000 / options.fps)),
    );
  } else {
    const channels = options.channels ?? 1;
    const sampleRate = options.audioSampleRate ?? 48000;
    entries.push(
      stringElement(ID.CodecID, "A_OPUS"),
      element(ID.CodecPrivate, opusHead(channels)),
      uintElement(ID.CodecDelay, Math.round((312 / sampleRate) * 1_000_000_000)),
      uintElement(ID.SeekPreRoll, 80_000_000),
      element(ID.Audio, [
        floatElement(ID.SamplingFrequency, sampleRate),
        uintElement(ID.Channels, channels),
      ]),
    );
  }
  return entries;
}

function simpleBlock(track: number, relativeMs: number, data: Uint8Array, key: boolean): Uint8Array {
  const header = new Uint8Array(4);
  header.set(sizeVint(track), 0);
  new DataView(header.buffer).setInt16(1, relativeMs, false);
  header[3] = key ? 0x80 : 0;
  return element(ID.SimpleBlock, concat([header, data]));
}

interface Event {
  track: 1 | 2;
  timestamp: number;
  data: Uint8Array;
  key: boolean;
}

function buildClusters(video: WebMVideoChunk[], audio: WebMAudioChunk[]): Uint8Array {
  const events: Event[] = [
    ...video.map((chunk) => ({
      track: 1 as const,
      timestamp: chunk.timestamp / 1000,
      data: chunk.data,
      key: chunk.key,
    })),
    ...audio.map((chunk) => ({
      track: 2 as const,
      timestamp: chunk.timestamp / 1000,
      data: chunk.data,
      key: true,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp || a.track - b.track);

  const clusters: Uint8Array[] = [];
  let currentTime = 0;
  let blocks: Uint8Array[] = [];
  const flush = () => {
    if (blocks.length === 0) return;
    clusters.push(element(ID.Cluster, [
      uintElement(ID.Timecode, Math.round(currentTime)),
      ...blocks,
    ]));
    blocks = [];
  };

  for (const event of events) {
    if (event.track === 1 && event.key && blocks.length > 0) {
      flush();
      currentTime = Math.round(event.timestamp);
    }
    const relative = Math.round(event.timestamp - currentTime);
    blocks.push(simpleBlock(event.track, Math.max(-32768, Math.min(32767, relative)), event.data, event.key));
  }
  flush();
  return concat(clusters);
}

export function muxWebM(
  video: WebMVideoChunk[],
  options: MuxOptions,
): Uint8Array {
  const header = element(ID.EBML, [
    uintElement(ID.EBMLVersion, 1),
    uintElement(ID.EBMLReadVersion, 1),
    uintElement(ID.EBMLMaxIDLength, 4),
    uintElement(ID.EBMLMaxSizeLength, 8),
    stringElement(ID.DocType, "webm"),
    uintElement(ID.DocTypeVersion, 4),
    uintElement(ID.DocTypeReadVersion, 2),
  ]);
  const info = element(ID.Info, [
    uintElement(ID.TimecodeScale, 1_000_000),
    stringElement(ID.MuxingApp, "PortraitCut 1.0"),
    stringElement(ID.WritingApp, "PortraitCut WebCodecs Muxer"),
    floatElement(ID.Duration, options.duration * 1000),
  ]);
  const trackEntries = [element(ID.TrackEntry, trackEntry(1, options))];
  if (options.audioChunks?.length) {
    trackEntries.push(element(ID.TrackEntry, trackEntry(2, options)));
  }
  const tracks = element(ID.Tracks, trackEntries);
  const clusters = buildClusters(video, options.audioChunks ?? []);
  const segment = element(ID.Segment, [info, tracks, clusters]);
  return concat([header, segment]);
}
