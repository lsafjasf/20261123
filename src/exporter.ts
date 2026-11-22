import { projectDuration } from "./content.ts";
import { resolveCrop } from "./crop.ts";
import { SourceRenderer } from "./draw-source.ts";
import { PortraitRenderer } from "./render-portrait.ts";
import { OUTPUT_HEIGHT, OUTPUT_WIDTH, SOURCE_HEIGHT, SOURCE_WIDTH } from "./types.ts";
import type { Project } from "./types.ts";
import { buildVtt } from "./subtitles.ts";
import { renderSoundtrack } from "./audio.ts";
import { buildDeliveryReadme, buildManifest } from "./manifest.ts";
import { muxWebM } from "./webm.ts";
import type { WebMAudioChunk, WebMVideoChunk } from "./webm.ts";
import { createZip } from "./zip.ts";

export interface ExportOptions {
  burnCaptions: boolean;
  includeAudio: boolean;
  includeReadme: boolean;
  soundtrack?: AudioBuffer | null;
  onProgress?: (progress: number, label: string) => void;
}

export interface ExportResult {
  video: Uint8Array;
  vtt: string;
  parameters: string;
  readme: string;
  zip: Uint8Array;
  duration: number;
  videoCodec: string;
  audioEncoded: boolean;
  mime: string;
}

function report(
  callback: ExportOptions["onProgress"],
  progress: number,
  label: string,
): void {
  callback?.(Math.max(0, Math.min(100, progress)), label);
}

function copyEncodedChunk(chunk: EncodedVideoChunk | EncodedAudioChunk): Uint8Array {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return data;
}

async function waitForEncoder(encoder: VideoEncoder): Promise<void> {
  while (encoder.encodeQueueSize > 6) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function encodeAudio(
  buffer: AudioBuffer,
  onProgress: ExportOptions["onProgress"],
): Promise<{ chunks: WebMAudioChunk[]; supported: boolean }> {
  if (!("AudioEncoder" in window)) return { chunks: [], supported: false };
  const config: AudioEncoderConfig = {
    codec: "opus",
    sampleRate: 48000,
    numberOfChannels: 1,
    bitrate: 64_000,
  };
  const support = await AudioEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!support.supported) return { chunks: [], supported: false };

  const chunks: WebMAudioChunk[] = [];
  let encoderError: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk) => {
      chunks.push({
        data: copyEncodedChunk(chunk),
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? 20_000,
      });
    },
    error: (error) => {
      encoderError = error;
    },
  });
  encoder.configure(config);
  const samples = buffer.getChannelData(0);
  const blockSize = 960;
  const blocks = Math.ceil(samples.length / blockSize);
  for (let block = 0; block < blocks; block += 1) {
    if (encoderError) throw encoderError;
    const start = block * blockSize;
    const count = Math.min(blockSize, samples.length - start);
    const data = new Float32Array(count);
    data.set(samples.subarray(start, start + count));
    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate: 48000,
      numberOfFrames: count,
      numberOfChannels: 1,
      timestamp: Math.round((start / 48000) * 1_000_000),
      data,
    });
    encoder.encode(audioData);
    audioData.close();
    if (block % 60 === 0) {
      report(onProgress, 6 + (block / blocks) * 22, "编码程序化声音");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  await encoder.flush();
  encoder.close();
  if (encoderError) throw encoderError;
  return { chunks, supported: true };
}

interface VideoEncodeResult {
  chunks: WebMVideoChunk[];
  codec: "vp8" | "vp9";
}

