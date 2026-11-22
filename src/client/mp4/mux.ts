import type { Mp4File, Mp4Track } from "./reader.js";
import { box, concat, fullBox, i32, u16, u32, u64, u8, zeros } from "./bytes.js";

export interface EncodedVideoSample {
  data: Uint8Array;
  timestampUs: number;
  durationUs: number;
  isKey: boolean;
}

export interface MuxOptions {
  width: number;
  height: number;
  source: Mp4File;
  videoSamples: EncodedVideoSample[];
  videoDescription: Uint8Array;
  audioStartUs: number;
}

export interface MuxResult {
  mp4: Uint8Array;
  videoSampleCount: number;
  audioSampleCount: number;
  audioBytesPreserved: number;
  videoStartUs: number;
  audioStartUs: number;
}

const MOVIE_TIMESCALE = 1_000;
const VIDEO_TIMESCALE = 1_000_000;

function matrix(): Uint8Array {
  return concat([
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x40000000)
  ]);
}

function language(): Uint8Array {
  return u16(0x55c4);
}

function buildMvhd(duration: number, nextTrackId: number): Uint8Array {
  return fullBox(
    "mvhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(MOVIE_TIMESCALE),
    u32(duration),
    u32(0x00010000),
    u16(0x0100),
    zeros(2),
    zeros(8),
    matrix(),
    zeros(24),
    u32(nextTrackId)
  );
}

function buildTkhd(trackId: number, duration: number, width: number, height: number, audio: boolean): Uint8Array {
  return fullBox(
    "tkhd",
    0,
    3,
    u32(0),
    u32(0),
    u32(trackId),
    u32(0),
    u32(duration),
    zeros(8),
    u16(0),
    u16(0),
    u16(audio ? 0x0100 : 0),
    u16(0),
    matrix(),
    u32(width * 65536),
    u32(height * 65536)
  );
}

function buildMdhd(timescale: number, duration: number): Uint8Array {
  return fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), language(), u16(0));
}

function buildHdlr(handler: "vide" | "soun"): Uint8Array {
  const name = handler === "vide" ? "VideoHandler\0" : "SoundHandler\0";
  return fullBox("hdlr", 0, 0, u32(0), new TextEncoder().encode(handler), zeros(12), new TextEncoder().encode(name));
}

function buildDinf(): Uint8Array {
  return box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
}

function buildElst(delayMovie: number, mediaDurationMovie: number, mediaTime: number): Uint8Array {
  const entries: Uint8Array[] = [];
  if (delayMovie > 0) entries.push(u32(delayMovie), u32(0xffffffff), u32(0x00010000));
  entries.push(u32(Math.max(0, mediaDurationMovie)), i32(mediaTime), u32(0x00010000));
  return box("edts", fullBox("elst", 0, 0, u32(entries.length), ...entries));
}

function buildStts(durations: number[]): Uint8Array {
  const entries: Array<{ count: number; delta: number }> = [];
  for (const duration of durations) {
    const last = entries[entries.length - 1];
    if (last && last.delta === duration) last.count += 1;
    else entries.push({ count: 1, delta: Math.max(0, Math.round(duration)) });
  }
  return fullBox("stts", 0, 0, u32(entries.length), ...entries.flatMap((entry) => [u32(entry.count), u32(entry.delta)]));
}

function buildCtts(offsets: number[]): Uint8Array | null {
  if (offsets.every((offset) => offset === 0)) return null;
  const entries: Array<{ count: number; offset: number }> = [];
  for (const offset of offsets) {
    const last = entries[entries.length - 1];
    if (last && last.offset === offset) last.count += 1;
    else entries.push({ count: 1, offset });
  }
  const hasNegative = offsets.some((offset) => offset < 0);
  return fullBox(
    "ctts",
    hasNegative ? 1 : 0,
    0,
    u32(entries.length),
    ...entries.flatMap((entry) => [u32(entry.count), hasNegative ? i32(entry.offset) : u32(entry.offset)])
  );
}

