import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, renderSegmentAudio } from "./audio.js";
import { drawTrainingFrame, VIDEO_HEIGHT, VIDEO_WIDTH } from "./artwork.js";
import { encryptSegment, sha256Base64Url, toBytes } from "./crypto.js";
import { clearSegments, putSegment } from "./db.js";
import { ControlledPlaybackError } from "./errors.js";
import type { CachedSegment, Manifest } from "./types.js";
import { buildInitSegment, buildMediaCluster, type MuxFrame } from "./webm.js";

const FPS = 24;

export interface SegmentKeyMaterial {
  contentKey: CryptoKey;
  keyFingerprint: string;
}

export interface GenerationProgress {
  phase: "check" | "audio" | "video" | "encrypt" | "commit";
  completed: number;
  total: number;
  label: string;
}

export interface GeneratedMedia {
  initSegment: ArrayBuffer;
  initSha256: string;
  segments: CachedSegment[];
  generatedAt: number;
}

function segmentStartMs(manifest: Manifest, index: number): number {
  return manifest.segments.slice(0, index).reduce((total, segment) => total + segment.durationMs, 0);
}

function segmentIndexForTimestamp(manifest: Manifest, timestampUs: number): number {
  const milliseconds = timestampUs / 1000;
  let start = 0;
  for (let index = 0; index < manifest.segments.length; index += 1) {
    const segment = manifest.segments[index];
    if (!segment) {
      break;
    }
    if (milliseconds < start + segment.durationMs) {
      return index;
    }
    start += segment.durationMs;
  }
  return Math.max(0, manifest.segments.length - 1);
}

function waitForEncoderQueue(encoder: VideoEncoder): Promise<void> {
  if (encoder.encodeQueueSize < 8) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const check = () => {
      if (encoder.encodeQueueSize < 8) {
        encoder.removeEventListener("dequeue", check);
        resolve();
      }
    };
    encoder.addEventListener("dequeue", check);
    check();
  });
}

function makeCanvas(): { canvas: OffscreenCanvas | HTMLCanvasElement; context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("Canvas 2D context unavailable");
    }
    return { canvas, context };
  }
  const canvas = document.createElement("canvas");
  canvas.width = VIDEO_WIDTH;
  canvas.height = VIDEO_HEIGHT;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Canvas 2D context unavailable");
  }
  return { canvas, context };
}

function assertWebCodecs(): void {
  const missing = [
    typeof VideoEncoder === "undefined" ? "VideoEncoder" : "",
    typeof AudioEncoder === "undefined" ? "AudioEncoder" : "",
    typeof VideoFrame === "undefined" ? "VideoFrame" : "",
    typeof AudioData === "undefined" ? "AudioData" : "",
    typeof MediaSource === "undefined" ? "MediaSource" : "",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ControlledPlaybackError({
      code: "UNSUPPORTED_API",
      title: "浏览器缺少受控播放能力",
      guidance: "请使用最新版 Chrome 或 Edge，并确认 WebCodecs 可用。",
      technical: `Missing: ${missing.join(", ")}`,
    });
  }
}

function frameToBytes(chunk: EncodedVideoChunk | EncodedAudioChunk): Uint8Array {
  const bytes = new Uint8Array(chunk.byteLength);
  chunk.copyTo(bytes);
  return bytes;
}

async function encodeAudioSegment(
  encoder: AudioEncoder,
  samples: Float32Array,
  startUs: number,
): Promise<void> {
  const blockSize = 960;
  for (let offset = 0; offset < samples.length; offset += blockSize) {
    const block = samples.subarray(offset, Math.min(samples.length, offset + blockSize));
    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfFrames: block.length,
      numberOfChannels: AUDIO_CHANNELS,
      timestamp: Math.round(startUs + (offset / AUDIO_SAMPLE_RATE) * 1_000_000),
      data: block.slice(),
    });
    encoder.encode(audioData);
    audioData.close();
    if (encoder.encodeQueueSize > 16) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return Promise.resolve();
}

