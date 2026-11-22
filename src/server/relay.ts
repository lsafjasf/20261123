/**
 * 轮次级房间中继：
 * - 每个 roundId 是一个独立房间，发送端与接收端通过 hello 绑定角色；
 * - 媒体帧只在同房间内转发，跨轮次数据直接丢弃并记录错误；
 * - 转发时回填服务端收/发时间戳；
 * - 时钟同步消息由服务端即时应答。
 */

import { WsConnection } from './ws-connection.ts';
import { RoundGuardError, RoundStore } from './round-store.ts';
import {
  decodeControl,
  decodeMediaHeader,
  encodeControl,
  stampServerTimes,
} from '../shared/protocol.ts';
import type { ControlMessage } from '../shared/protocol.ts';
import { estimateFromPoints } from '../shared/clock.ts';
import type { MarkerTimeline, Role, StageId } from '../shared/types.ts';

interface Member {
  connection: WsConnection;
  role: Role;
}

export class RelayRoom {
  readonly roundId: string;
  private readonly store: RoundStore;
  private sender: Member | null = null;
  private readonly receivers = new Set<Member>();

  constructor(roundId: string, store: RoundStore) {
    this.roundId = roundId;
    this.store = store;
  }

  addMember(connection: WsConnection, role: Role): void {
    const member: Member = { connection, role };
    if (role === 'sender') {
      this.sender = member;
    } else {
      this.receivers.add(member);
    }
    connection.sendText(
      encodeControl({
        kind: 'subscribe',
        roundId: this.roundId,
      }),
    );
  }

  removeMember(connection: WsConnection): void {
    if (this.sender?.connection === connection) {
      this.sender = null;
    }
    for (const member of this.receivers) {
      if (member.connection === connection) {
        this.receivers.delete(member);
      }
    }
  }

  get isEmpty(): boolean {
    return this.sender === null && this.receivers.size === 0;
  }

  get memberCount(): number {
    return this.receivers.size + (this.sender ? 1 : 0);
  }

  handleControl(connection: WsConnection, text: string): void {
    let message: ControlMessage;
    try {
      message = decodeControl(text);
    } catch {
      connection.sendText(
        encodeControl({ kind: 'error', message: '控制消息解析失败' }),
      );
      return;
    }
    if ('roundId' in message && message.roundId !== this.roundId) {
      connection.sendText(
        encodeControl({
          kind: 'error',
          message: `轮次隔离：消息属于 ${message.roundId}，当前房间为 ${this.roundId}`,
        }),
      );
      return;
    }
    this.routeControl(connection, message);
  }

  private routeControl(connection: WsConnection, message: ControlMessage): void {
    switch (message.kind) {
      case 'round-open':
        this.store.openRound(
          message.roundId,
          message.label,
          message.startedAt,
        );
        this.broadcast(message);
        break;
      case 'round-close': {
        const now = Date.now();
        this.store.closeRound(message.roundId, now);
        const gaps = this.store.detectNetworkGaps(message.roundId, now);
        for (const event of gaps) {
          this.store.addDrop(event);
        }
        this.broadcast({ ...message, closedAt: now });
        break;
      }
      case 'marker': {
        const marker: MarkerTimeline = emptyMarker(
          message.roundId,
          message.seq,
          message.t0,
        );
        this.guardStore(() => this.store.upsertMarker(marker));
        this.broadcast(message);
        break;
      }
      case 'stage': {
        this.recordStage(message.roundId, message.seq, message.stage, message.t);
        this.broadcast(message);
        break;
      }
      case 'drop':
        this.guardStore(() => this.store.addDrop(message.event));
        this.broadcast(message);
        break;
      case 'clock-sync': {
        const t2 = Date.now();
        const ack: ControlMessage = {
          kind: 'clock-sync-ack',
          roundId: message.roundId,
          id: message.id,
          t0: message.t0,
          t1: t2,
        };
        this.guardStore(() => {
          const points = [{ t0: message.t0, tServer: t2, t2 }];
          const estimate = estimateFromPoints(points);
          this.store.addClockPoint(message.roundId, points[0], estimate);
        });
        connection.sendText(encodeControl(ack));
        break;
      }
      case 'hello':
      case 'subscribe':
      case 'clock-sync-ack':
      case 'error':
        break;
    }
  }

  private recordStage(
    roundId: string,
    seq: number,
    stage: StageId,
    t: number,
  ): void {
    this.guardStore(() => {
      const existing = this.store.snapshot(roundId)?.markers.find(
        (marker) => marker.seq === seq,
      );
      const marker = existing ?? emptyMarker(roundId, seq, 0);
      switch (stage) {
        case 'capture':
          marker.t1Captured = t;
          break;
        case 'process':
          marker.t2Processed = t;
          break;
        case 'upload':
          marker.t3Encoded = t;
          break;
        case 'decode':
          marker.t7Decoded = t;
          break;
        case 'output':
          marker.t8Output = t;
          break;
      }
      this.store.upsertMarker(marker);
    });
  }

  handleBinary(connection: WsConnection, bytes: Uint8Array): void {
    let header;
    try {
      header = decodeMediaHeader(bytes);
    } catch {
      connection.sendText(
        encodeControl({ kind: 'error', message: '媒体帧解析失败' }),
      );
      return;
    }
    if (header.frame.roundId !== this.roundId) {
      connection.sendText(
        encodeControl({
          kind: 'error',
          message: '轮次隔离：媒体帧 roundId 与房间不一致，已丢弃',
        }),
      );
      return;
    }
    const rxMs = Date.now();
    const txMs = Date.now();
    this.guardStore(() => {
      this.store.recordMediaSeq(this.roundId, header.frame.seq);
      this.store.upsertMarker({
        ...emptyMarker(this.roundId, header.frame.seq, 0),
        t4ServerRx: rxMs,
        t5ServerTx: txMs,
      });
    });
    const stamped = stampServerTimes(bytes, rxMs, txMs);
    for (const member of this.receivers) {
      member.connection.sendBinary(stamped);
    }
  }

  private broadcast(message: ControlMessage): void {
    const text = encodeControl(message);
    if (this.sender) {
      this.sender.connection.sendText(text);
    }
    for (const member of this.receivers) {
      member.connection.sendText(text);
    }
  }

  private guardStore(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      if (error instanceof RoundGuardError) {
        return;
      }
      throw error;
    }
  }
}

function emptyMarker(roundId: string, seq: number, t0: number): MarkerTimeline {
  return {
    roundId,
    seq,
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
}
