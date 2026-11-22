/**
 * 接收端测量引擎。
 * 管线：WebSocket 媒体帧 -> MediaSource/SourceBuffer 解复用解码（T7）
 *       -> <audio> 播放 -> OutputWorklet 拉取声卡输出（T8）。
 * MediaSource 负责满足技术栈要求并给出解码入队时间点；
 * OutputWorklet 负责精确的声卡输出时刻与欠载丢样检测。
 */

import {
  decodeControl,
  decodeMediaHeader,
  encodeControl,
  type ControlMessage,
} from '../../shared/protocol.ts';
import type {
  DropEvent,
  MarkerTimeline,
  StageId,
} from '../../shared/types.ts';
import { detectSeqGaps } from '../../shared/analytics.ts';
import type { ClockBridge } from '../transport/clock-bridge.ts';

export interface ReceiverOptions {
  roundId: string;
  ws: WebSocket;
  clock: ClockBridge;
  audioElement: HTMLAudioElement;
}

export interface ReceiverEvents {
  onMarker: (marker: MarkerTimeline) => void;
  onDrop: (event: DropEvent) => void;
  onStatus: (status: string) => void;
}

interface QueuedFrame {
  seq: number;
  payload: Uint8Array;
  t6: number;
}

export class ReceiverEngine {
  private readonly options: ReceiverOptions;
  private readonly events: ReceiverEvents;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private audioContext: AudioContext | null = null;
  private outputNode: AudioWorkletNode | null = null;
  private readonly queue: QueuedFrame[] = [];
  private receivedSeqs: number[] = [];
  private markers = new Map<number, MarkerTimeline>();
  private appendChain: Promise<void> = Promise.resolve();

  constructor(options: ReceiverOptions, events: ReceiverEvents) {
    this.options = options;
    this.events = events;
  }

  async start(): Promise<void> {
    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;
    this.options.audioElement.src = URL.createObjectURL(mediaSource);
    await new Promise<void>((resolve) => {
      mediaSource.addEventListener('sourceopen', () => resolve(), {
        once: true,
      });
    });
    this.sourceBuffer = mediaSource.addSourceBuffer(
      'audio/webm; codecs=opus',
    );
    this.sourceBuffer.mode = 'segments';
    this.sourceBuffer.addEventListener('updateend', () =>
      this.pumpQueue(),
    );

    const context = new AudioContext({ sampleRate: 48000 });
    this.audioContext = context;
    this.options.clock.bindAudioContext(context);
    await context.audioWorklet.addModule('/audio/output-worklet.ts');
    this.outputNode = new AudioWorkletNode(context, 'output-processor');
    const elementSource = context.createMediaElementSource(
      this.options.audioElement,
    );
    elementSource.connect(this.outputNode);
    this.outputNode.connect(context.destination);
    this.outputNode.port.onmessage = (event: MessageEvent) =>
      this.handleWorkletMessage(event.data);

    // 二进制与控制消息由外部 WsClient 统一分发，避免双消费者。
    this.options.audioElement.play().catch(() => undefined);
    this.events.onStatus('接收端已启动，等待媒体流');
  }

  /** 供 WsClient 的 onBinary 回调调用。 */
  ingestBinary(bytes: Uint8Array): void {
    this.handleMediaBytes(bytes);
  }

  /** 供 WsClient 的 onControl 回调调用。 */
  ingestControl(text: string): void {
    this.handleControlText(text);
  }

  private handleMediaBytes(bytes: Uint8Array): void {
    let parsed;
    try {
      parsed = decodeMediaHeader(bytes);
    } catch {
      this.emitDrop('network', '媒体帧头部解析失败', null);
      return;
    }
    if (parsed.frame.roundId !== this.options.roundId) {
      this.emitDrop(
        'network',
        `轮次隔离：丢弃外来帧 ${parsed.frame.roundId}`,
        parsed.frame.seq,
      );
      return;
    }
    const t6 = this.options.clock.toServerTime(performance.now());
    this.receivedSeqs.push(parsed.frame.seq);
    const marker = this.ensureMarker(parsed.frame.seq);
    marker.t6ClientRx = t6;
    marker.t4ServerRx =
      parsed.frame.tServerRxMs > 0 ? parsed.frame.tServerRxMs : marker.t4ServerRx;
    marker.t5ServerTx =
      parsed.frame.tServerTxMs > 0 ? parsed.frame.tServerTxMs : marker.t5ServerTx;
    this.events.onMarker({ ...marker });
    this.queue.push({
      seq: parsed.frame.seq,
      payload: parsed.frame.payload,
      t6,
    });
    this.pumpQueue();
  }