function buildStss(keyframes: boolean[]): Uint8Array | null {
  const indexes = keyframes.map((key, index) => (key ? index + 1 : 0)).filter(Boolean);
  if (indexes.length === keyframes.length) return null;
  return fullBox("stss", 0, 0, u32(indexes.length), ...indexes.map((index) => u32(index)));
}

function buildStbl(
  sampleEntry: Uint8Array,
  sizeList: number[],
  chunkOffsets: number[],
  durations: number[],
  cttsOffsets: number[] | null,
  keyframes: boolean[] | null
): Uint8Array {
  const ctts = cttsOffsets ? buildCtts(cttsOffsets) : null;
  const stss = keyframes ? buildStss(keyframes) : null;
  const use64 = chunkOffsets.some((offset) => offset > 0xffffffff);
  const chunks = use64
    ? fullBox("co64", 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map((offset) => u64(offset)))
    : fullBox("stco", 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map((offset) => u32(offset)));
  const parts = [
    fullBox("stsd", 0, 0, u32(1), sampleEntry),
    buildStts(durations),
    ...(ctts ? [ctts] : []),
    ...(stss ? [stss] : []),
    fullBox("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1)),
    fullBox("stsz", 0, 0, u32(0), u32(sizeList.length), ...sizeList.map((size) => u32(size))),
    chunks
  ];
  return box("stbl", ...parts);
}

function buildAvc1(width: number, height: number, description: Uint8Array): Uint8Array {
  const compressor = new Uint8Array(32);
  const text = new TextEncoder().encode("Framelock AVC");
  compressor[0] = Math.min(31, text.length);
  compressor.set(text.slice(0, 31), 1);
  const avcC = box("avcC", description);
  return box(
    "avc1",
    zeros(6),
    u16(1),
    u16(0),
    u16(0),
    zeros(12),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    compressor,
    u16(0x0018),
    u16(0xffff),
    avcC
  );
}

function buildVideoTrak(
  trackId: number,
  width: number,
  height: number,
  timescale: number,
  durations: number[],
  sizes: number[],
  offsets: number[],
  keyframes: boolean[],
  cttsOffsets: number[],
  delayMovie: number,
  description: Uint8Array
): Uint8Array {
  const mediaDuration = durations.reduce((sum, value) => sum + value, 0);
  const mediaDurationMovie = Math.round((mediaDuration / timescale) * MOVIE_TIMESCALE);
  const totalDurationMovie = delayMovie + mediaDurationMovie;
  const entry = buildAvc1(width, height, description);
  const stbl = buildStbl(entry, sizes, offsets, durations, cttsOffsets, keyframes);
  return box(
    "trak",
    buildTkhd(trackId, totalDurationMovie, width, height, false),
    box("edts", buildElst(delayMovie, mediaDurationMovie, 0)),
    box(
      "mdia",
      buildMdhd(timescale, mediaDuration),
      buildHdlr("vide"),
      box("minf", fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0)), buildDinf(), stbl)
    )
  );
}

function buildAudioTrak(
  trackId: number,
  source: Mp4Track,
  offsets: number[],
  delayMovie: number
): Uint8Array {
  if (!source.sampleEntry) throw new Error("源音频缺少 mp4a sample entry");
  const durations = source.samples.map((sample) => sample.duration);
  const sizes = source.samples.map((sample) => sample.size);
  const compositionOffsets = source.samples.map((sample) => sample.cts - sample.dts);
  const mediaDuration = durations.reduce((sum, value) => sum + value, 0);
  const mediaDurationMovie =
    source.editDurationMovie ?? Math.round((mediaDuration / source.timescale) * MOVIE_TIMESCALE);
  const totalDurationMovie = delayMovie + mediaDurationMovie;
  const stbl = buildStbl(source.sampleEntry, sizes, offsets, durations, compositionOffsets, null);
  return box(
    "trak",
    buildTkhd(trackId, totalDurationMovie, 0, 0, true),
    box("edts", buildElst(delayMovie, mediaDurationMovie, source.editMediaTime)),
    box(
      "mdia",
      buildMdhd(source.timescale, mediaDuration),
      buildHdlr("soun"),
      box("minf", fullBox("smhd", 0, 0, u16(0), u16(0)), buildDinf(), stbl)
    )
  );
}

