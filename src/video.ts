import { chooseCellSize, detectWatermark, embedWatermark, mergeDetections, samplingTimestamps } from "./watermark.ts";
import type { FrameDetection, MergedDetection, RgbaImage, Sensitivity } from "./types.ts";

export interface VideoMeta {
  name: string;
  width: number;
  height: number;
  duration: number;
  url: string;
}

export interface ProbeResult {
  video: HTMLVideoElement;
  meta: VideoMeta;
  close: () => void;
}

export interface AnalysisFrame {
  index: number;
  timestamp: number;
  image: RgbaImage;
  detection: FrameDetection;
}

export interface AnalysisResult {
  result: MergedDetection;
  frames: AnalysisFrame[];
  poster: RgbaImage | null;
  meta: VideoMeta;
}

export interface ExportResult {
  blob: Blob;
  url: string;
  mimeType: string;
  frames: number;
  width: number;
  height: number;
}

export interface MediaCapabilities {
  webCodecs: boolean;
  webAudio: boolean;
  mediaSource: boolean;
  mediaRecorder: boolean;
  vp9: boolean;
  label: string;
}

function waitForEvent(target: EventTarget, event: string, timeout = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      target.removeEventListener(event, onEvent);
      reject(new Error(`等待 ${event} 超时。`));
    }, timeout);
    const onEvent = (): void => {
      window.clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      resolve();
    };
    target.addEventListener(event, onEvent, { once: true });
  });
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("视频元数据读取超时，文件可能损坏或编码器不受支持。"));
    }, 15000);
    const cleanup = (): void => {
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("error", onError);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("浏览器无法解码该视频。"));
    };
    video.addEventListener("loadedmetadata", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

export async function openVideo(file: File): Promise<ProbeResult> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await waitForMetadata(video);
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("视频没有可用的画面轨道。");
    }
    if (video.readyState < 2) await waitForEvent(video, "loadeddata");
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return {
    video,
    meta: {
      name: file.name,
      width: video.videoWidth,
      height: video.videoHeight,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      url
    },
    close: () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    }
  };
}

export function drawVideoFrame(
  video: HTMLVideoElement,
  maxDimension = 1100
): RgbaImage {
  const longest = Math.max(video.videoWidth, video.videoHeight);
  const ratio = longest > maxDimension ? maxDimension / longest : 1;
  const width = Math.max(1, Math.round(video.videoWidth * ratio));
  const height = Math.max(1, Math.round(video.videoHeight * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("当前浏览器无法创建 Canvas 2D 上下文。");
  context.drawImage(video, 0, 0, width, height);
  return {
    width,
    height,
    data: context.getImageData(0, 0, width, height).data
  };
}

async function seekVideo(video: HTMLVideoElement, timestamp: number): Promise<void> {
  if (Math.abs(video.currentTime - timestamp) < 0.002) return;
  const target = Math.min(Math.max(0, timestamp), Math.max(0, video.duration - 0.01));
  video.currentTime = target;
  await waitForEvent(video, "seeked");
  if (typeof video.requestVideoFrameCallback === "function") {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 220);
      video.requestVideoFrameCallback(() => {
        window.clearTimeout(timer);
        resolve();
      });
    });
  }
}

