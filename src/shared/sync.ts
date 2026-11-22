// 核心：帧索引（VFR/暂停感知）、锚点分段映射、置信度、事件→帧换算
import type {
  Anchor, FrameIndex, FrameInfo, MappedEvent, MappingSegment, SyncMapping, InputEvent,
} from './types.ts';

/** 由逐帧 PTS 构建帧索引；不假设恒定帧率，gap 超过 max(4×中位帧长, 250ms) 记为暂停 */
export function buildFrameIndex(ptsList: number[], durations?: number[]): FrameIndex {
  if (ptsList.length === 0) throw new Error('帧列表为空');
  const frames: FrameInfo[] = ptsList.map((pts, i) => ({
    pts,
    dur: durations?.[i] ?? 0,
  }));
  frames.sort((x, y) => x.pts - y.pts);
  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i++) deltas.push(frames[i].pts - frames[i - 1].pts);
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 16.7;
  for (let i = 0; i < frames.length; i++) {
    if (!frames[i].dur) frames[i].dur = i < frames.length - 1 ? frames[i + 1].pts - frames[i].pts : median;
  }
  const pauses: FrameIndex['pauses'] = [];
  for (let i = 0; i < frames.length - 1; i++) {
    const gap = frames[i + 1].pts - frames[i].pts;
    if (gap > Math.max(median * 4, 250)) pauses.push({ afterFrame: i, gapMs: gap });
  }
  return { frames, pauses, medianFrameMs: median };
}

let segId = 0;
function makeSegment(startLogT: number, endLogT: number, a: number, b: number): MappingSegment {
  return { id: segId++, startLogT, endLogT, a, b, confidence: 1, flags: [] };
}

/**
 * 由锚点构建分段线性映射。
 * - 相邻锚点之间一段；首尾之外用最近段斜率外推（置信度低）。
 * - 冗余锚点用于残差检验：偏离拟合线 > toleranceMs 的非人工锚点判为冲突。
 * - 跨越录制暂停且无锚点夹逼的段降置信度。
 */
export function buildMapping(anchors: Anchor[], index?: FrameIndex, toleranceMs = 60): SyncMapping {
  if (anchors.length === 0) throw new Error('至少需要一个锚点');
  const sorted = [...anchors].sort((x, y) => x.logT - y.logT);
  const conflicts: SyncMapping['conflicts'] = [];

  // 冲突检测：对每三个连续锚点，用两端预测中间。
  // 若两端之间跨越录制暂停，偏移本就会突变（拐点合法），不做剔除。
  const dropped = new Set<string>();
  for (let i = 1; i < sorted.length - 1; i++) {
    const p0 = sorted[i - 1], p1 = sorted[i], p2 = sorted[i + 1];
    if (p2.logT === p0.logT) continue;
    if (index && crossesPause(index, p0.videoT, p2.videoT)) continue;
    const a = (p2.videoT - p0.videoT) / (p2.logT - p0.logT);
    const predicted = p0.videoT + a * (p1.logT - p0.logT);
    const residual = Math.abs(predicted - p1.videoT);
    if (residual > toleranceMs && p1.kind !== 'manual') {
      conflicts.push({ anchorId: p1.id, residualMs: Math.round(residual) });
      dropped.add(p1.id);
    }
  }
  const usable = sorted.filter((a) => !dropped.has(a.id));

  let segments: MappingSegment[] = [];
  for (let i = 0; i < usable.length - 1; i++) {
    const p = usable[i], q = usable[i + 1];
    const a = q.logT === p.logT ? 1 : (q.videoT - p.videoT) / (q.logT - p.logT);
    const b = p.videoT - a * p.logT;
    segments.push(makeSegment(p.logT, q.logT, a, b));
  }
  // 暂停感知切分：段内恰好跨一个暂停时，在暂停处折断，
  // 两侧各用斜率 1（双时钟均为墙钟）穿过各自锚点，精确定位拐点。
  if (index) {
    const split: MappingSegment[] = [];
    for (const seg of segments) {
      const pauses = pausesInRange(index, seg.a * seg.startLogT + seg.b, seg.a * seg.endLogT + seg.b);
      if (pauses.length === 1) {
        const pause = pauses[0];
        const kinkVideo = index.frames[pause.afterFrame].pts + pause.gapMs / 2;
        const kinkLog = seg.startLogT + (kinkVideo - (seg.a * seg.startLogT + seg.b)) / seg.a;
        const left = makeSegment(seg.startLogT, kinkLog, 1, (seg.a * seg.startLogT + seg.b) - seg.startLogT);
        const right = makeSegment(kinkLog, seg.endLogT, 1, (seg.a * seg.endLogT + seg.b) - seg.endLogT);
        left.flags.push('pause-split');
        right.flags.push('pause-split');
        split.push(left, right);
      } else {
        split.push(seg);
      }
    }
    segments = split;
  }
  // 外推段
  const first = usable[0];
  const headSlope = segments.length > 0 ? clampSlope(segments[0].a) : 1;
  segments.unshift(makeSegment(-Infinity, first.logT, headSlope, first.videoT - headSlope * first.logT));
  const last = usable[usable.length - 1];
  const tailSlope = segments.length > 1 ? clampSlope(segments[segments.length - 1].a) : headSlope;
  segments.push(makeSegment(last.logT, Infinity, tailSlope, last.videoT - tailSlope * last.logT));

  // 置信度与标记
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isHead = seg.startLogT === -Infinity;
    const isTail = seg.endLogT === Infinity;
    if (isHead || isTail) {
      seg.confidence = 0.35;
      seg.flags.push('extrapolated');
      continue;
    }
    const spanMs = seg.endLogT - seg.startLogT;
    if (seg.flags.includes('pause-split')) {
      seg.confidence = 0.85;
    } else {
      seg.confidence = spanMs > 30000 ? 0.7 : 0.95;
      if (spanMs > 30000) seg.flags.push('sparse-anchors');
      if (seg.a < 0.9 || seg.a > 1.1) seg.flags.push('non-1x-slope');
    }
    if (index && !seg.flags.includes('pause-split') &&
        pausesInRange(index, seg.a * seg.startLogT + seg.b, seg.a * seg.endLogT + seg.b).length > 0) {
      seg.flags.push('crosses-pause');
      seg.confidence = Math.min(seg.confidence, 0.6);
    }
  }
  return { segments, anchors: sorted, conflicts };
}

