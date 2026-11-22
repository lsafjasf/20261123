// 由映射后的事件表计算某一视频时刻的叠加层视图模型（纯函数，Node 可测）
import type { MappedEvent } from './types.ts';

export interface ComboVideoWindow {
  name: string;
  startVideoT: number;
  endVideoT: number;
}

export interface MomentView {
  pressed: { btn: string; heldMs: number }[];
  combos: { name: string; remainMs: number; totalMs: number }[];
  /** 该时刻附近（±windowMs）置信度最低的事件置信度；无事件则为段置信度 */
  confidence: number;
  flags: string[];
}

const COMBO_TAIL_MS = 600;

export function momentView(
  mapped: MappedEvent[],
  comboWindows: ComboVideoWindow[],
  videoT: number,
  segmentConfidence: number,
  segmentFlags: string[],
): MomentView {
  // 按键状态：扫描 down/up 配对
  const held = new Map<string, number>();
  for (const e of mapped) {
    if (e.frame < 0) continue;
    if (e.state === 'down') {
      if (e.videoT <= videoT) held.set(e.btn, e.videoT);
    } else {
      const downT = held.get(e.btn);
      if (downT !== undefined && e.videoT <= videoT) held.delete(e.btn);
    }
  }
  const pressed = [...held.entries()]
    .map(([btn, since]) => ({ btn, heldMs: Math.max(0, videoT - since) }))
    .sort((a, b) => a.btn.localeCompare(b.btn));

  const combos = comboWindows
    .filter((c) => videoT >= c.startVideoT && videoT <= c.endVideoT + COMBO_TAIL_MS)
    .map((c) => ({
      name: c.name,
      remainMs: Math.max(0, c.endVideoT + COMBO_TAIL_MS - videoT),
      totalMs: c.endVideoT - c.startVideoT + COMBO_TAIL_MS,
    }));

  // 附近 100ms 内事件的最低置信度
  let confidence = segmentConfidence;
  const flags = new Set(segmentFlags);
  for (const e of mapped) {
    if (Math.abs(e.videoT - videoT) <= 100) {
      confidence = Math.min(confidence, e.confidence);
      for (const f of e.flags) flags.add(f);
    }
  }
  return { pressed, combos, confidence, flags: [...flags] };
}