export async function generateAndCacheMedia(
  manifest: Manifest,
  keyMaterials: Map<string, SegmentKeyMaterial>,
  onProgress: (progress: GenerationProgress) => void,
): Promise<GeneratedMedia> {
  assertWebCodecs();
  onProgress({ phase: "check", completed: 0, total: 1, label: "检查 WebCodecs / MediaSource 支持" });

  const videoConfig: VideoEncoderConfig = {
    codec: "vp8",
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    bitrate: 1_400_000,
    framerate: FPS,
    latencyMode: "quality",
  };
  const audioConfig: AudioEncoderConfig = {
    codec: "opus",
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: 48_000,
  };
  const [videoSupport, audioSupport] = await Promise.all([
    VideoEncoder.isConfigSupported(videoConfig),
    AudioEncoder.isConfigSupported(audioConfig),
  ]);
  if (!videoSupport.supported || !audioSupport.supported) {
    throw new ControlledPlaybackError({
      code: "UNSUPPORTED_API",
      title: "编码器配置不可用",
      guidance: "当前浏览器无法生成 VP8/Opus 演示媒体。请更换 Chrome 或 Edge。",
      technical: `VP8=${videoSupport.supported}, Opus=${audioSupport.supported}`,
    });
  }

  const { canvas, context } = makeCanvas();
  const videoChunks = new Map<number, EncodedVideoChunk[]>();
  const audioChunks = new Map<number, EncodedAudioChunk[]>();
  let opusHead: Uint8Array | null = null;
  let callbackFailure: unknown = null;

  const videoEncoder = new VideoEncoder({
    output(chunk) {
      const index = segmentIndexForTimestamp(manifest, chunk.timestamp);
      const list = videoChunks.get(index) ?? [];
      const copy = new EncodedVideoChunk({
        type: chunk.type,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? undefined,
        data: frameToBytes(chunk),
      });
      list.push(copy);
      videoChunks.set(index, list);
    },
    error(error) {
      callbackFailure = error;
    },
  });
  const audioEncoder = new AudioEncoder({
    output(chunk, metadata) {
      const description = metadata?.decoderConfig?.description;
      if (description && !opusHead) {
        opusHead = ArrayBuffer.isView(description)
          ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice()
          : new Uint8Array(description).slice();
      }
      const index = segmentIndexForTimestamp(manifest, chunk.timestamp);
      const list = audioChunks.get(index) ?? [];
      const copy = new EncodedAudioChunk({
        type: chunk.type,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? undefined,
        data: frameToBytes(chunk),
      });
      list.push(copy);
      audioChunks.set(index, list);
    },
    error(error) {
      callbackFailure = error;
    },
  });
  videoEncoder.configure(videoConfig);
  audioEncoder.configure(audioConfig);

  const totalFrames = manifest.segments.reduce((total, segment) => total + Math.round((segment.durationMs / 1000) * FPS), 0);
  const total = totalFrames + manifest.segments.length * 2;
  let completed = 0;

  try {
    for (let index = 0; index < manifest.segments.length; index += 1) {
      const segment = manifest.segments[index];
      if (!segment) {
        continue;
      }
      const startMs = segmentStartMs(manifest, index);
      const startUs = startMs * 1000;
      onProgress({
        phase: "audio",
        completed,
        total,
        label: `WebAudio 合成音轨 ${segment.ordinal}/${manifest.segments.length}`,
      });
      const samples = await renderSegmentAudio(segment);
      await encodeAudioSegment(audioEncoder, samples, startUs);
      completed += 1;

      const frameCount = Math.round((segment.durationMs / 1000) * FPS);
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        if (callbackFailure) {
          throw callbackFailure;
        }
        const localMs = (frameIndex * 1000) / FPS;
        drawTrainingFrame(context, {
          segment,
          segmentIndex: index,
          segmentCount: manifest.segments.length,
          localMs,
          accent: segment.accent,
        });
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round(startUs + (frameIndex * 1_000_000) / FPS),
          duration: Math.round(1_000_000 / FPS),
        });
        videoEncoder.encode(frame, { keyFrame: frameIndex === 0 });
        frame.close();
        completed += 1;
        if (frameIndex % 4 === 0) {
          await waitForEncoderQueue(videoEncoder);
        }
        if (frameIndex % 12 === 0) {
          onProgress({
            phase: "video",
            completed,
            total,
            label: `Canvas 渲染并编码片段 ${segment.ordinal}`,
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      completed += 1;
    }

    await Promise.all([videoEncoder.flush(), audioEncoder.flush()]);
    if (callbackFailure) {
      throw callbackFailure;
    }
  } finally {
    if (videoEncoder.state !== "closed") {
      videoEncoder.close();
    }
    if (audioEncoder.state !== "closed") {
      audioEncoder.close();
    }
  }

  const initSegment = buildInitSegment({
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    fps: FPS,
    totalDurationMs: manifest.durationMs,
    audioSampleRate: AUDIO_SAMPLE_RATE,
    audioChannels: AUDIO_CHANNELS,
    opusHead,
  });
  const initBuffer = toBytes(initSegment).slice().buffer;
  const initSha256 = await sha256Base64Url(initBuffer);

  await clearSegments();
  const cachedSegments: CachedSegment[] = [];
  for (let index = 0; index < manifest.segments.length; index += 1) {
    const segment = manifest.segments[index];
    if (!segment) {
      continue;
    }
    const material = keyMaterials.get(segment.id);
    if (!material) {
      throw new ControlledPlaybackError({
        code: "LICENSE_MISSING",
        title: "缺少片段密钥材料",
        guidance: "无法为片段生成受控媒体，请重新联机申请许可。",
        segmentId: segment.id,
      });
    }
    const video = videoChunks.get(index) ?? [];
    const audio = audioChunks.get(index) ?? [];
    if (video.length === 0) {
      throw new Error(`Video encoder produced no frames for ${segment.id}`);
    }
    const frames: MuxFrame[] = [
      ...video.map((chunk) => ({
        track: "video" as const,
        timestampUs: chunk.timestamp,
        keyframe: chunk.type === "key",
        data: frameToBytes(chunk),
      })),
      ...audio.map((chunk) => ({
        track: "audio" as const,
        timestampUs: chunk.timestamp,
        keyframe: false,
        data: frameToBytes(chunk),
      })),
    ];
    const cluster = buildMediaCluster(frames, segmentStartMs(manifest, index));
    const plaintext = toBytes(cluster).slice().buffer;
    onProgress({
      phase: "encrypt",
      completed: total - manifest.segments.length + index,
      total,
      label: `AES-GCM 加密片段 ${segment.ordinal}/${manifest.segments.length}`,
    });
    const encrypted = await encryptSegment(plaintext, material.contentKey);
    const record: CachedSegment = {
      segmentId: segment.id,
      ordinal: segment.ordinal,
      keyId: segment.keyId,
      keyEpoch: segment.keyEpoch,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      ciphertextSha256: await sha256Base64Url(encrypted.ciphertext),
      plaintextSize: encrypted.plaintextSize,
      generatedAt: Date.now(),
    };
    await putSegment(record);
    cachedSegments.push(record);
    completed += 1;
  }

  onProgress({ phase: "commit", completed: total, total, label: "写入离线缓存索引" });
  return {
    initSegment: initBuffer,
    initSha256,
    segments: cachedSegments,
    generatedAt: Date.now(),
  };
}
