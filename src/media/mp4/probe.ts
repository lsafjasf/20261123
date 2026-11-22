import { Rational } from "../../time/rational.ts";
import {
  type Mp4Box,
  asSeconds,
  child,
  children,
  fullBoxVersion,
  path,
  readAscii,
  readBoxes,
  readUint64,
} from "./boxes.ts";

export interface Mp4EditEntry {
  segmentDuration: Rational;
  mediaTime: Rational | null;
  rate: Rational;
}

export interface Mp4TrackTiming {
  trackId: bigint;
  handler: "video" | "audio" | "other";
  timescale: bigint;
  durationTicks: bigint;
  duration: Rational;
  sampleCount: bigint;
  frameRate?: Rational;
  frameDuration?: Rational;
  variableFrameRate: boolean;
  audioSampleRate?: Rational;
  edits: Mp4EditEntry[];
}

export interface Mp4Timing {
  movieTimescale: bigint;
  duration: Rational;
  tracks: Mp4TrackTiming[];
}

interface HeaderTiming {
  timescale: bigint;
  durationTicks: bigint;
}

function readHeaderTiming(box: Mp4Box): HeaderTiming {
  const version = fullBoxVersion(box);
  const timescaleOffset = version === 1 ? 20 : 12;
  const timescale = BigInt(box.view.getUint32(box.payloadStart + timescaleOffset));
  const durationTicks =
    version === 1
      ? readUint64(box.view, box.payloadStart + timescaleOffset + 4)
      : BigInt(box.view.getUint32(box.payloadStart + timescaleOffset + 4));
  return { timescale, durationTicks };
}

function readTrackId(trak: Mp4Box): bigint {
  const tkhd = child(trak, "tkhd");
  if (!tkhd) return 0n;
  const version = fullBoxVersion(tkhd);
  return version === 1
    ? readUint64(tkhd.view, tkhd.payloadStart + 20)
    : BigInt(tkhd.view.getUint32(tkhd.payloadStart + 12));
}

function readHandler(trak: Mp4Box): Mp4TrackTiming["handler"] {
  const hdlr = path(trak, "mdia", "hdlr");
  if (!hdlr) return "other";
  const value = readAscii(hdlr.view, hdlr.payloadStart + 8, 4);
  if (value === "vide") return "video";
  if (value === "soun") return "audio";
  return "other";
}

function readStts(
  trak: Mp4Box,
  timescale: bigint,
): Pick<Mp4TrackTiming, "sampleCount" | "frameRate" | "frameDuration" | "variableFrameRate"> {
  const stts = path(trak, "mdia", "minf", "stbl", "stts");
  if (!stts) {
    return {
      sampleCount: 0n,
      variableFrameRate: false,
    };
  }
  const entryCount = stts.view.getUint32(stts.payloadStart + 4);
  let cursor = stts.payloadStart + 8;
  let sampleCount = 0n;
  let firstDelta = 0n;
  let variable = false;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 8 > stts.end) throw new RangeError("truncated MP4 stts box");
    const count = BigInt(stts.view.getUint32(cursor));
    const delta = BigInt(stts.view.getUint32(cursor + 4));
    sampleCount += count;
    if (index === 0) firstDelta = delta;
    else if (delta !== firstDelta) variable = true;
    cursor += 8;
  }
  if (firstDelta === 0n || variable || sampleCount === 0n) {
    return { sampleCount, variableFrameRate: variable };
  }
  return {
    sampleCount,
    variableFrameRate: false,
    frameRate: Rational.of(timescale, firstDelta),
    frameDuration: Rational.of(firstDelta, timescale),
  };
}

function readAudioSampleRate(trak: Mp4Box): Rational | undefined {
  const stsd = path(trak, "mdia", "minf", "stbl", "stsd");
  if (!stsd || stsd.payloadStart + 16 > stsd.end) return undefined;
  const entryStart = stsd.payloadStart + 8;
  if (entryStart + 36 > stsd.end) return undefined;
  const sampleRateFixed = stsd.view.getUint32(entryStart + 32);
  if (sampleRateFixed === 0) return undefined;
  return Rational.of(BigInt(sampleRateFixed), 65_536n);
}

function readEdits(trak: Mp4Box, movieTimescale: bigint, mediaTimescale: bigint): Mp4EditEntry[] {
  const elst = path(trak, "edts", "elst");
  if (!elst) return [];
  const version = fullBoxVersion(elst);
  const entryCount = elst.view.getUint32(elst.payloadStart + 4);
  let cursor = elst.payloadStart + 8;
  const edits: Mp4EditEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const size = version === 1 ? 20 : 12;
    if (cursor + size > elst.end) throw new RangeError("truncated MP4 elst box");
    const durationTicks =
      version === 1
        ? readUint64(elst.view, cursor)
        : BigInt(elst.view.getUint32(cursor));
    const mediaTimeRaw =
      version === 1
        ? elst.view.getBigInt64(cursor + 8)
        : BigInt(elst.view.getInt32(cursor + 4));
    const rateCursor = cursor + (version === 1 ? 16 : 8);
    const rateInteger = elst.view.getInt16(rateCursor);
    const rateFraction = elst.view.getInt16(rateCursor + 2);
    const rateNumerator = BigInt(rateInteger) * 65_536n + BigInt(rateFraction);
    edits.push({
      segmentDuration: asSeconds(durationTicks, movieTimescale),
      mediaTime: mediaTimeRaw < 0n ? null : asSeconds(mediaTimeRaw, mediaTimescale),
      rate: Rational.of(rateNumerator, 65_536n),
    });
    cursor += size;
  }
  return edits;
}

function readTrack(trak: Mp4Box, movieTimescale: bigint): Mp4TrackTiming {
  const mdhd = path(trak, "mdia", "mdhd");
  if (!mdhd) throw new RangeError("MP4 track is missing mdhd");
  const header = readHeaderTiming(mdhd);
  const handler = readHandler(trak);
  const stts = readStts(trak, header.timescale);
  const audioSampleRate =
    handler === "audio"
      ? (readAudioSampleRate(trak) ?? Rational.of(header.timescale))
      : undefined;
  return {
    trackId: readTrackId(trak),
    handler,
    timescale: header.timescale,
    durationTicks: header.durationTicks,
    duration: asSeconds(header.durationTicks, header.timescale),
    sampleCount: stts.sampleCount,
    frameRate: handler === "video" ? stts.frameRate : undefined,
    frameDuration: handler === "video" ? stts.frameDuration : undefined,
    variableFrameRate: handler === "video" ? stts.variableFrameRate : false,
    audioSampleRate,
    edits: readEdits(trak, movieTimescale, header.timescale),
  };
}

export function probeMp4Timing(input: ArrayBufferLike | ArrayBufferView): Mp4Timing {
  const view = ArrayBuffer.isView(input)
    ? new DataView(input.buffer, input.byteOffset, input.byteLength)
    : new DataView(input);
  const top = readBoxes(view);
  const moov = top.find((box) => box.type === "moov");
  if (!moov) throw new RangeError("MP4 is missing moov box");
  const mvhd = child(moov, "mvhd");
  if (!mvhd) throw new RangeError("MP4 is missing mvhd box");
  const movieHeader = readHeaderTiming(mvhd);
  const tracks = children(moov, "trak").map((trak) => readTrack(trak, movieHeader.timescale));
  return {
    movieTimescale: movieHeader.timescale,
    duration: asSeconds(movieHeader.durationTicks, movieHeader.timescale),
    tracks,
  };
}