export async function analyzeVideo(
  file: File,
  sensitivity: Sensitivity,
  onProgress: (ratio: number, label: string) => void
): Promise<AnalysisResult> {
  const probe = await openVideo(file);
  try {
    const frameCount = sensitivity === "strict" ? 9 : sensitivity === "aggressive" ? 5 : 7;
    const timestamps = samplingTimestamps(probe.meta.duration, frameCount);
    const frames: AnalysisFrame[] = [];
    let poster: RgbaImage | null = null;
    let posterScore = -1;

    for (let index = 0; index < timestamps.length; index += 1) {
      onProgress(index / Math.max(1, timestamps.length), `扫描第 ${index + 1}/${timestamps.length} 帧`);
      await seekVideo(probe.video, timestamps[index]);
      const image = drawVideoFrame(probe.video, 1000);
      const detection = detectWatermark(image, { sensitivity, maxDimension: 1000 });
      frames.push({ index, timestamp: timestamps[index], image, detection });
      const score =
        (detection.found ? 100 : 0) +
        detection.syncMatches * 2 +
        detection.codeCorrelation * 20 +
        detection.signal;
      if (score > posterScore) {
        posterScore = score;
        poster = image;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }

    onProgress(1, "汇总跨帧证据");
    return {
      result: mergeDetections(
        frames.map((frame) => frame.detection),
        sensitivity
      ),
      frames,
      poster,
      meta: probe.meta
    };
  } finally {
    probe.close();
  }
}

function chooseRecorderMime(): string {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

export async function exportMarkedVideo(
  file: File,
  creatorId: number,
  amplitude: number,
  onProgress: (ratio: number, label: string) => void
): Promise<ExportResult> {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("当前浏览器不支持 MediaRecorder，无法导出视频。");
  }
  const probe = await openVideo(file);
  const { video, meta } = probe;
  let audioContext: AudioContext | null = null;
  let audioSource: MediaElementAudioSourceNode | null = null;
  let audioDestination: MediaStreamAudioDestinationNode | null = null;
  let audioConnected = false;
  let raf = 0;
  let activeRecorder: MediaRecorder | null = null;

  try {
    const maxWidth = 1920;
    const ratio = Math.min(1, maxWidth / Math.max(1, meta.width));
    const width = Math.max(2, Math.round((meta.width * ratio) / 2) * 2);
    const height = Math.max(2, Math.round((meta.height * ratio) / 2) * 2);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法创建导出画布。");

    const videoStream = canvas.captureStream(30);
    let combined = new MediaStream(videoStream.getVideoTracks());
    try {
      const AudioContextClass = window.AudioContext;
      if (AudioContextClass) {
        audioContext = new AudioContextClass();
        audioSource = audioContext.createMediaElementSource(video);
        audioDestination = audioContext.createMediaStreamDestination();
        audioSource.connect(audioDestination);
        await audioContext.resume();
        for (const track of audioDestination.stream.getAudioTracks()) combined.addTrack(track);
        audioConnected = true;
      }
    } catch {
      combined = new MediaStream(videoStream.getVideoTracks());
    }

    const mimeType = chooseRecorderMime();
    const recorder = new MediaRecorder(combined, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: width >= 1600 ? 9_000_000 : width >= 1200 ? 6_500_000 : 4_500_000,
      audioBitsPerSecond: 128_000
    });
    activeRecorder = recorder;
    const chunks: BlobPart[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    const stopped = new Promise<void>((resolve, reject) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.addEventListener("error", () => reject(new Error("媒体编码器异常终止。")), {
        once: true
      });
    });

    const cellSize = chooseCellSize(width, height);
    const draw = (): void => {
      if (video.ended) return;
      context.drawImage(video, 0, 0, width, height);
      const image = context.getImageData(0, 0, width, height);
      const marked = embedWatermark(
        { width, height, data: image.data },
        { creatorId, amplitude, cellSize }
      );
      context.putImageData(new ImageData(marked.data, width, height), 0, 0);
      const progress = meta.duration > 0 ? Math.min(1, video.currentTime / meta.duration) : 0;
      onProgress(progress, `写入帧 ${Math.round(video.currentTime * 30)} · 本地编码中`);
      raf = requestAnimationFrame(draw);
    };

    video.muted = !audioConnected;
    video.currentTime = 0;
    recorder.start(250);
    onProgress(0, "启动逐帧写入");
    await video.play();
    draw();
    await new Promise<void>((resolve) => {
      video.addEventListener("ended", () => resolve(), { once: true });
    });
    cancelAnimationFrame(raf);
    onProgress(1, "封装媒体文件");
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
    return {
      blob,
      url: URL.createObjectURL(blob),
      mimeType: recorder.mimeType || "video/webm",
      frames: Math.max(1, Math.round(meta.duration * 30)),
      width,
      height
    };
  } finally {
    cancelAnimationFrame(raf);
    if (activeRecorder && activeRecorder.state !== "inactive") {
      try {
        activeRecorder.stop();
      } catch {
        // The recorder may already be shutting down after an error.
      }
    }
    video.muted = true;
    if (audioSource) {
      try {
        audioSource.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    if (audioContext) await audioContext.close().catch(() => undefined);
    probe.close();
  }
}

export async function probeMediaCapabilities(): Promise<MediaCapabilities> {
  const webCodecs = typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined";
  const webAudio = typeof AudioContext !== "undefined";
  const mediaSource = typeof MediaSource !== "undefined";
  const mediaRecorder = typeof MediaRecorder !== "undefined";
  let vp9 = false;
  if (webCodecs) {
    try {
      const supported = await VideoEncoder.isConfigSupported({
        codec: "vp09.00.10.08",
        width: 1280,
        height: 720,
        bitrate: 4_000_000,
        framerate: 30
      });
      vp9 = Boolean(supported.supported);
    } catch {
      vp9 = false;
    }
  }
  return {
    webCodecs,
    webAudio,
    mediaSource,
    mediaRecorder,
    vp9,
    label: webCodecs ? (vp9 ? "WebCodecs · VP9" : "WebCodecs · 可用") : "MediaRecorder"
  };
}
