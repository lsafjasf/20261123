// WebCodecs decode pipeline: decodes the samples covering [startSec, endSec]
// (from the nearest keyframe at/before startSec) into VideoFrames and PCM.
import {
  demux, samplesForRange, extractSample,
  type DemuxResult, type Sample,
} from "../shared/mp4.ts";

export interface DecodedSegment {
  frames: VideoFrame[];          // presentation order, only frames in range
  frameDurations: number[];      // seconds, parallel to frames
  pcm: Float32Array[];           // planar, reversed-ready
  sampleRate: number;
  videoTimescaleNote: string;
}

export function parseMp4(buf: ArrayBuffer): DemuxResult {
  return demux(new Uint8Array(buf));
}

function chunkOf(data: Uint8Array, s: Sample): EncodedVideoChunk {
  return new EncodedVideoChunk({
    type: s.keyframe ? "key" : "delta",
    timestamp: Math.round(s.cts * 1e6),
    duration: Math.round(s.duration * 1e6),
    data: extractSample(data, s),
  });
}

async function decodeVideo(
  d: DemuxResult, startSec: number, endSec: number,
): Promise<{ frames: VideoFrame[]; durations: number[] }> {
  const track = d.video;
  if (!track) throw new Error("no video track");
  const samples = samplesForRange(track, startSec, endSec);
  if (samples.length === 0) throw new Error("empty video range");
  const out: VideoFrame[] = [];
  const decoder = new VideoDecoder({
    output: frame => {
      if (frame.timestamp >= Math.round(startSec * 1e6) - 1 &&
          frame.timestamp < Math.round(endSec * 1e6)) {
        out.push(frame);
      } else {
        frame.close();
      }
    },
    error: e => { throw e; },
  });
  const config: VideoDecoderConfig = { codec: track.codec };
  if (track.codecDescription) config.description = track.codecDescription;
  decoder.configure(config);
  for (const s of samples) decoder.decode(chunkOf(d.data, s));
  await decoder.flush();
  decoder.close();
  out.sort((a, b) => a.timestamp - b.timestamp);
  const durations = out.map((f, i) =>
    i + 1 < out.length
      ? (out[i + 1].timestamp - f.timestamp) / 1e6
      : (f.duration ?? 33333) / 1e6);
  return { frames: out, durations };
}

async function decodeAudio(
  d: DemuxResult, startSec: number, endSec: number,
): Promise<{ pcm: Float32Array[]; sampleRate: number }> {
  const track = d.audio;
  if (!track) return { pcm: [], sampleRate: 48000 };
  const samples = samplesForRange(track, startSec, endSec);
  const chunks: AudioData[] = [];
  const decoder = new AudioDecoder({
    output: ad => chunks.push(ad),
    error: e => { throw e; },
  });
  decoder.configure({
    codec: track.codec,
    sampleRate: track.sampleRate,
    numberOfChannels: track.channelCount,
  });
  for (const s of samples) {
    decoder.decode(new EncodedAudioChunk({
      type: "key",
      timestamp: Math.round(s.cts * 1e6),
      duration: Math.round(s.duration * 1e6),
      data: extractSample(d.data, s),
    }));
  }
  await decoder.flush();
  decoder.close();
  chunks.sort((a, b) => a.timestamp - b.timestamp);
  const channels = track.channelCount || 1;
  const rate = track.sampleRate;
  const startFrame = Math.floor(startSec * rate);
  const endFrame = Math.ceil(endSec * rate);
  const pcm = Array.from({ length: channels }, () => new Float32Array(endFrame - startFrame));
  for (const ad of chunks) {
    const base = Math.round(ad.timestamp / 1e6 * rate) - startFrame;
    const planar = !ad.format || ad.format.endsWith("-planar");
    const outCh = planar ? channels : 1;
    for (let c = 0; c < channels; c++) {
      const n = ad.numberOfFrames;
      const tmp = new Float32Array(
        ad.allocationSize({ planeIndex: planar ? c : 0, format: "f32" }) / 4);
      ad.copyTo(tmp, { planeIndex: planar ? c : 0, format: "f32" });
      const dst = pcm[c];
      for (let i = 0; i < n; i++) {
        const pos = base + i;
        if (pos >= 0 && pos < dst.length) dst[pos] = tmp[i * outCh + (planar ? 0 : c)];
      }
    }
    ad.close();
  }
  return { pcm, sampleRate: rate };
}

export async function decodeSegment(
  d: DemuxResult, startSec: number, endSec: number,
): Promise<DecodedSegment> {
  const [video, audio] = await Promise.all([
    decodeVideo(d, startSec, endSec),
    decodeAudio(d, startSec, endSec),
  ]);
  return {
    frames: video.frames,
    frameDurations: video.durations,
    pcm: audio.pcm,
    sampleRate: audio.sampleRate,
    videoTimescaleNote: `${d.video!.samples.length} samples @ ${d.video!.timescale}Hz`,
  };
}
