import { Fmp4Track, type MuxTrackConfig } from "./fmp4.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("video-canvas");
const context = canvas.getContext("2d", { alpha: false }) as CanvasRenderingContext2D;
const videoElement = $<HTMLVideoElement>("video-element");
const stageShell = document.querySelector(".stage-shell") as HTMLElement;
const stageEmpty = $<HTMLElement>("stage-empty");
const soundButton = $<HTMLButtonElement>("sound-button");
const volumeInput = $<HTMLInputElement>("volume");
const muteButton = $<HTMLButtonElement>("mute-button");

const WIRE_MAGIC = 0x45465231;
const WIRE_VERSION = 1;
const WIRE_HEADER_BYTES = 24;
const KIND_VIDEO_CONFIG = 1;
const KIND_AUDIO_CONFIG = 2;
const KIND_VIDEO_SAMPLE = 3;
const KIND_AUDIO_SAMPLE = 4;
const FLAG_KEYFRAME = 1;

interface WirePacket {
  kind: number;
  flags: number;
  ptsMs: number;
  durationMs: number;
  seq: number;
  payload: Uint8Array;
}

interface VideoConfig {
  codec: string;
  width: number;
  height: number;
  description: Uint8Array;
}

interface AudioConfig {
  codec: string;
  sampleRate: number;
  channels: number;
  description: Uint8Array;
}

interface DiagPayload {
  type: "diag";
  source: Record<string, unknown>;
  cache: { bytes: number; gops: number; samples: number };
  self: { state: string; droppedBytes: number; queuedBytes: number; skippedFrames: number };
  totals: { slowEvents: number };
}

interface SourceWire {
  state: "online" | "offline";
  generation: number;
  since: number;
  protocol: string;
  lastSeenAt: number;
  reconnectCount: number;
  reason?: string;
  video: { codec: string; width: number; height: number } | null;
  audio: { codec: string; sampleRate: number; channels: number } | null;
}

