/// <reference lib="webworker" />
/**
 * WebCodecs 转码 Worker：
 * - OffscreenCanvas 逐帧绘制动画 -> VideoFrame -> VideoEncoder（VP9）
 * - OfflineAudioContext 合成正弦波 -> AudioData -> AudioEncoder（Opus）
 * - 极简 EBML/WebM 复用器把编码块写成可播放的 webm 分段
 * 每个 chunk 边界检查暂停/取消信号并上报检查点，与本地执行器语义一致。
 */
import { encodeWebmSegment, type MuxerTrack } from "./webmMuxer.ts";
import type { TaskCheckpoint, TaskRecord } from "../shared/protocol.ts";

const worker = self as unknown as DedicatedWorkerGlobalScope;
let paused = false;
let cancelled = false;

function post(type: string, payload: Record<string, unknown> = {}): void {
  worker.postMessage({ type, ...payload });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForEncoder(codec: "video" | "audio", config: unknown): Promise<void> {
  const support =
    codec === "video"
      ? await (self as unknown as { VideoEncoder: typeof VideoEncoder }).VideoEncoder.isConfigSupported(
          config as VideoEncoderConfig,
        )
      : await (self as unknown as { AudioEncoder: typeof AudioEncoder }).AudioEncoder.isConfigSupported(
          config as AudioEncoderConfig,
        );
  if (!support.supported) throw new Error(`当前浏览器不支持该 ${codec} 编码配置`);
}

interface ChunkOutput {
  chunk: EncodedVideoChunk | EncodedAudioChunk;
  type: "video" | "audio";
  timestamp: number;
}

async function runTask(task: TaskRecord): Promise<TaskCheckpoint> {
  const width = task.payload.width ?? 320;
  const height = task.payload.height ?? 180;
  const fps = task.payload.fps ?? 15;
  const durationSec = task.payload.durationSec ?? 6;
  const totalFrames = fps * durationSec;
  const chunkSize = Math.max(1, Math.ceil(totalFrames / Math.max(1, task.payload.chunks ?? 10)));

  const videoConfig: VideoEncoderConfig = {
    codec: "vp09.00.10.08",
    width,
    height,
    bitrate: 600_000,
    framerate: fps,
  };
  const audioConfig: AudioEncoderConfig = {
    codec: "opus",
    sampleRate: 48000,
    numberOfChannels: 1,
    bitrate: 64_000,
  };
  await waitForEncoder("video", videoConfig);
  await waitForEncoder("audio", audioConfig);

  const canvas = new OffscreenCanvas(width, height);
  const context2d = canvas.getContext("2d");
  if (!context2d) throw new Error("无法创建 OffscreenCanvas 2D 上下文");

  const outputs: ChunkOutput[] = [];
  let encoderFailure: Error | null = null;
  const failEncoder = (err: DOMException) => {
    encoderFailure = err instanceof Error ? err : new Error(String(err));
  };
  const videoEncoder = new VideoEncoder({
    output: (chunk) => outputs.push({ chunk, type: "video", timestamp: chunk.timestamp }),
    error: failEncoder,
  });
  videoEncoder.configure(videoConfig);

  // 1) 逐帧渲染 + 编码，严格在帧边界响应暂停/取消
  let frameIndex = task.checkpoint?.chunk ?? 0;
  const segments = task.checkpoint?.segments ?? [];
  while (frameIndex < totalFrames) {
    if (cancelled) throw new Error("cancelled");
    const frameEnd = Math.min(totalFrames, frameIndex + chunkSize);
    for (let index = frameIndex; index < frameEnd; index++) {
      drawFrame(context2d, width, height, index, totalFrames, task.name);
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((index * 1_000_000) / fps),
        duration: Math.round(1_000_000 / fps),
      });
      videoEncoder.encode(frame, { keyFrame: index % (fps * 2) === 0 });
      frame.close();
    }
    await videoEncoder.flush();
    if (encoderFailure) throw encoderFailure;
    if (cancelled) throw new Error("cancelled");

    // 2) 合成该分段音频（WebAudio OfflineAudioContext）
    const audioChunks = await encodeAudioSegment(audioConfig, frameEnd - frameIndex, fps, frameIndex);
    for (const chunk of audioChunks) outputs.push(chunk);

    // 3) 复用为 webm 分段并上传（fetch 由主线程代理，保证无包依赖）
    const segmentName = `${task.id}.webm-${String(frameEnd).padStart(5, "0")}`;
    const bytes = muxSegment(videoConfig, audioConfig, outputs.splice(0), width, height, fps);
    await uploadSegment(task.id, segmentName, bytes);
    segments.push(segmentName);

    const checkpoint: TaskCheckpoint = {
      chunk: frameEnd,
      segments: [...segments],
      savedAt: Date.now(),
    };
    post("checkpoint", { checkpoint, progress: frameEnd / totalFrames });
    frameIndex = frameEnd;

    if (paused) {
      post("paused", { checkpoint });
      return checkpoint;
    }
    await sleep(20);
  }
  return { chunk: totalFrames, segments, savedAt: Date.now() };
}

