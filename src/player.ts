import type { ByteRangeReader, DemuxedMedia, VideoTrack } from "./mp4.ts";
import { CachingRangeReader } from "./mp4.ts";
import { buildFrameTimeline, type DisplayFrame, type FrameTimeline } from "./timeline.ts";
import { VideoDecodeEngine, type VideoEngineStats } from "./video-engine.ts";
import { ThumbnailStore } from "./thumbnails.ts";
import { AudioEngine, type AudioState } from "./audio-engine.ts";

export interface PlayerSnapshot {
  targetFrame: number;
  displayedFrame: number | null;
  exact: boolean;
  decoding: boolean;
  previewFrame: number | null;
  previewActive: boolean;
  playing: boolean;
  timeSeconds: number;
  audioTrackId: number | null;
  audioState: AudioState;
  audioError: string;
  videoStats: VideoEngineStats;
  error: string;
}

type SnapshotListener = (snapshot: PlayerSnapshot) => void;
type FrameListener = (frame: VideoFrame, frameNumber: number) => void;
type PreviewListener = (bitmap: ImageBitmap, frameNumber: number, gopId: number) => void;

export class ReviewPlayer {
  readonly media: DemuxedMedia;
  readonly timeline: FrameTimeline;
  readonly videoTrack: VideoTrack;
  private readonly engine: VideoDecodeEngine;
  private readonly thumbnails: ThumbnailStore;
  private readonly audio: AudioEngine;
  private targetFrame = 0;
  private displayedFrame: number | null = null;
  private previewFrame: number | null = null;
  private previewGopId = -1;
  private previewActive = false;
  private decoding = false;
  private playing = false;
  private error = "";
  private operation = 0;
  private pendingTimer = 0;
  private playRaf = 0;
  private playAnchorPerf = 0;
  private playAnchorTime = 0;
  private listeners = new Set<SnapshotListener>();
  private frameListeners = new Set<FrameListener>();
  private previewListeners = new Set<PreviewListener>();
  private started = false;

  constructor(source: ByteRangeReader, media: DemuxedMedia, videoTrack: VideoTrack) {
    this.media = media;
    this.videoTrack = videoTrack;
    this.timeline = buildFrameTimeline(videoTrack);
    const buffered = source instanceof CachingRangeReader ? source : new CachingRangeReader(source);
    this.engine = new VideoDecodeEngine(buffered, videoTrack, this.timeline, 3);
    this.thumbnails = new ThumbnailStore(buffered, videoTrack, this.timeline);
    this.audio = new AudioEngine(buffered, media.audioTracks, this.timeline);
  }

  get snapshot(): PlayerSnapshot {
    return {
      targetFrame: this.targetFrame,
      displayedFrame: this.displayedFrame,
      exact: this.displayedFrame === this.targetFrame,
      decoding: this.decoding,
      previewFrame: this.previewFrame,
      previewActive: this.previewActive,
      playing: this.playing,
      timeSeconds: this.timeline.frameAt(this.targetFrame).ctsSeconds,
      audioTrackId: this.audio.currentTrack?.trackId ?? null,
      audioState: this.audio.state,
      audioError: this.audio.error,
      videoStats: this.engine.stats,
      error: this.error
    };
  }

  get frame(): DisplayFrame {
    return this.timeline.frameAt(this.targetFrame);
  }

  get pinnedFrame(): VideoFrame | null {
    return this.engine.pin(this.displayedFrame ?? this.targetFrame);
  }

