// 把逐帧掩码合并成带语义的异常片段。
// 帧优先级：silence > pop > clip > noise > music。
// 静音段按时长和上下文细分为：掉字 / 异常空白 / 正常停顿（含白名单）。
import { toDb } from './dsp.js';
import type { DetectorId } from './detectors.js';
import type {
  FrameFeatures, Segment, SegmentKind, Thresholds, WhitelistRule,
} from './types.js';

export type Masks = Record<DetectorId, Uint8Array>;

const BRIDGE_FRAMES = 3; // 同种命中间隔 <=30ms 时桥接为一段

interface Run { start: number; end: number } // 帧索引 [start, end)

function runsOf(mask: Uint8Array): Run[] {
  const runs: Run[] = [];
  let i = 0;
  const n = mask.length;
  while (i < n) {
    if (!mask[i]) { i++; continue; }
    let end = i + 1;
    while (end < n) {
      if (mask[end]) { end++; continue; }
      // 桥接短空隙
      let gap = end;
      while (gap < n && !mask[gap] && gap - end <= BRIDGE_FRAMES) gap++;
      if (gap < n && mask[gap] && gap - end <= BRIDGE_FRAMES) { end = gap + 1; }
      else break;
    }
    runs.push({ start: i, end });
    i = end;
  }
  return runs;
}

function sec(f: FrameFeatures, frame: number): number {
  return frame * f.hopSec;
}

function fmtDb(x: number): string {
  return `${toDb(Math.max(x, 1e-8)).toFixed(0)}dB`;
}

function minRms(f: FrameFeatures, r: Run): number {
  let m = Infinity;
  for (let i = r.start; i < r.end; i++) if (f.rms[i] < m) m = f.rms[i];
  return m;
}

function avgFlat(f: FrameFeatures, r: Run): number {
  let s = 0;
  for (let i = r.start; i < r.end; i++) s += f.flatness[i];
  return s / (r.end - r.start);
}

function whitelisted(dur: number, wl: WhitelistRule[]): WhitelistRule | null {
  for (const r of wl) if (dur >= r.minSec && dur <= r.maxSec) return r;
  return null;
}

export function buildSegments(
  f: FrameFeatures,
  masks: Masks,
  th: Thresholds,
  whitelist: WhitelistRule[],
): Segment[] {
  const out: Segment[] = [];
  const hop = f.hopSec;

  // ---- 静音族：掉字 / 异常空白 / 正常停顿 ----
  const silentRuns = runsOf(masks.silence);
  for (const r of silentRuns) {
    const dur = (r.end - r.start) * hop;
    const wl = whitelisted(dur, whitelist);
    const start = sec(f, r.start);
    const end = sec(f, r.end);
    const db = fmtDb(minRms(f, r));
    if (wl) {
      out.push({ kind: 'pause', start, end, confidence: 1, whitelisted: true,
        detail: `白名单「${wl.label}」，${dur.toFixed(2)}s` });
      continue;
    }
    if (dur >= th.silenceMinSec) {
      out.push({ kind: 'silence', start, end, confidence: 0.95, whitelisted: false,
        detail: `空白 ${dur.toFixed(1)}s，最低 ${db}` });
      continue;
    }
    if (dur >= th.dropoutMinSec && dur <= th.dropoutMaxSec) {
      // 掉字：前后都有非静音内容（排除文件首尾的自然空白）
      const hasBefore = r.start > 0 && !masks.silence[r.start - 1];
      const hasAfter = r.end < f.count && !masks.silence[r.end];
      if (hasBefore && hasAfter) {
        out.push({ kind: 'dropout', start, end, confidence: 0.8, whitelisted: false,
          detail: `丢失 ${(dur * 1000).toFixed(0)}ms，最低 ${db}` });
        continue;
      }
    }
    out.push({ kind: 'pause', start, end, confidence: 1, whitelisted: false,
      detail: `停顿 ${dur.toFixed(2)}s` });
  }

  // ---- 单点爆音 ----
  for (const r of runsOf(masks.pop)) {
    const dur = (r.end - r.start) * hop;
    if (dur > th.popMaxSec) continue; // 过长的跳变交给噪声/削波判断
    let jump = 0;
    for (let i = r.start; i < r.end; i++) if (f.maxJump[i] > jump) jump = f.maxJump[i];
    out.push({ kind: 'pop', start: sec(f, r.start), end: sec(f, r.end),
      confidence: Math.min(1, jump / (th.popJump * 2)), whitelisted: false,
      detail: `瞬时跳变 ${jump.toFixed(2)}` });
  }

  // ---- 持续削波 ----
  for (const r of runsOf(masks.clip)) {
    const dur = (r.end - r.start) * hop;
    if (dur < th.clipMinSec) continue;
    out.push({ kind: 'clip', start: sec(f, r.start), end: sec(f, r.end),
      confidence: 0.9, whitelisted: false,
      detail: `持续削波 ${dur.toFixed(2)}s` });
  }

  // ---- 持续噪声 ----
  for (const r of runsOf(masks.noise)) {
    const dur = (r.end - r.start) * hop;
    if (dur < th.noiseMinSec) continue;
    out.push({ kind: 'noise', start: sec(f, r.start), end: sec(f, r.end),
      confidence: Math.min(1, avgFlat(f, r) / Math.max(th.noiseFlatness, 1e-6) - 0.2),
      detail: `噪声 ${dur.toFixed(1)}s，平坦度 ${avgFlat(f, r).toFixed(2)}` });
  }

  // ---- 音乐（信息项，不计故障） ----
  for (const r of runsOf(masks.music)) {
    const dur = (r.end - r.start) * hop;
    if (dur < th.musicMinSec) continue;
    out.push({ kind: 'music', start: sec(f, r.start), end: sec(f, r.end),
      confidence: 0.7, whitelisted: false,
      detail: `音乐片段 ${dur.toFixed(1)}s，平坦度 ${avgFlat(f, r).toFixed(2)}` });
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

export const FAULT_KINDS: SegmentKind[] = ['dropout', 'pop', 'clip', 'silence', 'noise'];
