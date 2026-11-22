/**
 * 发送端测量引擎。
 * 管线：getUserMedia -> CaptureWorklet -> ProcessWorklet ->
 *       WebCodecs AudioEncoder(Opus) -> WebmMuxer -> WebSocket 媒体帧。
 * 每个标记沿管线记录 T0/T1/T2/T3，并通过控制通道同步给接收端与服务端。
 */

import { MarkerGenerator } from '../audio/marker-generator.ts';
import { WebmMuxer, type OpusPacket } from '../mux/webm-muxer.ts';
import {
  encodeControl,
  encodeMediaFrame,
  type ControlMessage,
} from '../../shared/protocol.ts';
import type { MarkerTimeline, StageId } from '../../shared/types.ts';
import type { ClockBridge } from '../transport/clock-bridge.ts';

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const ENCODER_FRAME_MS = 20;

export interface SenderOptions {
  roundId: string;
  label: string;
  ws: WebSocket;
  clock: ClockBridge;
  flashCanvas: HTMLCanvasElement;
  useLoopback?: boolean;
}

export interface SenderEvents {
  onMarker: (marker: MarkerTimeline) => void;
  onDrop: (detail: string, stage: StageId | 'network') => void;
  onStatus: (status: string) => void;
}

export class SenderEngine {
  private readonly options: SenderOptions;
  private readonly events: SenderEvents;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private encoder: AudioEncoder | null = null;
  private muxer = new WebmMuxer({
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
  });
  private markerGenerator: MarkerGenerator | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private markers = new Map<number, MarkerTimeline>();
  private pendingPcm: Float32Array[] = [];
  private pendingSamples = 0;
  private frameSeq = 0;
  private fireTimer: ReturnType<typeof setInterval> | null = null;
  private initSent = false;
  private nodeRefs: AudioNode[] = [];

  constructor(options: SenderOptions, events: SenderEvents) {
    this.options = options;
    this.events = events;
  }

  async start(): Promise<void> {
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.audioContext = context;
    this.options.clock.bindAudioContext(context);
    await context.audioWorklet.addModule('/audio/capture-worklet.ts');
    await context.audioWorklet.addModule('/audio/process-worklet.ts');

    await this.setupInput(context);
    const captureNode = new AudioWorkletNode(
      context,
      'capture-processor',
      { numberOfInputs: 1, numberOfOutputs: 1 },
    );
    this.captureNode = captureNode;
    const processNode = new AudioWorkletNode(
      context,
      'process-processor',
    );
    this.nodeRefs.push(captureNode, processNode);
    captureNode.port.onmessage = (event: MessageEvent) =>
      this.handleWorkletMessage(event.data, 'capture');
    processNode.port.onmessage = (event: MessageEvent) =>
      this.handleWorkletMessage(event.data, 'process');
    if (this.mediaStream) {
      const sourceNode = context.createMediaStreamSource(this.mediaStream);
      this.nodeRefs.push(sourceNode);
      sourceNode.connect(captureNode);
    }
    captureNode.connect(processNode);
    if (this.options.useLoopback) {
      processNode.connect(context.destination);
    }

    this.setupEncoder();
    this.setupMarkerGenerator(context);
    this.sendControl({
      kind: 'round-open',
      roundId: this.options.roundId,
      label: this.options.label,
      startedAt: Date.now(),
    });
    this.events.onStatus('发送端已启动');
  }

