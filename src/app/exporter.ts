// Export pipeline: re-encodes the reversed frame sequence with VideoEncoder,
// muxes a fragmented MP4, previews it through MediaSource, and builds the
// JSON report (original range, output frame order, A/V error).
import { initSegment, mediaSegment, concatSegments, type MuxSample } from "./mux.ts";
import type { ReversePlan } from "../shared/timeline.ts";
import { encodeWav } from "../shared/wav.ts";

export interface ExportResult {
  init: Uint8Array;
  media: Uint8Array;
  mp4: Uint8Array;
  wav: Uint8Array;
  report: ExportReport;
}

export interface ExportReport {
  generatedAt: string;
  source: { name: string; durationSec: number };
  originalRange: { startSec: number; endSec: number };
  output: { frameCount: number; durationSec: number; videoTimescale: number };
  frameOrder: Array<{
    outputIndex: number;
    outputTimeSec: number;
    sourceCtsSec: number;
    sourceDurationSec: number;
    keyframe: boolean;
  }>;
  avError: {
    planned: { maxAbsMs: number; meanAbsMs: number; rmsMs: number; perFrameMs: number[] };
    measuredPlayback: { count: number; maxAbsMs: number; meanAbsMs: number };
  };
}

const TIMESCALE = 90000;

async function encodeReversed(
  frames: VideoFrame[], plan: ReversePlan, codec: string,
  width: number, height: number,
): Promise<{ init: Uint8Array; media: Uint8Array }> {
  const chunks: EncodedVideoChunk[] = [];
  let description: Uint8Array | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      chunks.push(chunk);
      const desc = (meta?.decoderConfig as VideoDecoderConfig | undefined)?.description;
      if (desc && !description) {
        description = new Uint8Array(desc as ArrayBuffer);
      }
    },
    error: e => { throw e; },
  });
  encoder.configure({
    codec,
    width,
    height,
    framerate: 30,
    avc: { format: "avc" },
    latencyMode: "quality",
  } as VideoEncoderConfig);
  for (let i = 0; i < frames.length; i++) {
    const f = plan.frames[i];
    encoder.encode(frames[i], {
      timestamp: Math.round(f.outputTime * 1e6),
      duration: Math.round(f.sourceDuration * 1e6),
      keyFrame: i === 0,
    });
  }
  await encoder.flush();
  encoder.close();
  if (!description) throw new Error("encoder did not provide avcC description");
  // Encode order == decode order; dts is cumulative, cts offset = pts - dts.
  let dtsAcc = 0;
  const samples: MuxSample[] = chunks.map((c, i) => {
    const data = new Uint8Array(c.byteLength);
    c.copyTo(data);
    const duration = Math.round(plan.frames[i].sourceDuration * TIMESCALE);
    const s: MuxSample = {
      data,
      duration,
      ctsOffset: Math.round(plan.frames[i].outputTime * TIMESCALE) - dtsAcc,
      keyframe: c.type === "key",
    };
    dtsAcc += s.duration;
    return s;
  });
  const init = initSegment({
    codec, width, height, timescale: TIMESCALE,
    description: description as unknown as Uint8Array,
  });
  const media = mediaSegment(samples, 0);
  return { init, media };
}

export async function exportSegment(opts: {
  sourceName: string;
  sourceDurationSec: number;
  codec: string;
  width: number;
  height: number;
  plan: ReversePlan;
  outputFrames: VideoFrame[];
  pcmReversed: Float32Array[];
  sampleRate: number;
  measuredAv: { count: number; maxAbsMs: number; meanAbsMs: number };
}): Promise<ExportResult> {
  const { init, media } = await encodeReversed(
    opts.outputFrames, opts.plan, opts.codec, opts.width, opts.height);
  const mp4 = concatSegments(init, media);
  const wav = encodeWav(opts.pcmReversed, opts.sampleRate);
  const report: ExportReport = {
    generatedAt: new Date().toISOString(),
    source: { name: opts.sourceName, durationSec: opts.sourceDurationSec },
    originalRange: { startSec: opts.plan.startSec, endSec: opts.plan.endSec },
    output: {
      frameCount: opts.plan.frames.length,
      durationSec: opts.plan.totalDuration,
      videoTimescale: TIMESCALE,
    },
    frameOrder: opts.plan.frames.map(f => ({
      outputIndex: f.outputIndex,
      outputTimeSec: f.outputTime,
      sourceCtsSec: f.sourceCts,
      sourceDurationSec: f.sourceDuration,
      keyframe: f.keyframe,
    })),
    avError: {
      planned: opts.plan.avError,
      measuredPlayback: opts.measuredAv,
    },
  };
  return { init, media, mp4, wav, report };
}

// Plays the exported MP4 in a <video> element via MediaSource.
export function previewWithMediaSource(
  video: HTMLVideoElement, init: Uint8Array, media: Uint8Array, codec: string,
): void {
  const ms = new MediaSource();
  video.src = URL.createObjectURL(ms);
  ms.addEventListener("sourceopen", () => {
    const sb = ms.addSourceBuffer(`video/mp4; codecs="${codec}"`);
    sb.appendBuffer(init as unknown as BufferSource);
    sb.addEventListener("updateend", () => {
      sb.appendBuffer(media as unknown as BufferSource);
      sb.addEventListener("updateend", () => ms.endOfStream(), { once: true });
    }, { once: true });
  }, { once: true });
}
