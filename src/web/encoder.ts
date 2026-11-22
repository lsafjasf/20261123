import type { Project, VideoConfig } from "../shared/types.ts";
import { WebMMuxer, type MuxerCodec } from "../shared/webm-muxer.ts";
import type { AudioBundle } from "./audio.ts";

export interface EncodeProgress {
  frame: number;
  totalFrames: number;
  phase: "video" | "audio" | "mux";
}

function codecString(codec: VideoConfig["codec"]): string {
  if (codec === "vp8") {
    return "vp8";
  }
  if (codec === "av1") {
    return "av01.0.04M.08";
  }
  return "vp09.00.10.08";
}

async function pickVideoCodec(preferred: VideoConfig["codec"]): Promise<MuxerCodec> {
  const candidates: MuxerCodec[] = preferred === "vp8"
    ? ["vp8", "vp9"]
    : preferred === "av1"
      ? ["av1", "vp9", "vp8"]
      : ["vp9", "vp8"];
  const support = await Promise.all(
    candidates.map(async (codec) => ({
      codec,
      supported: (await VideoEncoder.isConfigSupported({
        codec: codecString(codec),
        width: 640,
        height: 360,
        bitrate: 1_000_000,
      })).supported,
    })),
  );
  const match = support.find((item) => item.supported);
  if (!match) {
    throw new Error("no supported WebCodecs video codec found");
  }
  return match.codec;
}

function frameFromCanvas(canvas: HTMLCanvasElement, timestampMicroseconds: number): VideoFrame {
  return new VideoFrame(canvas, { timestamp: timestampMicroseconds });
}

export interface EncodeOptions {
  project: Project;
  canvas: HTMLCanvasElement;
  render: (time: number) => void;
  durationSeconds: number;
  audio?: AudioBundle;
  onProgress?: (progress: EncodeProgress) => void;
  signal?: { cancelled: boolean };
}

export async function encodeVideo(options: EncodeOptions): Promise<{ bytes: Uint8Array; codec: MuxerCodec }> {
  const { project, canvas, render, audio, onProgress, signal } = options;
  const config = project.video;
  const codec = await pickVideoCodec(config.codec);
  const muxer = new WebMMuxer([
    {
      kind: "video",
      number: 1,
      codec,
      video: { ...config, codec: codec === "vp8" ? "vp8" : codec === "av1" ? "av1" : "vp9" },
    },
    ...(audio
      ? [{ kind: "audio" as const, number: 2, sampleRate: audio.sampleRate, channels: audio.channels }]
      : []),
  ]);

  const encodedChunks: EncodedVideoChunk[] = [];
  let encoderError: Error | undefined;
  const videoEncoder = new VideoEncoder({
    output: (chunk) => {
      encodedChunks.push(chunk);
    },
    error: (error) => {
      encoderError = error;
    },
  });
  videoEncoder.configure({
    codec: codecString(codec),
    width: config.width,
    height: config.height,
    bitrate: config.bitrate,
    framerate: config.fps,
    latencyMode: "quality",
  });

  return await new Promise<{ bytes: Uint8Array; codec: MuxerCodec }>((resolve, reject) => {
    const durationSeconds = options.durationSeconds;
    const targetFrames = Math.max(1, Math.ceil(durationSeconds * config.fps));
    let frameIndex = 0;

    const fail = (error: Error) => {
      try {
        videoEncoder.close();
      } catch {
        // encoder may already be closed
      }
      reject(error);
    };

    const pump = () => {
      try {
        if (encoderError) {
          fail(encoderError);
          return;
        }
        if (signal?.cancelled) {
          videoEncoder.close();
          reject(new Error("export cancelled"));
          return;
        }
        while (frameIndex < targetFrames && videoEncoder.encodeQueueSize < 6) {
          const time = frameIndex / config.fps;
          render(time);
          const frame = frameFromCanvas(canvas, Math.round(time * 1_000_000));
          videoEncoder.encode(frame, { keyFrame: frameIndex % (config.fps * 2) === 0 });
          frame.close();
          frameIndex += 1;
          onProgress?.({ frame: frameIndex, totalFrames: targetFrames, phase: "video" });
        }
        if (frameIndex >= targetFrames) {
          videoEncoder.flush().then(async () => {
            for (const chunk of encodedChunks) {
              const data = new Uint8Array(chunk.byteLength);
              chunk.copyTo(data);
              muxer.addFrame({
                trackNumber: 1,
                timestampMs: chunk.timestamp / 1000,
                data,
                keyframe: chunk.type === "key",
              });
            }
            if (audio) {
              await encodeAudio(audio, muxer, onProgress);
            }
            onProgress?.({ frame: targetFrames, totalFrames: targetFrames, phase: "mux" });
            resolve({ bytes: muxer.build(), codec });
          }).catch(fail);
          return;
        }
        setTimeout(pump, 0);
      } catch (error) {
        fail(error as Error);
      }
    };
    pump();
  });
}

async function encodeAudio(
  audio: AudioBundle,
  muxer: WebMMuxer,
  onProgress?: (progress: EncodeProgress) => void,
): Promise<void> {
  const frameDuration = 20;
  const samplesPerFrame = Math.round((audio.sampleRate * frameDuration) / 1000);
  const chunks: EncodedAudioChunk[] = [];
  let encoderError: Error | undefined;
  const encoder = new AudioEncoder({
    output: (chunk) => chunks.push(chunk),
    error: (error) => {
      encoderError = error;
    },
  });
  encoder.configure({
    codec: "opus",
    sampleRate: audio.sampleRate,
    numberOfChannels: audio.channels,
    bitrate: 96_000,
  });

  let offset = 0;
  let frameIndex = 0;
  while (offset < audio.length) {
    if (encoderError) {
      encoder.close();
      throw encoderError;
    }
    const count = Math.min(samplesPerFrame, audio.length - offset);
    const buffer = new AudioData({
      format: "f32-planar",
      sampleRate: audio.sampleRate,
      numberOfFrames: count,
      numberOfChannels: audio.channels,
      timestamp: Math.round((offset / audio.sampleRate) * 1_000_000),
      data: copyPlanar(audio.buffer, offset, count, audio.channels),
    });
    encoder.encode(buffer);
    buffer.close();
    offset += count;
    frameIndex += 1;
  }
  await encoder.flush();
  if (encoderError) {
    throw encoderError;
  }
  encoder.close();
  for (const chunk of chunks) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    muxer.addFrame({
      trackNumber: 2,
      timestampMs: chunk.timestamp / 1000,
      data,
      keyframe: false,
    });
  }
  onProgress?.({ frame: frameIndex, totalFrames: frameIndex, phase: "audio" });
}

function copyPlanar(
  source: AudioBuffer,
  offset: number,
  count: number,
  channels: number,
): Uint8Array {
  const bytesPerSample = 4;
  const out = new Uint8Array(count * channels * bytesPerSample);
  const view = new DataView(out.buffer);
  for (let channel = 0; channel < channels; channel += 1) {
    const input = source.getChannelData(channel);
    for (let i = 0; i < count; i += 1) {
      view.setFloat32((channel * count + i) * bytesPerSample, input[offset + i], true);
    }
  }
  return out;
}