  get thumbnailDebug(): { gopId: number; frameNumber: number; timestamp: number } | null {
    return this.thumbnails.lastDecode;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onPreview(listener: PreviewListener): () => void {
    this.previewListeners.add(listener);
    return () => this.previewListeners.delete(listener);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.commitFrame(0, true);
  }

  step(delta: number): void {
    if (this.playing) this.pause();
    const target = this.timeline.navigationTarget(this.targetFrame, delta);
    this.commitFrame(target, true);
  }

  goTo(frameNumber: number): void {
    if (this.playing) this.pause();
    this.commitFrame(this.timeline.clampFrame(frameNumber), true);
  }

  goToTime(seconds: number): void {
    if (this.playing) this.pause();
    this.commitFrame(this.timeline.frameAtTime(seconds).frameNumber, true);
  }

  beginScrub(): void {
    if (this.playing) this.pause();
    this.previewActive = true;
    this.emit();
  }

  scrubTo(seconds: number, commitDelayMs = 110): void {
    const frame = this.timeline.frameAtTime(seconds);
    this.targetFrame = frame.frameNumber;
    this.previewFrame = frame.frameNumber;
    this.previewGopId = frame.gopId;
    this.previewActive = true;
    this.showPreview(frame);
    this.emit();
    window.clearTimeout(this.pendingTimer);
    this.pendingTimer = window.setTimeout(() => {
      this.commitFrame(frame.frameNumber, true, true);
    }, Math.max(0, commitDelayMs));
  }

  endScrub(seconds: number): void {
    const frame = this.timeline.frameAtTime(seconds);
    this.targetFrame = frame.frameNumber;
    this.previewFrame = frame.frameNumber;
    this.previewGopId = frame.gopId;
    this.showPreview(frame);
    this.commitFrame(frame.frameNumber, true, true);
  }

  async togglePlay(): Promise<void> {
    if (this.playing) {
      this.pause();
      return;
    }
    this.playing = true;
    this.error = "";
    this.thumbnails.request(this.frame.gopId).catch(() => undefined);
    this.playAnchorTime = this.timeline.frameAt(this.targetFrame).ctsSeconds;
    this.playAnchorPerf = performance.now();
    void this.audio.play(this.playAnchorTime).then(() => this.emit()).catch((error) => {
      this.error = error instanceof Error ? error.message : String(error);
      this.emit();
    });
    this.emit();
    this.playRaf = requestAnimationFrame((now) => this.playTick(now));
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.playRaf);
    this.playRaf = 0;
    this.audio.pause();
    this.emit();
  }

  async selectAudioTrack(trackId: number): Promise<void> {
    const seconds = this.timeline.frameAt(this.targetFrame).ctsSeconds;
    await this.audio.selectTrack(trackId, seconds);
    this.emit();
  }

  setVolume(value: number): void {
    this.audio.setVolume(value);
    this.emit();
  }

  setMuted(value: boolean): void {
    this.audio.setMuted(value);
    this.emit();
  }

  redraw(): void {
    const frame = this.pinnedFrame;
    if (frame) {
      for (const listener of this.frameListeners) {
        listener(frame, this.displayedFrame ?? this.targetFrame);
      }
    }
  }

  destroy(): void {
    this.pause();
    window.clearTimeout(this.pendingTimer);
    this.thumbnails.clear();
    this.audio.dispose();
    this.engine.dispose();
    this.listeners.clear();
    this.frameListeners.clear();
    this.previewListeners.clear();
  }

  private commitFrame(frameNumber: number, immediate: boolean, preservePreview = false): void {
    this.targetFrame = this.timeline.clampFrame(frameNumber);
    if (!preservePreview) this.previewActive = false;
    this.emit();
    window.clearTimeout(this.pendingTimer);
    this.pendingTimer = window.setTimeout(() => {
      if (!this.decoding) void this.decodeTarget();
    }, immediate ? 0 : 24);
  }

  private async decodeTarget(): Promise<void> {
    if (this.decoding) return;
    const token = ++this.operation;
    const target = this.targetFrame;
    this.decoding = true;
    this.emit();
    try {
      await this.engine.ensureFrame(target);
      if (token !== this.operation || this.targetFrame !== target) return;
      const videoFrame = this.engine.getCached(target);
      if (!videoFrame) throw new Error("缓存中缺少目标帧");
      this.engine.pin(target);
      this.displayedFrame = target;
      this.previewActive = false;
      this.error = "";
      for (const listener of this.frameListeners) listener(videoFrame, target);
      void this.thumbnails.request(this.timeline.frameAt(target).gopId).catch(() => undefined);
    } catch (error) {
      if (token === this.operation) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (token === this.operation) {
        this.decoding = false;
        this.emit();
        if (this.targetFrame !== target) void this.decodeTarget();
      }
    }
  }

  private showPreview(frame: DisplayFrame): void {
    const bitmap = this.thumbnails.peek(frame.gopId);
    if (bitmap) {
      for (const listener of this.previewListeners) listener(bitmap, frame.frameNumber, frame.gopId);
    }
    void this.thumbnails.request(frame.gopId).then((loaded) => {
      if (!loaded || !this.previewActive || this.previewGopId !== frame.gopId) return;
      for (const listener of this.previewListeners) listener(loaded, frame.frameNumber, frame.gopId);
      this.emit();
    }).catch(() => undefined);
  }

  private playTick(now: number): void {
    if (!this.playing) return;
    const seconds = this.playAnchorTime + (now - this.playAnchorPerf) / 1000;
    if (seconds >= this.timeline.durationSeconds) {
      this.pause();
      return;
    }
    const frame = this.timeline.frameAtTime(seconds);
    if (frame.frameNumber !== this.targetFrame) {
      this.targetFrame = frame.frameNumber;
      this.emit();
      if (!this.decoding) void this.decodeTarget();
    }
    this.playRaf = requestAnimationFrame((next) => this.playTick(next));
  }

  private emit(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