function ftyp(): Uint8Array {
  return box("ftyp", new TextEncoder().encode("isom"), u32(512), new TextEncoder().encode("isomiso6mp41avc1"));
}

export function muxMp4(options: MuxOptions): MuxResult {
  const { source, width, height, videoSamples } = options;
  if (videoSamples.length === 0) throw new Error("没有可封装的视频帧");
  const ordered = videoSamples;
  const videoStartUs = Math.min(...ordered.map((sample) => sample.timestampUs));
  const videoDurations = ordered.map((sample) => Math.max(1, Math.round(sample.durationUs)));

  const audio = source.audio;
  const videoDelayMovie = Math.max(0, Math.round((videoStartUs / 1_000_000) * MOVIE_TIMESCALE));
  const audioDelayMovie = audio
    ? Math.max(0, Math.round((options.audioStartUs / 1_000_000) * MOVIE_TIMESCALE))
    : 0;

  const audioData = audio
    ? audio.samples.map((sample) => source.bytes.slice(sample.offset, sample.offset + sample.size))
    : [];
  const videoData = ordered.map((sample) => sample.data);

  const head = ftyp();
  const mdatDataStart = head.length + 8;
  let cursor = mdatDataStart;
  const videoOffsets: number[] = [];
  for (const sample of videoData) {
    videoOffsets.push(cursor);
    cursor += sample.length;
  }
  const audioOffsets: number[] = [];
  for (const sample of audioData) {
    audioOffsets.push(cursor);
    cursor += sample.length;
  }
  const mdat = box("mdat", ...videoData, ...audioData);

  const videoTimescale = VIDEO_TIMESCALE;
  const videoDurationsTicks = videoDurations.map((value) => Math.max(1, Math.round(value)));
  const videoCttsOffsets: number[] = [];
  let videoDts = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const sample = ordered[index];
    const presentationUs = sample.timestampUs - videoStartUs;
    videoCttsOffsets.push(Math.round(presentationUs - videoDts));
    videoDts += videoDurationsTicks[index];
  }
  const videoTotalTicks = videoDurationsTicks.reduce((sum, value) => sum + value, 0);
  const videoTrak = buildVideoTrak(
    1,
    width,
    height,
    videoTimescale,
    videoDurationsTicks,
    videoData.map((sample) => sample.length),
    videoOffsets,
    ordered.map((sample) => sample.isKey),
    videoCttsOffsets,
    videoDelayMovie,
    options.videoDescription
  );
  const tracks = [videoTrak];
  if (audio && audioData.length > 0) tracks.push(buildAudioTrak(2, audio, audioOffsets, audioDelayMovie));

  const videoDurationMovie = Math.round((videoTotalTicks / videoTimescale) * MOVIE_TIMESCALE);
  const audioDurationMovie = audio
    ? Math.round((audio.samples.reduce((sum, sample) => sum + sample.duration, 0) / audio.timescale) * MOVIE_TIMESCALE)
    : 0;
  const movieDuration = Math.max(videoDelayMovie + videoDurationMovie, audioDelayMovie + audioDurationMovie);
  const moov = box("moov", buildMvhd(movieDuration, tracks.length + 1), ...tracks);
  const output = concat([head, mdat, moov]);

  return {
    mp4: output,
    videoSampleCount: videoData.length,
    audioSampleCount: audioData.length,
    audioBytesPreserved: audioData.reduce((sum, sample) => sum + sample.length, 0),
    videoStartUs: videoDelayMovie * 1_000,
    audioStartUs: audioDelayMovie * 1_000
  };
}