  private async setupInput(context: AudioContext): Promise<void> {
    if (this.options.useLoopback) {
      this.mediaStream = null;
      return;
    }
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: SAMPLE_RATE,
        channelCount: CHANNELS,
      },
    });
  }

  private setupEncoder(): void {
    if (!this.audioContext) {
      throw new Error('AudioContext 尚未初始化');
    }
    const encoder = new AudioEncoder({
      output: (chunk, metadata) => this.handleEncodedChunk(chunk, metadata),
      error: (error) =>
        this.events.onDrop(`编码器错误: ${error.message}`, 'process'),
    });
    encoder.configure({
      codec: 'opus',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate: 24000,
      opus: { frameDuration: ENCODER_FRAME_MS },
    } as AudioEncoderConfig);
    this.encoder = encoder;
  }

  private setupMarkerGenerator(context: AudioContext): void {
    const canvas = this.options.flashCanvas;
    const canvasContext = canvas.getContext('2d');
    if (!canvasContext) {
      throw new Error('无法获取 Canvas 2D 上下文');
    }
    const injectionTarget = this.options.useLoopback
      ? this.captureNode
      : null;
    this.markerGenerator = new MarkerGenerator(context, {
      context: canvasContext,
      width: canvas.width,
      height: canvas.height,
    }, injectionTarget);
  }

  startAutoFire(intervalMs = 1000): void {
    if (this.fireTimer !== null) {
      return;
    }
    this.fireTimer = setInterval(() => this.fireMarker(), intervalMs);
  }

  fireMarker(): MarkerTimeline | null {
    if (!this.markerGenerator) {
      return null;
    }
    const shot = this.markerGenerator.fire();
    const t0 = this.options.clock.toServerTime(shot.t0Performance);
    const marker: MarkerTimeline = {
      roundId: this.options.roundId,
      seq: shot.seq,
      t0Marker: t0,
      t1Captured: null,
      t2Processed: null,
      t3Encoded: null,
      t4ServerRx: null,
      t5ServerTx: null,
      t6ClientRx: null,
      t7Decoded: null,
      t8Output: null,
    };
    this.markers.set(shot.seq, marker);
    this.sendControl({
      kind: 'marker',
      roundId: this.options.roundId,
      seq: shot.seq,
      t0,
    });
    this.events.onMarker(marker);
    return marker;
  }

  private handleWorkletMessage(
    data: {
      type: string;
      stage?: StageId;
      audioTime?: number;
      samples?: Float32Array;
    },
    stage: StageId,
  ): void {
    if (
      data.type === 'marker-detected' &&
      data.audioTime !== undefined &&
      data.stage
    ) {
      const local = this.options.clock.audioToPerformance(data.audioTime);
      const t = this.options.clock.toServerTime(local);
      this.attachStage(data.stage, t);
      return;
    }
    if (data.type === 'pcm' && data.samples && stage === 'capture') {
      this.feedPcm(data.samples);
    }
  }

  private attachStage(stage: StageId, t: number): void {
    const marker = this.nearestOpenMarker();
    if (!marker) {
      return;
    }
    if (stage === 'capture') {
      marker.t1Captured = t;
    } else if (stage === 'process') {
      marker.t2Processed = t;
    }
    this.sendControl({
      kind: 'stage',
      roundId: this.options.roundId,
      seq: marker.seq,
      stage,
      t,
    });
  }

  private nearestOpenMarker(): MarkerTimeline | null {
    let best: MarkerTimeline | null = null;
    for (const marker of this.markers.values()) {
      const incomplete =
        marker.t1Captured === null || marker.t2Processed === null;
      if (incomplete && (!best || marker.seq > best.seq)) {
        best = marker;
      }
    }
    return best;
  }

  private feedPcm(samples: Float32Array): void {
    this.pendingPcm.push(samples);
    this.pendingSamples += samples.length;
    const frameSamples = (SAMPLE_RATE * ENCODER_FRAME_MS) / 1000;
    while (this.pendingSamples >= frameSamples) {
      const frame = new Float32Array(frameSamples);
      let offset = 0;
      while (offset < frameSamples) {
        const chunk = this.pendingPcm[0];
        const take = Math.min(chunk.length, frameSamples - offset);
        frame.set(chunk.subarray(0, take), offset);
        offset += take;
        if (take === chunk.length) {
          this.pendingPcm.shift();
        } else {
          this.pendingPcm[0] = chunk.subarray(take);
        }
      }
      this.pendingSamples -= frameSamples;
      this.encodeFrame(frame);
    }
  }

  private encodeFrame(frame: Float32Array): void {
    if (!this.encoder) {
      return;
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: SAMPLE_RATE,
      numberOfFrames: frame.length,
      numberOfChannels: CHANNELS,
      timestamp: this.frameSeq * ENCODER_FRAME_MS * 1000,
      data: frame,
    });
    this.encoder.encode(audioData);
    audioData.close();
  }

  private handleEncodedChunk(
    chunk: EncodedAudioChunk,
    metadata: EncodedAudioChunkMetadata,
  ): void {
    const buffer = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buffer);
    const timestampMs = chunk.timestamp / 1000;
    const packet: OpusPacket = {
      data: buffer,
      timestampMs,
      keyframe: chunk.type === 'key',
    };
    let prefix: Uint8Array = new Uint8Array(0);
    if (!this.initSent) {
      prefix = this.muxer.initializationSegment();
      this.initSent = true;
    }
    const clusterBytes = this.muxer.appendPacket(packet);
    const payload = concat(prefix, clusterBytes);
    const t3 = this.options.clock.toServerTime(performance.now());
    this.markUploadStage(t3);
    const mediaFrame = encodeMediaFrame({
      roundId: this.options.roundId,
      seq: this.frameSeq,
      timestampUs: chunk.timestamp,
      durationUs: ENCODER_FRAME_MS * 1000,
      tSendMs: t3,
      tServerRxMs: 0,
      tServerTxMs: 0,
      keyframe: packet.keyframe,
      payload,
    });
    this.frameSeq += 1;
    if (this.options.ws.readyState === WebSocket.OPEN) {
      this.options.ws.send(mediaFrame);
    } else {
      this.events.onDrop('WebSocket 未就绪，媒体帧被丢弃', 'network');
    }
    void metadata;
  }

  private markUploadStage(t3: number): void {
    const marker = this.nearestOpenMarker();
    if (!marker) {
      return;
    }
    marker.t3Encoded = t3;
    this.sendControl({
      kind: 'stage',
      roundId: this.options.roundId,
      seq: marker.seq,
      stage: 'upload',
      t: t3,
    });
  }

  private sendControl(message: ControlMessage): void {
    if (this.options.ws.readyState === WebSocket.OPEN) {
      this.options.ws.send(encodeControl(message));
    }
  }

  listMarkers(): MarkerTimeline[] {
    return [...this.markers.values()].sort((a, b) => a.seq - b.seq);
  }

  stop(): void {
    if (this.fireTimer !== null) {
      clearInterval(this.fireTimer);
      this.fireTimer = null;
    }
    this.sendControl({
      kind: 'round-close',
      roundId: this.options.roundId,
      closedAt: Date.now(),
    });
    for (const node of this.nodeRefs) {
      try {
        node.disconnect();
      } catch {
        // 节点可能已断开，忽略。
      }
    }
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    void this.encoder?.close();
    void this.audioContext?.close();
    this.encoder = null;
    this.audioContext = null;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) {
    return b;
  }
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
