// Browser-side helpers: frame grabbing (WebCodecs with canvas fallback),
// WebAudio feedback, and corrected-stream recording with a MediaSource
// live monitor (falls back to plain blob collection).

const scratch = document.createElement("canvas");
const scratchCtx = scratch.getContext("2d", { willReadFrequently: true })!;

// Grab the current video frame as RGBA at (w, h).
// Uses WebCodecs VideoFrame.copyTo at native size; scales via Canvas2D
// otherwise (and as a general fallback).
export async function grabRGBA(video: HTMLVideoElement, w: number, h: number): Promise<Uint8ClampedArray> {
  if (typeof VideoFrame !== "undefined" && w === video.videoWidth && h === video.videoHeight) {
    let frame: VideoFrame | null = null;
    try {
      frame = new VideoFrame(video);
      const size = frame.allocationSize({ format: "RGBA" } as VideoFrameCopyToOptions);
      const buf = new Uint8ClampedArray(size);
      await frame.copyTo(buf, { format: "RGBA" } as VideoFrameCopyToOptions);
      return buf;
    } catch {
      // fall through to canvas path
    } finally {
      frame?.close();
    }
  }
  scratch.width = w;
  scratch.height = h;
  scratchCtx.drawImage(video, 0, 0, w, h);
  const data = scratchCtx.getImageData(0, 0, w, h);
  return new Uint8ClampedArray(data.data.buffer.slice(0));
}

// --- WebAudio feedback -------------------------------------------------

let audioCtx: AudioContext | null = null;

export function beep(freq = 880, seconds = 0.07): void {
  try {
    audioCtx ??= new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + seconds);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + seconds);
  } catch {
    // audio feedback is best-effort
  }
}

// --- Recording with MediaSource live monitor ---------------------------

const MIME_CANDIDATES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

export class StreamRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private appendQueue: ArrayBuffer[] = [];
  private monitorUrl = "";
  private monitor: HTMLVideoElement;
  mime = "";

  constructor(monitor: HTMLVideoElement) {
    this.monitor = monitor;
  }

  get active(): boolean {
    return this.recorder !== null;
  }

  start(canvas: HTMLCanvasElement, fps = 30): boolean {
    if (this.recorder) return false;
    this.mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    if (!this.mime) return false;
    this.chunks = [];
    this.appendQueue = [];
    this.setupMonitor();
    const stream = canvas.captureStream(fps);
    this.recorder = new MediaRecorder(stream, { mimeType: this.mime });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      this.chunks.push(e.data);
      e.data.arrayBuffer().then((buf) => this.appendToMonitor(buf));
    };
    this.recorder.start(250);
    return true;
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const rec = this.recorder;
      if (!rec) {
        resolve(new Blob([], { type: this.mime }));
        return;
      }
      rec.onstop = () => {
        this.recorder = null;
        try {
          if (this.mediaSource && this.mediaSource.readyState === "open") {
            this.flushQueue();
            if (!this.sourceBuffer || !this.sourceBuffer.updating) this.mediaSource.endOfStream();
          }
        } catch {
          // monitor teardown is best-effort
        }
        resolve(new Blob(this.chunks, { type: this.mime }));
      };
      rec.stop();
    });
  }

  private setupMonitor(): void {
    this.mediaSource = null;
    this.sourceBuffer = null;
    if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(this.mime)) return;
    const ms = new MediaSource();
    this.mediaSource = ms;
    this.monitorUrl = URL.createObjectURL(ms);
    this.monitor.src = this.monitorUrl;
    ms.addEventListener("sourceopen", () => {
      try {
        this.sourceBuffer = ms.addSourceBuffer(this.mime);
        this.sourceBuffer.addEventListener("updateend", () => this.flushQueue());
        this.flushQueue();
        this.monitor.play().catch(() => {});
      } catch {
        this.mediaSource = null;
      }
    });
  }

  private appendToMonitor(buf: ArrayBuffer): void {
    this.appendQueue.push(buf);
    this.flushQueue();
  }

  private flushQueue(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.appendQueue.length === 0) return;
    const buf = this.appendQueue.shift()!;
    try {
      sb.appendBuffer(buf);
    } catch {
      // live monitor is optional; keep recording regardless
      this.sourceBuffer = null;
      this.appendQueue = [];
    }
  }
}
