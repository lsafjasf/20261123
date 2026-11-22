// MediaSource 回退播放器：当浏览器缺少 WebCodecs 时，用 MSE + <video> 原生解码，
// 再由渲染层通过 Canvas drawImage 抽帧，复用同一套 LUT 调色管线。

import { demuxWebm, webmCodecString } from "./ebml.ts";

export interface MSEInfo {
  durationMs: number;
  videoCodec: string;
  audioCodec: string;
}

export class MSEPlayer {
  private mediaSource: MediaSource | null = null;
  private objectUrl = "";
  private sourceBuffer: SourceBuffer | null = null;
  private readonly video: HTMLVideoElement;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  static isSupported(): boolean {
    return (
      typeof globalThis.MediaSource === "function" &&
      MediaSource.isTypeSupported('video/webm; codecs="vp09.00.10.08"')
    );
  }

  async load(buffer: ArrayBuffer): Promise<MSEInfo> {
    const result = demuxWebm(buffer);
    const videoTrack = result.tracks.find((track) => track.type === "video");
    const audioTrack = result.tracks.find((track) => track.type === "audio");
    if (!videoTrack) throw new Error("文件中没有视频轨");
    const videoCodec = webmCodecString(videoTrack);
    const audioCodec = audioTrack ? webmCodecString(audioTrack) : "";
    const mimeType = audioCodec
      ? `video/webm; codecs="${videoCodec}, ${audioCodec}"`
      : `video/webm; codecs="${videoCodec}"`;
    if (!MediaSource.isTypeSupported(mimeType)) {
      throw new Error(`MediaSource 不支持该容器组合：${mimeType}`);
    }

    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this.objectUrl;
    await new Promise<void>((resolve) => {
      this.mediaSource!.addEventListener("sourceopen", () => resolve(), { once: true });
    });
    this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
    await new Promise<void>((resolve, reject) => {
      this.sourceBuffer!.addEventListener("updateend", () => resolve(), { once: true });
      this.sourceBuffer!.addEventListener(
        "error",
        () => reject(new Error("SourceBuffer 追加失败")),
        { once: true }
      );
      this.sourceBuffer!.appendBuffer(buffer);
    });

    return {
      durationMs: result.durationMs || this.video.duration * 1000,
      videoCodec,
      audioCodec: audioCodec || "无音频轨"
    };
  }

  getVideoElement(): HTMLVideoElement {
    return this.video;
  }

  async play(): Promise<void> {
    await this.video.play();
  }

  pause(): void {
    this.video.pause();
  }

  get currentTimeMs(): number {
    return this.video.currentTime * 1000;
  }

  get durationMs(): number {
    return this.video.duration * 1000;
  }

  get isPlaying(): boolean {
    return !this.video.paused && !this.video.ended;
  }

  dispose(): void {
    this.video.removeAttribute("src");
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    if (this.mediaSource && this.mediaSource.readyState !== "closed") {
      try {
        if (this.sourceBuffer && !this.sourceBuffer.updating) this.mediaSource.endOfStream();
      } catch {
        // 关闭过程中的状态竞争可忽略。
      }
    }
  }
}
