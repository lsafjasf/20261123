const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("program-canvas");
const context = canvas.getContext("2d", { alpha: false }) as CanvasRenderingContext2D;
const startButton = $<HTMLButtonElement>("start-button");
const stopButton = $<HTMLButtonElement>("stop-button");
const sourcePill = $<HTMLSpanElement>("source-pill");
const sourceState = $<HTMLElement>("source-state");
const codecLabel = $<HTMLElement>("codec-label");
const scope = $<HTMLCanvasElement>("audio-scope");
const scopeContext = scope.getContext("2d") as CanvasRenderingContext2D;

const WORKLET_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      const copy = channel.slice();
      this.port.postMessage(copy.buffer, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
`;

function flvTag(type: number, timestamp: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + body.length + 4);
  out[0] = type;
  out[1] = (body.length >>> 16) & 0xff;
  out[2] = (body.length >>> 8) & 0xff;
  out[3] = body.length & 0xff;
  out[4] = timestamp & 0xff;
  out[5] = (timestamp >>> 8) & 0xff;
  out[6] = (timestamp >>> 16) & 0xff;
  out[7] = (timestamp >>> 24) & 0xff;
  out.set(body, 11);
  const size = 11 + body.length;
  out[size] = (size >>> 24) & 0xff;
  out[size + 1] = (size >>> 16) & 0xff;
  out[size + 2] = (size >>> 8) & 0xff;
  out[size + 3] = size & 0xff;
  return out;
}

function flvHeader(): Uint8Array {
  const header = new Uint8Array(13);
  header.set([0x46, 0x4c, 0x56, 0x01, 0x05, 0, 0, 0, 9], 0);
  return header;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function log(message: string): void {
  const list = $<HTMLOListElement>("event-log");
  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  item.textContent = `${time}  ${message}`;
  list.prepend(item);
  while (list.children.length > 40) list.lastElementChild?.remove();
}

class LocalSource {
  private running = false;
  private socket: WebSocket | null = null;
  private reconnectTimer = 0;
  private encoder: VideoEncoder | null = null;
  private videoConfigTag: Uint8Array | null = null;
  private encodeChain: Promise<void> = Promise.resolve();
  private audioContext: AudioContext | null = null;
  private audioNode: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private pcm = new Float32Array(882 * 4);
  private pcmLength = 0;
  private audioSamples = 0;
  private startedAt = 0;
  private lastFrameAt = 0;
  private frameIndex = 0;
  private forceKeyframe = true;
  private raf = 0;
  private statsTimer = 0;
  private scopeRaf = 0;
  private sentBytes = 0;
  private lastStatsBytes = 0;
  private lastStatsAt = 0;
  private currentBitrate = 0;
  private currentFps = 0;
  private framesSinceStats = 0;

  constructor() {
    startButton.addEventListener("click", () => void this.start());
    stopButton.addEventListener("click", () => void this.stop());
  }

  private async start(): Promise<void> {
    if (this.running) return;
    if (typeof VideoEncoder === "undefined") {
      log("此浏览器没有 WebCodecs VideoEncoder");
      return;
    }
    this.running = true;
    startButton.disabled = true;
    stopButton.disabled = false;
    sourcePill.textContent = "SOURCE STARTING";
    sourceState.textContent = "启动中";
    this.startedAt = performance.now();
    this.lastFrameAt = 0;
    this.lastStatsAt = this.startedAt;
    this.forceKeyframe = true;
    try {
      await this.setupAudio();
      await this.setupEncoder();
      this.connect();
      this.raf = requestAnimationFrame((now) => this.frame(now));
      this.statsTimer = window.setInterval(() => this.refreshStats(), 500);
      this.scopeRaf = requestAnimationFrame(() => this.drawScope());
      log("本地 Canvas 制作机已启动");
    } catch (error) {
      log(`启动失败: ${error instanceof Error ? error.message : String(error)}`);
      await this.stop();
    }
  }

  private async stop(): Promise<void> {
    this.running = false;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.scopeRaf);
    clearInterval(this.statsTimer);
    clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "source stopped");
    this.socket = null;
    try {
      this.encoder?.close();
    } catch {
      // Encoder may already be closed by a browser error.
    }
    this.encoder = null;
    this.audioNode?.disconnect();
    this.audioContext?.close();
    this.audioContext = null;
    this.audioNode = null;
    this.analyser = null;
    startButton.disabled = false;
    stopButton.disabled = true;
    sourcePill.textContent = "SOURCE IDLE";
    sourceState.textContent = "待机";
    codecLabel.textContent = "H.264 · WebCodecs";
    log("出流已停止");
  }

  private async setupEncoder(): Promise<void> {
    const candidates: VideoEncoderConfig[] = [
      { codec: "avc1.42001f", width: 960, height: 540, bitrate: 1_800_000, framerate: 30, latencyMode: "realtime", avc: { format: "avc" } },
      { codec: "avc1.42E01E", width: 960, height: 540, bitrate: 1_800_000, framerate: 30, latencyMode: "realtime", avc: { format: "avc" } },
      { codec: "avc1.4D401E", width: 960, height: 540, bitrate: 1_800_000, framerate: 30, latencyMode: "realtime", avc: { format: "avc" } },
    ];
    let selected: VideoEncoderConfig | null = null;
    for (const candidate of candidates) {
      try {
        const support = await VideoEncoder.isConfigSupported(candidate);
        if (support.supported) {
          selected = support.config ?? candidate;
          break;
        }
      } catch {
        // Try the next H.264 profile.
      }
    }
    if (!selected) throw new Error("浏览器不支持 H.264 WebCodecs 编码");
    codecLabel.textContent = `${selected.codec} · ${selected.width}×${selected.height}`;
    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        this.encodeChain = this.encodeChain
          .then(() => this.handleEncodedChunk(chunk, metadata))
          .catch((error) => log(`编码回调失败: ${String(error)}`));
      },
      error: (error) => {
        log(`VideoEncoder: ${error.message}`);
      },
    });
    encoder.configure(selected);
    this.encoder = encoder;
    log(`编码器就绪: ${selected.codec}`);
  }

  private async setupAudio(): Promise<void> {
    const audio = new AudioContext({ sampleRate: 44100 });
    await audio.resume();
    const oscillator = audio.createOscillator();
    const second = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.value = 220;
    second.type = "sine";
    second.frequency.value = 330;
    gain.gain.value = 0.035;
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    oscillator.connect(gain);
    second.connect(gain);
    gain.connect(analyser);
    analyser.connect(audio.destination);

    const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    await audio.audioWorklet.addModule(moduleUrl);
    URL.revokeObjectURL(moduleUrl);
    const node = new AudioWorkletNode(audio, "pcm-tap");
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (this.running) this.capturePcm(new Float32Array(event.data));
    };
    gain.connect(node);
    node.connect(audio.destination);
    oscillator.start();
    second.start();
    this.audioContext = audio;
    this.audioNode = node;
    this.analyser = analyser;
    $("audio-state").textContent = "采集中";
    log("WebAudio 44.1 kHz PCM 抓取已启动");
  }

  private connect(): void {
    if (!this.running) return;
    clearTimeout(this.reconnectTimer);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/source`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    sourcePill.textContent = "SOURCE CONNECTING";
    sourceState.textContent = "连接中";
    socket.addEventListener("open", () => {
      if (this.socket !== socket || !this.running) return;
      socket.send(flvHeader());
      if (this.videoConfigTag) socket.send(this.videoConfigTag);
      this.forceKeyframe = true;
      sourcePill.textContent = "SOURCE LIVE";
      sourceState.textContent = "推流中";
      log("FLV/WebSocket 已连接，强制下一帧为关键帧");
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.running) return;
      sourcePill.textContent = "SOURCE RECONNECTING";
      sourceState.textContent = "源端重连";
      log("源连接断开，1.2 秒后重连");
      this.reconnectTimer = window.setTimeout(() => this.connect(), 1200);
    });
    socket.addEventListener("error", () => {
      log("源 WebSocket 发生错误");
    });
  }

  private sendTag(tag: Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) {
      $("source-state").textContent = "源端背压";
      return;
    }
    socket.send(tag);
    this.sentBytes += tag.byteLength;
  }

  private async handleEncodedChunk(chunk: EncodedVideoChunk, metadata: EncodedVideoChunkMetadata | undefined): Promise<void> {
    const data = new Uint8Array(chunk.byteLength);
    await chunk.copyTo(data);
    const description = metadata?.decoderConfig?.description;
    if (description && !this.videoConfigTag) {
      const bytes = description instanceof ArrayBuffer ? new Uint8Array(description) : new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
      const body = new Uint8Array(5 + bytes.length);
      body.set([0x17, 0x00, 0x00, 0x00, 0x00], 0);
      body.set(bytes, 5);
      this.videoConfigTag = flvTag(9, 0, body);
      this.sendTag(this.videoConfigTag);
      log(`AVC 序列头已发送 (${bytes.length} B)`);
    }
    const body = new Uint8Array(5 + data.length);
    body[0] = chunk.type === "key" ? 0x17 : 0x27;
    body[1] = 0x01;
    body[2] = 0;
    body[3] = 0;
    body[4] = 0;
    body.set(data, 5);
    const timestamp = Math.max(0, Math.round(chunk.timestamp / 1000));
    this.sendTag(flvTag(9, timestamp, body));
  }

  private capturePcm(block: Float32Array): void {
    let offset = 0;
    while (offset < block.length) {
      const remaining = this.pcm.length - this.pcmLength;
      const take = Math.min(remaining, block.length - offset);
      this.pcm.set(block.subarray(offset, offset + take), this.pcmLength);
      this.pcmLength += take;
      offset += take;
      if (this.pcmLength === this.pcm.length) {
        this.emitPcm(this.pcm);
        this.pcmLength = 0;
      }
    }
  }

  private emitPcm(samples: Float32Array): void {
    const body = new Uint8Array(1 + samples.length * 2);
    body[0] = 0x3e;
    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(-1, Math.min(1, samples[i]));
      const pcm = value < 0 ? value * 32768 : value * 32767;
      body[1 + i * 2] = pcm & 0xff;
      body[2 + i * 2] = (pcm >> 8) & 0xff;
    }
    const timestamp = Math.round((this.audioSamples / 44100) * 1000);
    this.audioSamples += samples.length;
    this.sendTag(flvTag(8, timestamp, body));
  }

  private frame(now: number): void {
    if (!this.running) return;
    this.raf = requestAnimationFrame((next) => this.frame(next));
    if (now - this.lastFrameAt < 32) return;
    this.lastFrameAt = now;
    this.drawScene(now);
    const encoder = this.encoder;
    if (!encoder || encoder.state !== "configured" || encoder.encodeQueueSize > 4) return;
    if (this.socket?.bufferedAmount && this.socket.bufferedAmount > 2 * 1024 * 1024) return;
    const timestamp = Math.round(now - this.startedAt) * 1000;
    const videoFrame = new VideoFrame(canvas, { timestamp });
    const keyFrame = this.forceKeyframe || this.frameIndex % 60 === 0;
    try {
      encoder.encode(videoFrame, { keyFrame });
      this.forceKeyframe = false;
      this.frameIndex++;
      this.framesSinceStats++;
    } finally {
      videoFrame.close();
    }
  }

  private drawScene(now: number): void {
    const width = canvas.width;
    const height = canvas.height;
    const time = now / 1000;
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#07131c");
    gradient.addColorStop(0.55, "#09222a");
    gradient.addColorStop(1, "#081016");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    context.save();
    context.globalAlpha = 0.2;
    context.strokeStyle = "#5ce1e6";
    context.lineWidth = 1;
    for (let x = -600; x < width + 600; x += 64) {
      context.beginPath();
      context.moveTo(width / 2, 280);
      context.lineTo(x, height);
      context.stroke();
    }
    for (let i = 0; i < 12; i++) {
      const y = 280 + ((time * 28 + i * 28) % 260);
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    context.restore();

    context.save();
    context.translate(width / 2, 300);
    context.strokeStyle = "rgba(92,225,230,.55)";
    context.lineWidth = 2;
    context.beginPath();
    context.ellipse(0, 0, 258, 120, 0, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = "rgba(255,173,90,.25)";
    context.beginPath();
    context.ellipse(0, 0, 150, 70, 0, 0, Math.PI * 2);
    context.stroke();
    context.restore();

    const arenaGradient = context.createRadialGradient(width / 2, 300, 10, width / 2, 300, 430);
    arenaGradient.addColorStop(0, "rgba(92,225,230,.12)");
    arenaGradient.addColorStop(1, "rgba(92,225,230,0)");
    context.fillStyle = arenaGradient;
    context.fillRect(0, 0, width, height);

    const agents = [
      { x: width / 2 + Math.cos(time * 0.8) * 210, y: 300 + Math.sin(time * 1.15) * 74, color: "#5ce1e6", name: "A/04" },
      { x: width / 2 + Math.cos(time * 0.6 + 2.7) * 175, y: 300 + Math.sin(time * 0.9 + 1.2) * 95, color: "#ffad5a", name: "B/12" },
      { x: width / 2 + Math.cos(time * 1.02 + 4.1) * 132, y: 300 + Math.sin(time * 1.4 + 0.4) * 48, color: "#70e0a0", name: "C/07" },
    ];
    for (const agent of agents) {
      context.save();
      context.globalAlpha = 0.18;
      context.fillStyle = agent.color;
      context.beginPath();
      context.arc(agent.x - Math.cos(time) * 24, agent.y - Math.sin(time) * 12, 26, 0, Math.PI * 2);
      context.fill();
      context.restore();
      context.fillStyle = "#07131c";
      context.strokeStyle = agent.color;
      context.lineWidth = 3;
      context.beginPath();
      context.arc(agent.x, agent.y, 12, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.fillStyle = agent.color;
      context.font = "10px monospace";
      context.fillText(agent.name, agent.x + 17, agent.y + 4);
    }

    context.fillStyle = "rgba(3, 8, 12, .88)";
    context.fillRect(26, 22, width - 52, 76);
    context.strokeStyle = "rgba(92,225,230,.28)";
    context.strokeRect(26, 22, width - 52, 76);
    context.fillStyle = "#8da0b2";
    context.font = "10px monospace";
    context.fillText("LAN // ARENA 04", 46, 44);
    context.fillStyle = "#edf4f8";
    context.font = "700 28px monospace";
    context.fillText("RIFT", 46, 79);
    context.fillStyle = "#5ce1e6";
    context.fillText("12", 143, 79);
    context.fillStyle = "#edf4f8";
    context.fillText(":", 191, 79);
    context.fillStyle = "#ffad5a";
    context.fillText("09", 222, 79);
    context.fillStyle = "#edf4f8";
    context.fillText("NEXUS", 278, 79);
    const seconds = 22 - (Math.floor(time) % 23);
    context.textAlign = "right";
    context.fillStyle = seconds <= 5 ? "#ff6b72" : "#edf4f8";
    context.font = "700 30px monospace";
    context.fillText(`00:${String(seconds).padStart(2, "0")}`, width - 46, 79);
    context.textAlign = "left";

    context.fillStyle = "rgba(3, 8, 12, .82)";
    context.fillRect(26, height - 94, width - 52, 66);
    context.strokeStyle = "rgba(255,173,90,.22)";
    context.strokeRect(26, height - 94, width - 52, 66);
    context.fillStyle = "#8da0b2";
    context.font = "9px monospace";
    context.fillText("SIMULATED LOCAL MEDIA · NO PUBLIC NETWORK", 44, height - 69);
    context.fillStyle = "#5ce1e6";
    context.font = "11px monospace";
    context.fillText(`FRAME ${String(this.frameIndex).padStart(6, "0")}  //  ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`, 44, height - 46);
    const level = 0.2 + Math.abs(Math.sin(time * 2.1)) * 0.65;
    context.fillStyle = "#ffad5a";
    context.fillRect(width - 242, height - 57, 180 * level, 5);
    context.fillStyle = "#1d2b37";
    context.fillRect(width - 242, height - 57, 180, 5);
    context.fillStyle = "#ffad5a";
    context.fillRect(width - 242, height - 57, 180 * level, 5);

    context.strokeStyle = "rgba(92,225,230,.3)";
    context.strokeRect(13, 13, width - 26, height - 26);
    context.fillStyle = "rgba(255,255,255,.3)";
    context.font = "8px monospace";
    context.fillText("PROGRAM · 960×540 · 30P", width - 162, 43);
  }

  private refreshStats(): void {
    const now = performance.now();
    const deltaBytes = this.sentBytes - this.lastStatsBytes;
    const deltaSeconds = Math.max(0.1, (now - this.lastStatsAt) / 1000);
    this.currentBitrate = Math.round((deltaBytes * 8) / deltaSeconds / 1000);
    this.currentFps = Math.round(this.framesSinceStats / deltaSeconds);
    this.lastStatsBytes = this.sentBytes;
    this.lastStatsAt = now;
    this.framesSinceStats = 0;
    $("video-bitrate").textContent = `${this.currentBitrate} kbps`;
    $("fps").textContent = String(this.currentFps);
    $("sent-bytes").textContent = formatBytes(this.sentBytes);
    $("encode-queue").textContent = String(this.encoder?.encodeQueueSize ?? 0);
    $("audio-state").textContent = this.socket?.readyState === WebSocket.OPEN ? "随流发送" : "停止发送";
    if (this.socket?.readyState === WebSocket.OPEN) {
      sourcePill.textContent = "SOURCE LIVE";
      sourceState.textContent = "推流中";
      sourcePill.classList.add("live");
    } else {
      sourcePill.classList.remove("live");
    }
  }

  private drawScope(): void {
    if (!this.running) return;
    this.scopeRaf = requestAnimationFrame(() => this.drawScope());
    scopeContext.fillStyle = "#070b10";
    scopeContext.fillRect(0, 0, scope.width, scope.height);
    scopeContext.strokeStyle = "rgba(92,225,230,.14)";
    scopeContext.beginPath();
    scopeContext.moveTo(0, scope.height / 2);
    scopeContext.lineTo(scope.width, scope.height / 2);
    scopeContext.stroke();
    if (!this.analyser) return;
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    scopeContext.strokeStyle = "#5ce1e6";
    scopeContext.lineWidth = 1.4;
    scopeContext.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * scope.width;
      const y = (data[i] / 255) * scope.height;
      if (i === 0) scopeContext.moveTo(x, y);
      else scopeContext.lineTo(x, y);
    }
    scopeContext.stroke();
  }
}

const source = new LocalSource();
void source;
log("就绪：点击“开始出流”启动本地 Canvas/WebCodecs/WebAudio 模拟源");

window.addEventListener("beforeunload", () => {
  startButton.disabled = true;
  stopButton.click();
});
