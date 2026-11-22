// 应用状态：日志/帧索引/锚点 → 映射、逐事件表、连招窗口（视频时间域）
import type {
  Anchor, ComboDef, FrameIndex, InputLog, MappedEvent, SyncMapping,
} from '../shared/types.ts';
import { buildMapping, mapEvents, mapLogToVideo } from '../shared/sync.ts';
import { matchCombos } from '../shared/logparse.ts';
import type { ComboVideoWindow } from '../shared/viewmodel.ts';

export class AppState {
  log: InputLog | null = null;
  frameIndex: FrameIndex | null = null;
  anchors: Anchor[] = [];
  comboDefs: ComboDef[] = [];
  mapping: SyncMapping | null = null;
  mapped: MappedEvent[] = [];
  comboWindows: ComboVideoWindow[] = [];
  /** 当前选中的日志事件下标（用于人工锚点） */
  selectedEvent = -1;
  private anchorSeq = 0;

  /** 锚点或输入变化后重算一切派生数据 */
  recompute(): void {
    this.mapping = null;
    this.mapped = [];
    this.comboWindows = [];
    if (!this.log || !this.frameIndex || this.anchors.length === 0) return;
    this.mapping = buildMapping(this.anchors, this.frameIndex);
    this.mapped = mapEvents(this.log.events, this.mapping, this.frameIndex);
    for (const m of matchCombos(this.log.events, this.comboDefs)) {
      this.comboWindows.push({
        name: m.name,
        startVideoT: mapLogToVideo(this.mapping, m.startLogT).videoT,
        endVideoT: mapLogToVideo(this.mapping, m.endLogT).videoT,
      });
    }
  }

  addAnchor(kind: Anchor['kind'], logT: number, videoT: number, note?: string): Anchor {
    const a: Anchor = {
      id: `a${++this.anchorSeq}`,
      logT, videoT, kind,
      weight: kind === 'manual' ? 2 : 1,
      note,
    };
    this.anchors.push(a);
    this.recompute();
    return a;
  }

  removeAnchor(id: string): void {
    this.anchors = this.anchors.filter((a) => a.id !== id);
    this.recompute();
  }

  /** 视频时间 → 当前段（供叠加层取置信度） */
  segmentAtVideo(videoT: number): { confidence: number; flags: string[] } {
    if (!this.mapping) return { confidence: 0, flags: ['no-mapping'] };
    // 反查：找到覆盖该视频时间的段（段在日志域定义，近似用映射值比较）
    for (const seg of this.mapping.segments) {
      const lo = seg.a * Math.max(seg.startLogT, -1e15) + seg.b;
      const hi = seg.a * Math.min(seg.endLogT, 1e15) + seg.b;
      if (videoT >= Math.min(lo, hi) && videoT <= Math.max(lo, hi)) {
        return { confidence: seg.confidence, flags: seg.flags };
      }
    }
    return { confidence: 0.3, flags: ['outside'] };
  }
}