function pausesInRange(index: FrameIndex, vLo: number, vHi: number): FrameIndex['pauses'] {
  const lo = Math.min(vLo, vHi), hi = Math.max(vLo, vHi);
  return index.pauses.filter((p) => {
    const mid = index.frames[p.afterFrame].pts + p.gapMs / 2;
    return mid > lo && mid < hi;
  });
}

function crossesPause(index: FrameIndex, vA: number, vB: number): boolean {
  return pausesInRange(index, vA, vB).length > 0;
}

function clampSlope(a: number): number {
  return Math.min(2, Math.max(0.5, a));
}

export function mapLogToVideo(mapping: SyncMapping, logT: number): { videoT: number; seg: MappingSegment } {
  const seg = mapping.segments.find((s) => logT >= s.startLogT && logT < s.endLogT)
    ?? mapping.segments[mapping.segments.length - 1];
  return { videoT: seg.a * logT + seg.b, seg };
}

/** 视频时间 → 帧号：pts <= t 的最后一帧（VFR 安全） */
export function videoTimeToFrame(index: FrameIndex, videoT: number): number {
  const frames = index.frames;
  let lo = 0, hi = frames.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].pts <= videoT) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/** 将整条日志映射为逐事件表 */
export function mapEvents(events: InputEvent[], mapping: SyncMapping, index: FrameIndex): MappedEvent[] {
  const lastFrame = index.frames.length - 1;
  const videoEnd = index.frames[lastFrame].pts + index.frames[lastFrame].dur;
  return events.map((e, i) => {
    const { videoT, seg } = mapLogToVideo(mapping, e.t);
    const flags = [...seg.flags];
    let frame = videoTimeToFrame(index, videoT);
    if (videoT < index.frames[0].pts) { flags.push('before-video'); frame = -1; }
    else if (videoT > videoEnd) { flags.push('beyond-video'); frame = -1; }
    return {
      index: i, logT: e.t, btn: e.btn, state: e.state,
      videoT: Math.round(videoT * 100) / 100,
      frame, segmentId: seg.id, confidence: seg.confidence, flags,
    };
  });
}

/** 逐事件表导出为 CSV */
export function eventsToCsv(mapped: MappedEvent[]): string {
  const head = 'event,log_ms,button,state,video_ms,frame,segment,confidence,flags';
  const rows = mapped.map((m) =>
    [m.index, m.logT, m.btn, m.state, m.videoT, m.frame, m.segmentId, m.confidence, m.flags.join('|')].join(','));
  return [head, ...rows].join('\n') + '\n';
}
