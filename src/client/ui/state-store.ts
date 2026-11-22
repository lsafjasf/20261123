/**
 * 前端状态存储：按 roundId 隔离保存标记时间线与丢样事件，
 * 视图只通过订阅接口刷新，避免不同轮次数据在展示层混淆。
 */

import type {
  DropEvent,
  MarkerTimeline,
  RoundReport,
} from '../../shared/types.ts';

type Listener = () => void;

export class StateStore {
  private markersByRound = new Map<string, Map<number, MarkerTimeline>>();
  private dropsByRound = new Map<string, DropEvent[]>();
  private reportByRound = new Map<string, RoundReport>();
  private activeRoundId: string | null = null;
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  setActiveRound(roundId: string): void {
    this.activeRoundId = roundId;
    if (!this.markersByRound.has(roundId)) {
      this.markersByRound.set(roundId, new Map());
      this.dropsByRound.set(roundId, []);
    }
    this.emit();
  }

  get activeRound(): string | null {
    return this.activeRoundId;
  }

  upsertMarker(marker: MarkerTimeline): void {
    if (marker.roundId !== this.activeRoundId) {
      return;
    }
    const map = this.markersByRound.get(marker.roundId);
    if (!map) {
      return;
    }
    const current = map.get(marker.seq);
    map.set(marker.seq, current ? mergeTimeline(current, marker) : { ...marker });
    this.emit();
  }

  addDrop(event: DropEvent): void {
    if (event.roundId !== this.activeRoundId) {
      return;
    }
    const list = this.dropsByRound.get(event.roundId);
    if (list) {
      list.push(event);
      this.emit();
    }
  }

  setReport(report: RoundReport): void {
    this.reportByRound.set(report.roundId, report);
    this.emit();
  }

  markers(roundId: string): MarkerTimeline[] {
    const map = this.markersByRound.get(roundId);
    return map
      ? [...map.values()].sort((a, b) => a.seq - b.seq)
      : [];
  }

  drops(roundId: string): DropEvent[] {
    return this.dropsByRound.get(roundId) ?? [];
  }

  report(roundId: string): RoundReport | undefined {
    return this.reportByRound.get(roundId);
  }

  clearRound(roundId: string): void {
    this.markersByRound.delete(roundId);
    this.dropsByRound.delete(roundId);
    this.reportByRound.delete(roundId);
    this.emit();
  }
}

function mergeTimeline(
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
    if (incoming[key] !== null) {
      merged[key] = incoming[key];
    }
  }
  if (incoming.t0Marker > 0) {
    merged.t0Marker = incoming.t0Marker;
  }
  return merged;
}
