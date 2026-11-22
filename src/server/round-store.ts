/**
 * 服务端轮次存储。所有数据按 roundId 物理隔离，关闭的轮次进入只读状态，
 * 迟到/串轮数据一律拒绝，保证不同轮次的数据不会混在一起。
 */

import type {
  DropEvent,
  MarkerTimeline,
  RoundMeta,
  StageId,
} from '../shared/types.ts';

interface RoundRecord {
  meta: RoundMeta;
  markers: Map<number, MarkerTimeline>;
  drops: DropEvent[];
  /** 最近一次时钟同步对，用于报告中的时钟质量展示。 */
  clockOffsetMs: number;
  clockRttMs: number;
  clockPoints: { t0: number; tServer: number; t2: number }[];
  /** 已观测到的媒体帧序号，用于服务端侧网络丢样检测。 */
  mediaSeqs: number[];
}

export class RoundStore {
  private rounds = new Map<string, RoundRecord>();

  openRound(roundId: string, label: string, startedAt: number): RoundMeta {
    const existing = this.rounds.get(roundId);
    if (existing) {
      return existing.meta;
    }
    const meta: RoundMeta = {
      roundId,
      label,
      startedAt,
      closedAt: null,
    };
    this.rounds.set(roundId, {
      meta,
      markers: new Map(),
      drops: [],
      clockOffsetMs: 0,
      clockRttMs: 0,
      clockPoints: [],
      mediaSeqs: [],
    });
    return meta;
  }

  closeRound(roundId: string, closedAt: number): boolean {
    const record = this.rounds.get(roundId);
    if (!record || record.meta.closedAt !== null) {
      return false;
    }
    record.meta.closedAt = closedAt;
    return true;
  }

  list(): RoundMeta[] {
    return [...this.rounds.values()]
      .map((record) => record.meta)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  isOpen(roundId: string): boolean {
    return this.rounds.get(roundId)?.meta.closedAt === null;
  }

  has(roundId: string): boolean {
    return this.rounds.has(roundId);
  }

  private requireOpen(roundId: string): RoundRecord {
    const record = this.rounds.get(roundId);
    if (!record) {
      throw new RoundGuardError(`未知轮次 ${roundId}`);
    }
    if (record.meta.closedAt !== null) {
      throw new RoundGuardError(`轮次 ${roundId} 已关闭，拒绝写入`);
    }
    return record;
  }

  upsertMarker(marker: MarkerTimeline): void {
    const record = this.requireOpen(marker.roundId);
    const current = record.markers.get(marker.seq);
    if (current) {
      record.markers.set(marker.seq, mergeMarker(current, marker));
    } else {
      record.markers.set(marker.seq, { ...marker });
    }
  }

  addDrop(event: DropEvent): void {
    const record = this.requireOpen(event.roundId);
    record.drops.push({ ...event });
  }

  recordMediaSeq(roundId: string, seq: number): void {
    const record = this.requireOpen(roundId);
    record.mediaSeqs.push(seq);
  }

  addClockPoint(
    roundId: string,
    point: { t0: number; tServer: number; t2: number },
    estimate: { offsetMs: number; rttMs: number },
  ): void {
    const record = this.requireOpen(roundId);
    record.clockPoints.push(point);
    record.clockOffsetMs = estimate.offsetMs;
    record.clockRttMs = estimate.rttMs;
  }

  snapshot(roundId: string): {
    meta: RoundMeta;
    markers: MarkerTimeline[];
    drops: DropEvent[];
    clockOffsetMs: number;
    clockRttMs: number;
  } | null {
    const record = this.rounds.get(roundId);
    if (!record) {
      return null;
    }
    return {
      meta: { ...record.meta },
      markers: [...record.markers.values()].sort((a, b) => a.seq - b.seq),
      drops: [...record.drops],
      clockOffsetMs: record.clockOffsetMs,
      clockRttMs: record.clockRttMs,
    };
  }

  detectNetworkGaps(roundId: string, now: number): DropEvent[] {
    const record = this.rounds.get(roundId);
    if (!record) {
      return [];
    }
    const seqs = [...new Set(record.mediaSeqs)].sort((a, b) => a - b);
    const events: DropEvent[] = [];
    for (let i = 1; i < seqs.length; i += 1) {
      const gap = seqs[i] - seqs[i - 1] - 1;
      for (let missing = 0; missing < gap; missing += 1) {
        const expectedSeq = seqs[i - 1] + missing + 1;
        events.push({
          roundId,
          at: now,
          stage: 'network',
          detail: `媒体帧序号 ${expectedSeq} 在服务端缺失`,
          expectedSeq,
        });
      }
    }
    return events;
  }
}

export class RoundGuardError extends Error {}

function mergeMarker(
  current: MarkerTimeline,
  incoming: MarkerTimeline,
): MarkerTimeline {
  const merged: MarkerTimeline = { ...current };
  const keys = [
    't1Captured',
    't2Processed',
    't3Encoded',
    't4ServerRx',
    't5ServerTx',
    't6ClientRx',
    't7Decoded',
    't8Output',
  ] as const;
  for (const key of keys) {
    const value = incoming[key];
    if (value !== null && value !== undefined) {
      merged[key] = value;
    }
  }
  if (incoming.t0Marker !== 0) {
    merged.t0Marker = incoming.t0Marker;
  }
  return merged;
}

export type { StageId };