  private pumpQueue(): void {
    if (!this.sourceBuffer || this.sourceBuffer.updating) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    const t7 = this.options.clock.toServerTime(performance.now());
    this.appendChain = this.appendChain.then(
      () =>
        new Promise<void>((resolve) => {
          if (!this.sourceBuffer) {
            resolve();
            return;
          }
          const onUpdated = (): void => {
            this.sourceBuffer?.removeEventListener('updateend', onUpdated);
            this.recordDecode(next.seq, t7);
            resolve();
          };
          this.sourceBuffer.addEventListener('updateend', onUpdated);
          try {
            this.sourceBuffer.appendBuffer(next.payload);
          } catch (error) {
            this.sourceBuffer.removeEventListener('updateend', onUpdated);
            this.emitDrop(
              'decode',
              `SourceBuffer 追加失败: ${(error as Error).message}`,
              next.seq,
            );
            resolve();
          }
        }),
    );
    void this.appendChain.then(() => this.pumpQueue());
  }

  private recordDecode(seq: number, t7: number): void {
    const marker = this.ensureMarker(seq);
    marker.t6ClientRx = marker.t6ClientRx ?? t7;
    marker.t7Decoded = t7;
    this.sendStage(seq, 'decode', t7);
    this.events.onMarker({ ...marker });
  }

  private handleControlText(text: string): void {
    let message: ControlMessage;
    try {
      message = decodeControl(text);
    } catch {
      return;
    }
    if ('roundId' in message && message.roundId !== this.options.roundId) {
      return;
    }
    switch (message.kind) {
      case 'marker': {
        const marker = this.ensureMarker(message.seq);
        marker.t0Marker = message.t0;
        this.events.onMarker({ ...marker });
        break;
      }
      case 'stage': {
        const marker = this.ensureMarker(message.seq);
        if (message.stage === 'capture') {
          marker.t1Captured = message.t;
        } else if (message.stage === 'process') {
          marker.t2Processed = message.t;
        } else if (message.stage === 'upload') {
          marker.t3Encoded = message.t;
        }
        this.events.onMarker({ ...marker });
        break;
      }
      case 'drop':
        this.events.onDrop(message.event);
        break;
      case 'round-close':
        this.flushGapDetection();
        this.events.onStatus('发送端已关闭该轮次');
        break;
      default:
        break;
    }
  }

  private handleWorkletMessage(data: {
    type: string;
    audioTime?: number;
    count?: number;
  }): void {
    if (data.type === 'marker-output' && data.audioTime !== undefined) {
      const local = this.options.clock.audioToPerformance(data.audioTime);
      const t8 = this.options.clock.toServerTime(local);
      const seq = this.nextMarkerWithoutOutput();
      if (seq === null) {
        return;
      }
      const marker = this.ensureMarker(seq);
      marker.t8Output = t8;
      this.sendStage(seq, 'output', t8);
      this.events.onMarker({ ...marker });
    } else if (data.type === 'underrun') {
      this.emitDrop('output', `声卡欠载第 ${data.count ?? 0} 次`, null);
    }
  }

  private nextMarkerWithoutOutput(): number | null {
    const pending = [...this.markers.values()]
      .filter((marker) => marker.t8Output === null && marker.t0Marker > 0)
      .sort((a, b) => a.seq - b.seq);
    return pending[0]?.seq ?? null;
  }

  private flushGapDetection(): void {
    const events = detectSeqGaps(
      this.options.roundId,
      this.receivedSeqs,
      'network',
      this.options.clock.toServerTime(performance.now()),
    );
    for (const event of events) {
      this.events.onDrop(event);
    }
  }

  private ensureMarker(seq: number): MarkerTimeline {
    let marker = this.markers.get(seq);
    if (!marker) {
      marker = {
        roundId: this.options.roundId,
        seq,
        t0Marker: 0,
        t1Captured: null,
        t2Processed: null,
        t3Encoded: null,
        t4ServerRx: null,
        t5ServerTx: null,
        t6ClientRx: null,
        t7Decoded: null,
        t8Output: null,
      };
      this.markers.set(seq, marker);
    }
    return marker;
  }

  private sendStage(seq: number, stage: StageId, t: number): void {
    if (this.options.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const message: ControlMessage = {
      kind: 'stage',
      roundId: this.options.roundId,
      seq,
      stage,
      t,
    };
    this.options.ws.send(encodeControl(message));
  }

  private emitDrop(
    stage: StageId | 'network',
    detail: string,
    expectedSeq: number | null,
  ): void {
    const event: DropEvent = {
      roundId: this.options.roundId,
      at: this.options.clock.toServerTime(performance.now()),
      stage,
      detail,
      expectedSeq,
    };
    this.events.onDrop(event);
    if (this.options.ws.readyState === WebSocket.OPEN) {
      this.options.ws.send(
        encodeControl({ kind: 'drop', event } satisfies ControlMessage),
      );
    }
  }

  listMarkers(): MarkerTimeline[] {
    return [...this.markers.values()].sort((a, b) => a.seq - b.seq);
  }

  stop(): void {
    this.flushGapDetection();
    try {
      this.outputNode?.disconnect();
    } catch {
      // 忽略重复断开。
    }
    void this.audioContext?.close();
    if (
      this.mediaSource &&
      this.mediaSource.readyState === 'open' &&
      this.sourceBuffer &&
      !this.sourceBuffer.updating
    ) {
      try {
        this.mediaSource.endOfStream();
      } catch {
        // 流可能已结束，忽略。
      }
    }
  }
}