async function encodeVideo(
  project: Project,
  burnCaptions: boolean,
  onProgress: ExportOptions["onProgress"],
): Promise<VideoEncodeResult> {
  if (!("VideoEncoder" in window)) {
    throw new Error("当前浏览器不支持 WebCodecs VideoEncoder");
  }
  const candidates: Array<"vp8" | "vp9"> = ["vp8", "vp9"];
  let codec: "vp8" | "vp9" | null = null;
  for (const candidate of candidates) {
    const support = await VideoEncoder.isConfigSupported({
      codec: candidate,
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      bitrate: 6_500_000,
      framerate: project.fps,
      latencyMode: "quality",
    }).catch(() => ({ supported: false }));
    if (support.supported) {
      codec = candidate;
      break;
    }
  }
  if (!codec) throw new Error("浏览器没有可用的 VP8/VP9 编码器");

  const chunks: WebMVideoChunk[] = [];
  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      chunks.push({
        data: copyEncodedChunk(chunk),
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? Math.round(1_000_000 / project.fps),
        key: chunk.type === "key",
      });
    },
    error: (error) => {
      encoderError = error;
    },
  });
  encoder.configure({
    codec,
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    bitrate: 6_500_000,
    framerate: project.fps,
    latencyMode: "quality",
  });

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = SOURCE_WIDTH;
  sourceCanvas.height = SOURCE_HEIGHT;
  const sourceCtx = sourceCanvas.getContext("2d");
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = OUTPUT_WIDTH;
  outputCanvas.height = OUTPUT_HEIGHT;
  const outputCtx = outputCanvas.getContext("2d");
  if (!sourceCtx || !outputCtx) throw new Error("无法创建编码画布");

  const sourceRenderer = new SourceRenderer();
  const portraitRenderer = new PortraitRenderer();
  const duration = projectDuration(project);
  const totalFrames = Math.ceil(duration * project.fps);
  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    if (encoderError) throw encoderError;
    const time = frameIndex / project.fps;
    sourceRenderer.draw(sourceCtx, project, time);
    const crop = resolveCrop(project, time);
    portraitRenderer.draw(outputCtx, project, time, crop.frame, sourceCanvas, {
      captions: burnCaptions,
      guides: false,
      chrome: true,
      timecode: false,
    });
    const frame = new VideoFrame(outputCanvas, {
      timestamp: Math.round(time * 1_000_000),
      duration: Math.round(1_000_000 / project.fps),
    });
    encoder.encode(frame, { keyFrame: frameIndex % project.fps === 0 });
    frame.close();
    await waitForEncoder(encoder);
    if (frameIndex % 8 === 0) {
      report(
        onProgress,
        35 + (frameIndex / totalFrames) * 55,
        `合成竖屏帧 ${frameIndex + 1} / ${totalFrames}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  await encoder.flush();
  encoder.close();
  if (encoderError) throw encoderError;
  return { chunks, codec };
}

export async function exportProject(
  project: Project,
  options: ExportOptions,
): Promise<ExportResult> {
  const duration = projectDuration(project);
  report(options.onProgress, 2, "检测 WebCodecs 编码能力");
  let soundtrack = options.soundtrack ?? null;
  if (options.includeAudio && !soundtrack) {
    report(options.onProgress, 3, "生成 WebAudio 声音");
    try {
      soundtrack = await renderSoundtrack(project);
    } catch {
      soundtrack = null;
    }
  }
  const audio = options.includeAudio && soundtrack
    ? await encodeAudio(soundtrack, options.onProgress)
    : { chunks: [], supported: false };
  report(options.onProgress, 32, audio.supported ? "声音完成，准备视频" : "准备视频编码");
  const video = await encodeVideo(project, options.burnCaptions, options.onProgress);
  report(options.onProgress, 94, "封装 WebM 轨道");
  const audioEncoded = audio.chunks.length > 0;
  const muxed = muxWebM(video.chunks, {
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    fps: project.fps,
    duration,
    videoCodec: video.codec,
    audioChunks: audioEncoded ? audio.chunks : undefined,
    audioSampleRate: 48000,
    channels: 1,
  });
  report(options.onProgress, 97, "写入字幕与逐镜参数");
  const vtt = buildVtt(project);
  const parameters = buildManifest(project, {
    includeAudio: audioEncoded,
    burnCaptions: options.burnCaptions,
    videoCodec: `V_${video.codec.toUpperCase()}`,
    audioCodec: "A_OPUS",
  });
  const readme = buildDeliveryReadme(project);
  const encoder = new TextEncoder();
  const zipEntries = [
    { name: "portrait-master.webm", data: muxed },
    { name: "captions.zh-CN.vtt", data: encoder.encode(vtt) },
    { name: "edit-parameters.json", data: encoder.encode(parameters) },
  ];
  if (options.includeReadme) {
    zipEntries.push({ name: "README.txt", data: encoder.encode(readme) });
  }
  const zip = createZip(zipEntries);
  report(options.onProgress, 100, "交付包完成");
  return {
    video: muxed,
    vtt,
    parameters,
    readme,
    zip,
    duration,
    videoCodec: video.codec,
    audioEncoded,
    mime: audioEncoded
      ? `video/webm; codecs="${video.codec},opus"`
      : `video/webm; codecs="${video.codec}"`,
  };
}