function drawFrame(
  context2d: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  index: number,
  total: number,
  label: string,
): void {
  const gradient = context2d.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#182033");
  gradient.addColorStop(1, "#27406e");
  context2d.fillStyle = gradient;
  context2d.fillRect(0, 0, width, height);
  const x = (width * (index / total) + Math.sin(index / 8) * 30 + width) % width;
  context2d.fillStyle = "#4f8cff";
  context2d.beginPath();
  context2d.arc(x, height / 2, 22, 0, Math.PI * 2);
  context2d.fill();
  context2d.fillStyle = "#e6ebf5";
  context2d.font = "14px sans-serif";
  context2d.fillText(`${label} #${index}`, 10, 22);
}

async function encodeAudioSegment(
  config: AudioEncoderConfig,
  frameCount: number,
  fps: number,
  startFrame: number,
): Promise<ChunkOutput[]> {
  const sampleRate = config.sampleRate!;
  const seconds = frameCount / fps;
  const offline = new OfflineAudioContext(1, Math.ceil(sampleRate * seconds), sampleRate);
  const oscillator = offline.createOscillator();
  const gain = offline.createGain();
  oscillator.frequency.value = 220 + (startFrame % 24) * 12;
  gain.gain.value = 0.12;
  oscillator.connect(gain).connect(offline.destination);
  oscillator.start(0);
  const buffer = await offline.startRendering();

  const results: ChunkOutput[] = [];
  let failure: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk) =>
      results.push({ chunk, type: "audio", timestamp: chunk.timestamp }),
    error: (err) => {
      failure = err instanceof Error ? err : new Error(String(err));
    },
  });
  encoder.configure(config);
  const frameLength = buffer.length;
  const audioData = new AudioData({
    format: "f32-planar",
    sampleRate,
    numberOfFrames: frameLength,
    numberOfChannels: 1,
    timestamp: Math.round((startFrame * 1_000_000) / fps),
    data: buffer.getChannelData(0),
  });
  encoder.encode(audioData);
  audioData.close();
  await encoder.flush();
  if (failure) throw failure;
  encoder.close();
  return results;
}

function muxSegment(
  videoConfig: VideoEncoderConfig,
  audioConfig: AudioEncoderConfig,
  chunks: ChunkOutput[],
  width: number,
  height: number,
  fps: number,
): Uint8Array {
  const tracks: MuxerTrack[] = [
    { kind: "video", codec: videoConfig.codec, width, height, fps, chunks: chunks.filter((item) => item.type === "video").map((item) => item.chunk) as EncodedVideoChunk[] },
    { kind: "audio", codec: audioConfig.codec, sampleRate: audioConfig.sampleRate!, channels: 1, chunks: chunks.filter((item) => item.type === "audio").map((item) => item.chunk) as EncodedAudioChunk[] },
  ];
  return encodeWebmSegment(tracks);
}

function uploadSegment(taskId: string, name: string, bytes: Uint8Array): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent) => {
      if (event.data?.ok) resolvePromise();
      else rejectPromise(new Error(event.data?.error ?? "分段上传失败"));
    };
    post("upload", { taskId, name, bytes, port: channel.port2 }, [channel.port2]);
  });
}

worker.onmessage = async (event: MessageEvent) => {
  if (event.data?.type === "control") {
    if (event.data.signal === "pause") paused = true;
    if (event.data.signal === "cancel") cancelled = true;
    return;
  }
  if (event.data?.type !== "run") return;
  try {
    const task = event.data.task as TaskRecord;
    paused = false;
    cancelled = false;
    const checkpoint = await runTask(task);
    post("done", { checkpoint });
  } catch (err) {
    post(cancelled ? "cancelled" : "error", { message: (err as Error).message });
  }
};
