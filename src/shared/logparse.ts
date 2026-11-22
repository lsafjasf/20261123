// 日志解析与候选锚点（启动动作 / 连续输入）检测、连招匹配
import type { ComboDef, ComboMatch, InputEvent, InputLog } from './types.ts';

/** 解析 JSONL 手柄日志。每行: {"t": 毫秒, "btn": "A", "state": "down"|"up"} */
export function parseLog(text: string): InputLog {
  const events: InputEvent[] = [];
  let meta: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const obj = JSON.parse(line);
    if (obj.meta && typeof obj.meta === 'object') {
      meta = { ...(meta ?? {}), ...obj.meta };
      continue;
    }
    if (typeof obj.t !== 'number' || typeof obj.btn !== 'string') {
      throw new Error(`日志行缺少 t/btn 字段: ${line}`);
    }
    const state = obj.state === 'up' ? 'up' : 'down';
    events.push({ t: obj.t, btn: obj.btn, state });
  }
  events.sort((x, y) => x.t - y.t);
  return { meta, events };
}

export function serializeLog(log: InputLog): string {
  const lines: string[] = [];
  if (log.meta) lines.push(JSON.stringify({ meta: log.meta }));
  for (const e of log.events) lines.push(JSON.stringify(e));
  return lines.join('\n') + '\n';
}

export interface CandidateAnchor {
  kind: 'startup' | 'run';
  /** 建议用于对齐的日志时间（按下沿） */
  logT: number;
  /** 连续输入的重复节奏（毫秒），startup 为 0 */
  periodMs: number;
  /** 该特征包含的按下事件数 */
  count: number;
  label: string;
}

function downEvents(events: InputEvent[]): InputEvent[] {
  return events.filter((e) => e.state === 'down');
}

/**
 * 启动动作：日志开头一段静默之后的第一个密集输入簇
 * （簇内间隔 <= gapMs，簇前静默 >= silenceMs）。
 */
export function detectStartup(events: InputEvent[], silenceMs = 3000, gapMs = 600): CandidateAnchor | null {
  const downs = downEvents(events);
  if (downs.length === 0) return null;
  const cluster: InputEvent[] = [downs[0]];
  for (let i = 1; i < downs.length; i++) {
    if (downs[i].t - downs[i - 1].t <= gapMs) cluster.push(downs[i]);
    else break;
  }
  if (cluster.length < 2) return null;
  return {
    kind: 'startup',
    logT: cluster[0].t,
    periodMs: 0,
    count: cluster.length,
    label: `启动动作 ${cluster.map((e) => e.btn).join('·')} (前静默>=${silenceMs}ms)`,
  };
}

/**
 * 连续输入：同一按键 >= minCount 次按下，间隔变异系数小（节奏稳定）。
 * 返回最长的若干个候选，供用户在视频上确认对应帧。
 */
export function detectRuns(events: InputEvent[], minCount = 5, maxCv = 0.2): CandidateAnchor[] {
  const downs = downEvents(events);
  const runs: CandidateAnchor[] = [];
  let i = 0;
  while (i < downs.length) {
    let j = i;
    const intervals: number[] = [];
    while (
      j + 1 < downs.length &&
      downs[j + 1].btn === downs[i].btn &&
      downs[j + 1].t - downs[j].t <= 1500
    ) {
      intervals.push(downs[j + 1].t - downs[j].t);
      j++;
    }
    const count = j - i + 1;
    if (count >= minCount && intervals.length >= minCount - 1) {
      const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
      const varr = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
      const cv = mean > 0 ? Math.sqrt(varr) / mean : 1;
      if (cv <= maxCv) {
        runs.push({
          kind: 'run',
          logT: downs[i].t,
          periodMs: Math.round(mean * 10) / 10,
          count,
          label: `连续输入 ${downs[i].btn}×${count} @${Math.round(mean)}ms`,
        });
      }
    }
    i = j + 1;
  }
  return runs;
}

/** 在日志中匹配连招（仅看按下沿，按时间窗顺序匹配，返回非重叠的最大匹配） */
export function matchCombos(events: InputEvent[], combos: ComboDef[]): ComboMatch[] {
  const downs = downEvents(events);
  const matches: ComboMatch[] = [];
  let cursor = 0;
  for (let i = 0; i < downs.length; i++) {
    if (i < cursor) continue;
    let best: { def: ComboDef; endIdx: number } | null = null;
    for (const def of combos) {
      if (def.steps.length === 0 || downs[i].btn !== def.steps[0].btn) continue;
      let idx = i;
      let ok = true;
      for (let s = 1; s < def.steps.length; s++) {
        const step = def.steps[s];
        const deadline = downs[idx].t + step.withinMs;
        let found = -1;
        for (let k = idx + 1; k < downs.length && downs[k].t <= deadline; k++) {
          if (downs[k].btn === step.btn) { found = k; break; }
        }
        if (found < 0) { ok = false; break; }
        idx = found;
      }
      if (ok && (!best || def.steps.length > best.def.steps.length)) {
        best = { def, endIdx: idx };
      }
    }
    if (best) {
      matches.push({
        comboId: best.def.id,
        name: best.def.name,
        startLogT: downs[i].t,
        endLogT: downs[best.endIdx].t,
      });
      cursor = best.endIdx + 1;
    }
  }
  return matches;
}