function parsePacket(buffer: ArrayBuffer): WirePacket | null {
  if (buffer.byteLength < WIRE_HEADER_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== WIRE_MAGIC || view.getUint8(4) !== WIRE_VERSION) return null;
  const kind = view.getUint8(5);
  if (kind < KIND_VIDEO_CONFIG || kind > KIND_AUDIO_SAMPLE) return null;
  return {
    kind,
    flags: view.getUint8(6),
    ptsMs: view.getFloat64(8, true),
    durationMs: view.getFloat32(16, true),
    seq: view.getUint32(20, true),
    payload: new Uint8Array(buffer, WIRE_HEADER_BYTES),
  };
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.round(value)} B`;
}

function log(message: string): void {
  const list = $<HTMLOListElement>("viewer-log");
  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  item.textContent = `${time}  ${message}`;
  list.prepend(item);
  while (list.children.length > 50) list.lastElementChild?.remove();
}

class AudioSink {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private nextTime = 0;
  private volume = 0.8;
  private muted = false;
  private pcmConfig: AudioConfig | null = null;

  get sampleRate(): number {
    return this.context?.sampleRate ?? 0;
  }

  async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.gain.value = this.muted ? 0 : this.volume;
      this.gain.connect(this.context.destination);
    }
    await this.context.resume();
    soundButton.classList.add("hidden");
    log(`WebAudio 已就绪 (${this.context.sampleRate} Hz)`);
  }

  configurePcm(config: AudioConfig): void {
    this.pcmConfig = config;
  }

  schedulePcm(payload: Uint8Array, ptsMs: number): void {
    const config = this.pcmConfig;
    if (!config || !this.context) return;
    const channels = Math.max(1, config.channels);
    const frames = Math.floor(payload.length / (channels * 2));
    if (frames <= 0) return;
    const data = new Float32Array(frames * channels);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    for (let i = 0; i < frames * channels; i++) {
      data[i] = view.getInt16(i * 2, true) / 32768;
    }
    const planar: Float32Array[] = [];
    for (let channel = 0; channel < channels; channel++) {
      const plane = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame++) plane[frame] = data[frame * channels + channel];
      planar.push(plane);
    }
    this.scheduleFloat(planar, config.sampleRate, ptsMs);
  }

  scheduleAudioData(audio: AudioData, ptsMs: number): void {
    const channels = audio.numberOfChannels;
    const frames = audio.numberOfFrames;
    const planar: Float32Array[] = [];
    for (let channel = 0; channel < channels; channel++) {
      const plane = new Float32Array(frames);
      try {
        audio.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
      } catch {
        audio.copyTo(plane, { planeIndex: channel });
      }
      planar.push(plane);
    }
    this.scheduleFloat(planar, audio.sampleRate, ptsMs);
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : this.volume;
  }

  isMuted(): boolean {
    return this.muted;
  }

  reset(): void {
    this.nextTime = 0;
    this.pcmConfig = null;
  }

  private scheduleFloat(channels: Float32Array[], sampleRate: number, ptsMs: number): void {
    const audio = this.context;
    const gain = this.gain;
    if (!audio || !gain || audio.state !== "running" || channels.length === 0) return;
    const frames = channels[0].length;
    if (!frames) return;
    const buffer = audio.createBuffer(channels.length, frames, sampleRate);
    for (let channel = 0; channel < channels.length; channel++) buffer.copyToChannel(channels[channel], channel);
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const now = audio.currentTime;
    if (this.nextTime < now - 0.2 || this.nextTime > now + 1.2) this.nextTime = now + 0.02;
    const when = Math.max(now + 0.015, this.nextTime);
    try {
      source.start(when);
      this.nextTime = when + buffer.duration;
    } catch {
      source.disconnect();
    }
    void ptsMs;
  }
}

interface DecoderCallbacks {
  onFrame: (frame: VideoFrame) => void;
  onError: (message: string) => void;
  onNeedKeyframe: () => void;
  onDecodedFrame: () => void;
}

class WebCodecsPlayer {
  private videoDecoder: VideoDecoder | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private videoConfig: VideoConfig | null = null;
  private audioConfig: AudioConfig | null = null;
  private seenKey = false;
  private resetLock = false;
  private readonly callbacks: DecoderCallbacks;
  private readonly audio: AudioSink;

  constructor(audio: AudioSink, callbacks: DecoderCallbacks) {
    this.audio = audio;
    this.callbacks = callbacks;
  }

  setVideoConfig(config: VideoConfig): void {
    this.videoConfig = config;
    this.seenKey = false;
    try {
      this.videoDecoder?.close();
    } catch {
      // Previous decoder may already be closed.
    }
    this.videoDecoder = new VideoDecoder({
      output: (frame) => {
        this.callbacks.onDecodedFrame();
        this.callbacks.onFrame(frame);
      },
      error: (error) => this.handleError(`视频解码失败: ${error.message}`),
    });
    try {
      this.videoDecoder.configure({
        codec: config.codec,
        description: config.description,
        optimizeForLatency: true,
      });
    } catch (error) {
      this.handleError(`视频解码器配置失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  setAudioConfig(config: AudioConfig): void {
    this.audioConfig = config;
    try {
      this.audioDecoder?.close();
    } catch {
      // Previous decoder may already be closed.
    }
    this.audioDecoder = null;
    if (config.codec === "pcm-s16") {
      this.audio.configurePcm(config);
      return;
    }
    if (typeof AudioDecoder === "undefined") return;
    this.audioDecoder = new AudioDecoder({
      output: (data) => {
        try {
          this.audio.scheduleAudioData(data, data.timestamp / 1000);
        } finally {
          data.close();
        }
      },
      error: (error) => this.handleError(`音频解码失败: ${error.message}`),
    });
    try {
      this.audioDecoder.configure({
        codec: config.codec,
        sampleRate: config.sampleRate,
        numberOfChannels: config.channels,
        description: config.description,
      });
    } catch (error) {
      this.handleError(`音频解码器配置失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  pushVideo(packet: WirePacket): void {
    if (!this.videoDecoder || !this.videoConfig) return;
    const keyframe = (packet.flags & FLAG_KEYFRAME) !== 0;
    if (!this.seenKey && !keyframe) return;
    this.seenKey = true;
    try {
      this.videoDecoder.decode(
        new EncodedVideoChunk({
          type: keyframe ? "key" : "delta",
          timestamp: Math.round(packet.ptsMs * 1000),
          duration: Math.max(1, Math.round(packet.durationMs * 1000)),
          data: packet.payload,
        }),
      );
    } catch (error) {
      this.handleError(`送入视频帧失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  pushAudio(packet: WirePacket): void {
    const config = this.audioConfig;
    if (!config || !this.seenKey) return;
    if (config.codec === "pcm-s16") {
      this.audio.schedulePcm(packet.payload, packet.ptsMs);
      return;
    }
    if (!this.audioDecoder) return;
    try {
      this.audioDecoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: Math.round(packet.ptsMs * 1000),
          duration: Math.max(1, Math.round(packet.durationMs * 1000)),
          data: packet.payload,
        }),
      );
    } catch (error) {
      this.handleError(`送入音频帧失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  decodeQueueSize(): number {
    return (this.videoDecoder?.decodeQueueSize ?? 0) + (this.audioDecoder?.decodeQueueSize ?? 0);
  }

  reset(): void {
    this.seenKey = false;
    this.audio.reset();
    try {
      this.videoDecoder?.close();
      this.audioDecoder?.close();
    } catch {
      // Ignore close races during source replacement.
    }
    this.videoDecoder = null;
    this.audioDecoder = null;
    this.videoConfig = null;
    this.audioConfig = null;
  }

  private handleError(message: string): void {
    this.callbacks.onError(message);
    if (this.resetLock) return;
    this.resetLock = true;
    this.seenKey = false;
    setTimeout(() => {
      this.resetLock = false;
      this.reset();
      this.callbacks.onNeedKeyframe();
    }, 700);
  }
}

interface MseCallbacks {
  onError: (message: string) => void;
  onNeedKeyframe: () => void;
  onPlayback: () => void;
}

class MsePlayer {
  private readonly video: HTMLVideoElement;
  private readonly audio: AudioSink;
  private readonly callbacks: MseCallbacks;
  private mediaSource: MediaSource | null = null;
  private objectUrl = "";
  private open = false;
  private videoMux: Fmp4Track | null = null;
  private audioMux: Fmp4Track | null = null;
  private videoBuffer: SourceBuffer | null = null;
  private audioBuffer: SourceBuffer | null = null;
  private videoQueue: Uint8Array[] = [];
  private audioQueue: Uint8Array[] = [];
  private queuedVideoBytes = 0;
  private queuedAudioBytes = 0;
  private firstVideoKey = false;
  private originMs: number | null = null;
  private audioCodec = "";

  constructor(video: HTMLVideoElement, audio: AudioSink, callbacks: MseCallbacks) {
    this.video = video;
    this.audio = audio;
    this.callbacks = callbacks;
  }

  static supported(codec: string): boolean {
    return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`);
  }

  setVideoConfig(config: VideoConfig): void {
    if (!MsePlayer.supported(config.codec)) {
      this.callbacks.onError(`MSE 不支持 ${config.codec}`);
      return;
    }
    if (this.videoMux) this.reset();
    const muxConfig: MuxTrackConfig = {
      kind: "video",
      codec: config.codec,
      width: config.width,
      height: config.height,
      sampleRate: 0,
      channels: 0,
      description: config.description,
    };
    this.videoMux = new Fmp4Track(muxConfig);
    this.firstVideoKey = false;
    this.originMs = null;
    this.videoQueue = [];
    this.queuedVideoBytes = 0;
    this.videoBuffer = null;
    this.setupMediaSource();
    this.attachVideo();
  }

  setAudioConfig(config: AudioConfig): void {
    this.audioCodec = config.codec;
    if (config.codec === "pcm-s16") {
      this.audio.configurePcm(config);
      return;
    }
    if (!MediaSource.isTypeSupported(`audio/mp4; codecs="${config.codec}"`)) {
      this.callbacks.onError(`MSE 不支持音频 ${config.codec}`);
      return;
    }
    this.audioMux = new Fmp4Track({
      kind: "audio",
      codec: config.codec,
      width: 0,
      height: 0,
      sampleRate: config.sampleRate,
      channels: config.channels,
      description: config.description,
    });
    this.audioQueue = [];
    this.queuedAudioBytes = 0;
    this.audioBuffer = null;
    this.setupMediaSource();
    this.attachAudio();
  }

  pushVideo(packet: WirePacket): void {
    if (!this.videoMux) return;
    const keyframe = (packet.flags & FLAG_KEYFRAME) !== 0;
    if (!this.firstVideoKey && !keyframe) return;
    if (keyframe) {
      this.firstVideoKey = true;
      if (this.originMs === null) this.originMs = packet.ptsMs;
    }
    const relative = packet.ptsMs - (this.originMs ?? packet.ptsMs);
    this.enqueueVideo(
      this.videoMux.fragment(
        {
          data: packet.payload,
          ptsMs: packet.ptsMs,
          durationMs: packet.durationMs,
          keyframe,
        },
        relative,
      ),
    );
    void this.video.play().catch(() => undefined);
  }

  pushAudio(packet: WirePacket): void {
    if (this.audioCodec === "pcm-s16") {
      this.audio.schedulePcm(packet.payload, packet.ptsMs);
      return;
    }
    if (!this.audioMux || this.originMs === null) return;
    if (packet.ptsMs < this.originMs) return;
    const relative = packet.ptsMs - this.originMs;
    this.enqueueAudio(
      this.audioMux.fragment(
        {
          data: packet.payload,
          ptsMs: packet.ptsMs,
          durationMs: packet.durationMs,
          keyframe: true,
        },
        relative,
      ),
    );
  }

  bufferMs(): number {
    const buffered = this.video.buffered;
    if (!buffered.length) return 0;
    const end = buffered.end(buffered.length - 1);
    return Math.max(0, Math.round((end - this.video.currentTime) * 1000));
  }

  transportState(): string {
    return this.open ? "MSE OPEN" : "MSE WAIT";
  }

  reset(): void {
    this.open = false;
    this.videoMux = null;
    this.audioMux = null;
    this.videoBuffer = null;
    this.audioBuffer = null;
    this.videoQueue = [];
    this.audioQueue = [];
    this.queuedVideoBytes = 0;
    this.queuedAudioBytes = 0;
    this.firstVideoKey = false;
    this.originMs = null;
    this.audioCodec = "";
    try {
      this.mediaSource?.endOfStream();
    } catch {
      // MediaSource may not be open anymore.
    }
    this.mediaSource = null;
    this.video.removeAttribute("src");
    this.video.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = "";
    this.audio.reset();
  }

  private setupMediaSource(): void {
    if (this.mediaSource || typeof MediaSource === "undefined") return;
    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;
    this.objectUrl = URL.createObjectURL(mediaSource);
    this.video.src = this.objectUrl;
    mediaSource.addEventListener("sourceopen", () => {
      if (this.mediaSource !== mediaSource) return;
      this.open = true;
      this.attachVideo();
      this.attachAudio();
      this.callbacks.onPlayback();
    });
    mediaSource.addEventListener("sourceclose", () => {
      if (this.mediaSource === mediaSource) this.open = false;
    });
  }

  private attachVideo(): void {
    if (!this.open || !this.videoMux || this.videoBuffer) return;
    try {
      const buffer = this.mediaSource?.addSourceBuffer(this.videoMux.mime);
      if (!buffer) return;
      buffer.mode = "segments";
      this.videoBuffer = buffer;
      buffer.addEventListener("updateend", () => {
        this.drainVideo();
        this.callbacks.onPlayback();
      });
      buffer.addEventListener("error", () => this.callbacks.onError("MSE 视频 SourceBuffer 错误"));
      const init = this.videoMux.initSegment();
      this.videoQueue.unshift(init);
      this.queuedVideoBytes += init.length;
      this.drainVideo();
    } catch (error) {
      this.callbacks.onError(`创建 MSE 视频轨失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private attachAudio(): void {
    if (!this.open || !this.audioMux || this.audioBuffer) return;
    try {
      const buffer = this.mediaSource?.addSourceBuffer(this.audioMux.mime);
      if (!buffer) return;
      buffer.mode = "segments";
      this.audioBuffer = buffer;
      buffer.addEventListener("updateend", () => this.drainAudio());
      buffer.addEventListener("error", () => this.callbacks.onError("MSE 音频 SourceBuffer 错误"));
      const init = this.audioMux.initSegment();
      this.audioQueue.unshift(init);
      this.queuedAudioBytes += init.length;
      this.drainAudio();
    } catch (error) {
      this.callbacks.onError(`创建 MSE 音频轨失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private enqueueVideo(data: Uint8Array): void {
    if (this.queuedVideoBytes + data.length > 8 * 1024 * 1024) {
      this.videoQueue = [];
      this.queuedVideoBytes = 0;
      this.firstVideoKey = false;
      this.callbacks.onNeedKeyframe();
      return;
    }
    this.videoQueue.push(data);
    this.queuedVideoBytes += data.length;
    this.drainVideo();
  }

  private enqueueAudio(data: Uint8Array): void {
    if (this.queuedAudioBytes + data.length > 4 * 1024 * 1024) {
      this.audioQueue = [];
      this.queuedAudioBytes = 0;
      return;
    }
    this.audioQueue.push(data);
    this.queuedAudioBytes += data.length;
    this.drainAudio();
  }

  private drainVideo(): void {
    const buffer = this.videoBuffer;
    if (!buffer || buffer.updating || this.videoQueue.length === 0 || !this.open) return;
    const next = this.videoQueue.shift();
    if (!next) return;
    this.queuedVideoBytes -= next.length;
    try {
      buffer.appendBuffer(next);
    } catch (error) {
      this.callbacks.onError(`MSE 追加视频失败: ${error instanceof Error ? error.message : String(error)}`);
      this.videoQueue = [];
      this.queuedVideoBytes = 0;
      this.callbacks.onNeedKeyframe();
    }
  }

  private drainAudio(): void {
    const buffer = this.audioBuffer;
    if (!buffer || buffer.updating || this.audioQueue.length === 0 || !this.open) return;
    const next = this.audioQueue.shift();
    if (!next) return;
    this.queuedAudioBytes -= next.length;
    try {
      buffer.appendBuffer(next);
    } catch (error) {
      this.callbacks.onError(`MSE 追加音频失败: ${error instanceof Error ? error.message : String(error)}`);
      this.audioQueue = [];
      this.queuedAudioBytes = 0;
    }
  }
}

class ViewerApp {
  private socket: WebSocket | null = null;
  private reconnectTimer = 0;
  private reconnectAttempts = 0;
  private totalReconnects = 0;
  private everOpened = false;
  private lastMessageAt = 0;
  private lastCloseReason = "";
  private source: SourceWire | null = null;
  private sourceGeneration = -1;
  private videoConfig: VideoConfig | null = null;
  private audioConfig: AudioConfig | null = null;
  private diag: DiagPayload | null = null;
  private mode: "webcodecs" | "mse" = "webcodecs";
  private hasRendered = false;
  private bytesReceived = 0;
  private lastBytes = 0;
  private lastStatsAt = performance.now();
  private renderedFrames = 0;
  private lastRenderedFrames = 0;
  private decodedFrames = 0;
  private lastRenderedAt = 0;
  private audio = new AudioSink();
  private webPlayer: WebCodecsPlayer;
  private msePlayer: MsePlayer;
  private statsTimer = 0;
  private watchdogTimer = 0;
  private lastKeyRequestAt = 0;
  private audioUnlockStarted = false;

  constructor() {
    this.webPlayer = new WebCodecsPlayer(this.audio, {
      onFrame: (frame) => this.drawFrame(frame),
      onError: (message) => {
        log(message);
        $("playback-state").textContent = "DECODE ERROR";
      },
      onNeedKeyframe: () => this.requestKeyframe("解码恢复"),
      onDecodedFrame: () => {
        this.decodedFrames++;
      },
    });
    this.msePlayer = new MsePlayer(videoElement, this.audio, {
      onError: (message) => log(message),
      onNeedKeyframe: () => this.requestKeyframe("MSE 缓冲恢复"),
      onPlayback: () => this.updateMetrics(),
    });
    this.bindControls();
    this.statsTimer = window.setInterval(() => this.updateMetrics(), 500);
    this.watchdogTimer = window.setInterval(() => this.checkWatchdog(), 2000);
    this.connect();
  }

  private bindControls(): void {
    $("join-button").addEventListener("click", () => this.requestKeyframe("手动重入"));
    $("mode-webcodecs").addEventListener("click", () => this.setMode("webcodecs"));
    $("mode-mse").addEventListener("click", () => this.setMode("mse"));
    soundButton.addEventListener("click", () => void this.unlockAudio());
    document.addEventListener(
      "pointerdown",
      () => {
        if (this.audio.sampleRate === 0) void this.unlockAudio();
      },
      { once: true },
    );
    volumeInput.addEventListener("input", () => {
      const volume = Number(volumeInput.value);
      this.audio.setVolume(volume);
      videoElement.volume = volume;
    });
    muteButton.addEventListener("click", () => {
      const muted = !this.audio.isMuted();
      this.audio.setMuted(muted);
      videoElement.muted = muted;
      muteButton.textContent = muted ? "取消静音" : "静音";
    });
    videoElement.volume = Number(volumeInput.value);
    window.addEventListener("online", () => {
      log("本机网络恢复，立即重连");
      this.connect();
    });
    window.addEventListener("offline", () => {
      log("本机网络已离线");
      this.showEmpty("本机网络离线", "恢复网络后将自动从最新关键帧重连");
    });
  }

  private async unlockAudio(): Promise<void> {
    if (this.audioUnlockStarted) return;
    this.audioUnlockStarted = true;
    try {
      await this.audio.unlock();
    } catch (error) {
      this.audioUnlockStarted = false;
      log(`WebAudio 启动失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(this.reconnectTimer);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    if (!this.everOpened) $("network-pill").textContent = "CONNECTING";
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.everOpened = true;
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      $("network-pill").textContent = "RELAY CONNECTED";
      log("WebSocket 已连接，请求最新 GOP");
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
      if (typeof event.data === "string") this.handleControl(event.data);
      else this.handleBinary(event.data as ArrayBuffer);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.lastCloseReason = event.reason || `code ${event.code}`;
      if (this.everOpened) this.totalReconnects++;
      $("reconnect-count").textContent = String(this.totalReconnects);
      log(`WebSocket 断开: ${this.lastCloseReason}`);
      this.showEmpty("中继连接断开", "正在退避重连，恢复后从最新关键帧加入");
      this.scheduleReconnect();
      this.updateDiagnosis();
    });
    socket.addEventListener("error", () => {
      log("WebSocket 连接错误");
    });
    this.updateDiagnosis();
  }

  private scheduleReconnect(): void {
    if (navigator.onLine === false) return;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(8000, 900 * 2 ** this.reconnectAttempts) + Math.round(Math.random() * 250);
    this.reconnectAttempts++;
    $("network-pill").textContent = `RETRY ${Math.round(delay / 100) / 10}s`;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private checkWatchdog(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastMessageAt <= 6000) return;
    log("6 秒未收到中继心跳，主动重建连接");
    this.socket.close(4000, "heartbeat-timeout");
  }

  private handleControl(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      log("收到无法解析的控制消息");
      return;
    }
    if (message.type === "hello") {
      const source = message.source as SourceWire | undefined;
      if (source) this.handleSource(source);
      log(`中继会话已建立，客户端 #${String(message.clientId ?? "?")}`);
    } else if (message.type === "source") {
      this.handleSource(message as unknown as SourceWire);
    } else if (message.type === "track-config") {
      const video = message.video as { codec?: string } | undefined;
      const audio = message.audio as { codec?: string } | undefined;
      log(`轨道配置: ${video?.codec ?? audio?.codec ?? "unknown"}`);
    } else if (message.type === "diag") {
      this.diag = message as unknown as DiagPayload;
      if (this.diag.source) this.handleSource(this.diag.source as unknown as SourceWire, false);
      this.updateMetrics();
      this.updateDiagnosis();
    }
  }

  private handleSource(source: SourceWire, reset = true): void {
    const changed = this.sourceGeneration >= 0 && source.generation !== this.sourceGeneration;
    this.source = source;
    if (changed && reset) {
      this.sourceGeneration = source.generation;
      this.resetPlayback();
      log(`源流代次切换 GEN ${source.generation}`);
    }
    this.sourceGeneration = source.generation;
    if (source.state === "online") {
      $("source-label").textContent = `${source.protocol} · GEN ${source.generation}`;
      if (changed) this.showEmpty("源流已重连", "等待新代次的关键帧");
    } else {
      $("source-label").textContent = "源流中断";
      const reason = source.reason === "source-timeout" ? "源端 5 秒无媒体" : "制作机连接已断开";
      this.showEmpty("源流没了", `${reason}；中继继续服务其他观看端`);
    }
    this.updateMetrics();
    this.updateDiagnosis();
  }

  private handleBinary(buffer: ArrayBuffer): void {
    const packet = parsePacket(buffer);
    if (!packet) return;
    this.bytesReceived += buffer.byteLength;
    if (packet.kind === KIND_VIDEO_CONFIG) {
      this.videoConfig = {
        codec: this.source?.video?.codec ?? "avc1.42001f",
        width: this.source?.video?.width ?? 1280,
        height: this.source?.video?.height ?? 720,
        description: packet.payload.slice(),
      };
      if (this.mode === "webcodecs") this.webPlayer.setVideoConfig(this.videoConfig);
      else this.msePlayer.setVideoConfig(this.videoConfig);
      this.showEmpty("等待关键帧", "已收到编解码配置，从关键帧开始解码");
      return;
    }
    if (packet.kind === KIND_AUDIO_CONFIG) {
      this.audioConfig = {
        codec: this.source?.audio?.codec ?? "pcm-s16",
        sampleRate: this.source?.audio?.sampleRate ?? 44100,
        channels: this.source?.audio?.channels ?? 1,
        description: packet.payload.slice(),
      };
      if (this.mode === "webcodecs") this.webPlayer.setAudioConfig(this.audioConfig);
      else this.msePlayer.setAudioConfig(this.audioConfig);
      return;
    }
    if (packet.kind === KIND_VIDEO_SAMPLE) {
      this.lastRenderedAt = performance.now();
      if (this.mode === "webcodecs") this.webPlayer.pushVideo(packet);
      else {
        this.msePlayer.pushVideo(packet);
        if (packet.flags & FLAG_KEYFRAME) this.markRendered();
      }
    } else if (packet.kind === KIND_AUDIO_SAMPLE) {
      if (this.mode === "webcodecs") this.webPlayer.pushAudio(packet);
      else this.msePlayer.pushAudio(packet);
    }
  }

  private setMode(mode: "webcodecs" | "mse"): void {
    if (this.mode === mode) return;
    if (mode === "mse") {
      if (typeof MediaSource === "undefined") {
        log("此浏览器不支持 MediaSource");
        return;
      }
      if (this.videoConfig && !MsePlayer.supported(this.videoConfig.codec)) {
        log(`MSE 不支持当前编码 ${this.videoConfig.codec}`);
        return;
      }
    }
    this.mode = mode;
    this.webPlayer.reset();
    this.msePlayer.reset();
    this.hasRendered = false;
    stageShell.classList.toggle("mse", mode === "mse");
    $("mode-webcodecs").classList.toggle("active", mode === "webcodecs");
    $("mode-mse").classList.toggle("active", mode === "mse");
    $("hud-mode").textContent = mode === "mse" ? "MSE / FMP4" : "WEBCODECS / CANVAS";
    $("transport-mode").textContent =
      mode === "mse" ? "MSE → fMP4 · video element" : "WebCodecs → Canvas · WebAudio";
    this.showEmpty(mode === "mse" ? "切换至 MSE" : "切换至 WebCodecs", "等待服务端重放最新 GOP");
    log(`播放模式切换为 ${mode === "mse" ? "MediaSource" : "WebCodecs"}`);
    this.requestKeyframe("切换播放模式", true);
  }

  private requestKeyframe(reason: string, force = false): void {
    const now = Date.now();
    if (!force && now - this.lastKeyRequestAt < 1000) return;
    this.lastKeyRequestAt = now;
    if (this.mode === "mse" && force) this.msePlayer.reset();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "request-keyframe" }));
      log(`请求最新关键帧: ${reason}`);
      this.showEmpty("重新同步关键帧", "服务端正在重放最新 GOP 起点");
    } else {
      log(`无法请求关键帧（中继未连接）: ${reason}`);
    }
  }

  private drawFrame(frame: VideoFrame): void {
    try {
      if (this.mode !== "webcodecs") return;
      const width = frame.displayWidth || frame.codedWidth;
      const height = frame.displayHeight || frame.codedHeight;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(frame, 0, 0, width, height);
      this.renderedFrames++;
      this.lastRenderedAt = performance.now();
      this.markRendered();
    } finally {
      frame.close();
    }
  }

  private markRendered(): void {
    this.hasRendered = true;
    stageEmpty.classList.add("hidden");
  }

  private resetPlayback(): void {
    this.webPlayer.reset();
    this.msePlayer.reset();
    this.videoConfig = null;
    this.audioConfig = null;
    this.hasRendered = false;
    this.lastRenderedAt = 0;
    this.showEmpty("等待关键帧", "等待新源代次的编解码配置");
  }

  private updateMetrics(): void {
    const now = performance.now();
    const seconds = Math.max(0.2, (now - this.lastStatsAt) / 1000);
    const bitrate = Math.round(((this.bytesReceived - this.lastBytes) * 8) / seconds / 1000);
    const fps = Math.round((this.renderedFrames - this.lastRenderedFrames) / seconds);
    this.lastStatsAt = now;
    this.lastBytes = this.bytesReceived;
    this.lastRenderedFrames = this.renderedFrames;

    const resolution = this.videoConfig ? `${this.videoConfig.width}×${this.videoConfig.height}` : "—";
    const codec = this.videoConfig?.codec ?? "—";
    const decodeQueue = this.mode === "webcodecs" ? this.webPlayer.decodeQueueSize() : 0;
    const bufferMs = this.mode === "mse" ? this.msePlayer.bufferMs() : decodeQueue * 33;
    const wsBuffered = this.socket?.bufferedAmount ?? 0;
    $("metric-resolution").textContent = resolution;
    $("metric-codec").textContent = codec;
    $("metric-bitrate").textContent = `${bitrate} kbps`;
    $("metric-decode-queue").textContent = String(decodeQueue);
    $("metric-buffer").textContent = `${bufferMs} ms`;
    $("metric-ws-buffer").textContent = formatBytes(wsBuffered);
    $("metric-cache").textContent = formatBytes(this.diag?.cache.bytes ?? 0);
    $("metric-dropped").textContent = formatBytes(this.diag?.self.droppedBytes ?? 0);
    $("hud-codec").textContent = this.videoConfig ? `${this.videoConfig.codec} / ${resolution}` : "—";
    $("hud-fps").textContent = `${fps} FPS`;
    $("hud-latency").textContent = `延迟约 ${Math.max(20, Math.round(bufferMs + (this.mode === "webcodecs" ? 30 : 0)))} ms`;
    $("source-generation").textContent = `GEN ${this.source?.generation ?? 0}`;
    $("source-protocol").textContent = this.source?.protocol ?? "—";
    $("source-reconnects").textContent = String(this.source?.reconnectCount ?? 0);
    $("source-last-seen").textContent = this.source?.lastSeenAt
      ? this.source.state === "online"
        ? `${Math.max(0, Math.round((Date.now() - this.source.lastSeenAt) / 1000))} 秒前`
        : new Date(this.source.lastSeenAt).toLocaleTimeString("zh-CN", { hour12: false })
      : "—";
    this.updateDiagnosis();
    const state = this.socket?.readyState;
    if (state === WebSocket.OPEN) {
      const queueMs = this.mode === "mse" ? this.msePlayer.bufferMs() : decodeQueue * 33;
      this.socket.send(JSON.stringify({ type: "stats", queueMs }));
    }
  }

  private updateDiagnosis(): void {
    const now = Date.now();
    const wsOpen = this.socket?.readyState === WebSocket.OPEN;
    const offline = navigator.onLine === false;
    const sourceOnline = this.source?.state === "online";
    const sourceQuiet = sourceOnline && !!this.source?.lastSeenAt && now - this.source.lastSeenAt > 3000;
    const queue = this.mode === "webcodecs" ? this.webPlayer.decodeQueueSize() : 0;
    const buffered = this.mode === "mse" ? this.msePlayer.bufferMs() : queue * 33;
    const wsBuffered = this.socket?.bufferedAmount ?? 0;
    const stalled = sourceOnline && wsOpen && this.hasRendered && this.lastRenderedAt > 0 && now - this.lastRenderedAt > 3000;
    const clientSlow =
      this.diag?.self.state === "slow" ||
      queue > 24 ||
      wsBuffered > 2 * 1024 * 1024 ||
      buffered > 4000 ||
      (stalled && !sourceQuiet);
    let kind: "unknown" | "live" | "slow" | "source" | "network" = "live";
    let title = "画面正常";
    let text = "已从最新关键帧加入；每个观看连接独立排队，源端不会被慢客户端阻塞。";
    if (offline || !wsOpen) {
      kind = "network";
      title = offline ? "本机网络离线" : "中继连接断开";
      text = offline
        ? "浏览器报告离线。恢复后将自动退避重连并从最新关键帧加入。"
        : `WebSocket ${this.lastCloseReason || "未连接"}；源流与其他观众不受影响。`;
    } else if (!sourceOnline || sourceQuiet) {
      kind = "source";
      title = sourceOnline ? "源流暂时无帧" : "源流已中断";
      text = this.source
        ? sourceOnline
          ? "中继连接正常，但 3 秒未收到媒体帧；等待制作机恢复出帧或重连。"
          : "中继仍在线，等待制作机重连。其他观看端不会因本机状态被卡住。"
        : "尚未收到任何制作机源流。";
    } else if (clientSlow) {
      kind = "slow";
      title = "本机播放偏慢";
      text = "服务端队列或本机解码出现积压，将跳到下一关键帧；不会拖慢源流和其他客户端。";
    }
    const card = $("diagnosis-card");
    card.className = `diagnosis-card ${kind}`;
    $("diagnosis-title").textContent = title;
    $("diagnosis-text").textContent = text;
    $("diag-source").textContent = this.source
      ? sourceOnline
        ? sourceQuiet
          ? "在线但无帧"
          : `在线 · GEN ${this.source.generation}`
        : "中断"
      : "无源";
    $("diag-network").textContent = offline ? "本机离线" : wsOpen ? "已连接" : "断开重连中";
    $("diag-client").textContent = clientSlow
      ? `拥塞 · 跳过 ${this.diag?.self.skippedFrames ?? 0} 帧`
      : "正常";
    const playbackState = kind === "network" ? "RETRYING" : kind === "source" ? "SOURCE LOST" : clientSlow ? "BACKPRESSURE" : this.hasRendered ? "LIVE" : "JOINING";
    $("playback-state").textContent = playbackState;
    $("play-dot").className = `play-dot ${kind === "live" && this.hasRendered ? "live" : clientSlow ? "slow" : ""}`;
    if (wsOpen) $("network-pill").textContent = "RELAY CONNECTED";
    if (offline) $("network-pill").textContent = "LOCAL OFFLINE";
  }

  private showEmpty(title: string, detail: string): void {
    const heading = stageEmpty.querySelector("b");
    const description = stageEmpty.querySelector("small");
    if (heading) heading.textContent = title;
    if (description) description.textContent = detail;
    stageEmpty.classList.remove("hidden");
  }
}

const app = new ViewerApp();
void app;
log("观看端就绪：自动连接中继并从最新关键帧加入");
