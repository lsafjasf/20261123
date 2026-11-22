// sync 子命令：日志 + 帧表 + 锚点 → 映射 + 逐事件表
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseLog, matchCombos } from '../shared/logparse.ts';
import { buildFrameIndex, buildMapping, mapEvents, eventsToCsv, mapLogToVideo } from '../shared/sync.ts';
import type { Anchor, ComboDef } from '../shared/types.ts';

export interface SyncOptions {
  logPath: string;
  framesPath: string;
  anchorsPath?: string;
  combosPath?: string;
  outDir: string;
}

export function runSync(opts: SyncOptions): void {
  const log = parseLog(readFileSync(opts.logPath, 'utf8'));
  const framesJson = JSON.parse(readFileSync(opts.framesPath, 'utf8'));
  const ptsList: number[] = Array.isArray(framesJson) ? framesJson : framesJson.pts;
  if (!Array.isArray(ptsList)) throw new Error('frames 文件应为 [pts...] 或 {"pts":[...]}');
  const index = buildFrameIndex(ptsList);

  const anchors: Anchor[] = opts.anchorsPath
    ? JSON.parse(readFileSync(opts.anchorsPath, 'utf8'))
    : [];
  if (anchors.length === 0) throw new Error('没有锚点：请先提供 anchors.json（可来自 Web 标注台导出）');

  const mapping = buildMapping(anchors, index);
  const mapped = mapEvents(log.events, mapping, index);

  const combos: ComboDef[] = opts.combosPath
    ? JSON.parse(readFileSync(opts.combosPath, 'utf8'))
    : [];
  const comboMatches = matchCombos(log.events, combos).map((m) => ({
    ...m,
    startVideoT: Math.round(mapLogToVideo(mapping, m.startLogT).videoT),
    endVideoT: Math.round(mapLogToVideo(mapping, m.endLogT).videoT),
  }));

  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, 'mapping.json'), JSON.stringify(mapping, null, 2));
  writeFileSync(join(opts.outDir, 'events.json'), JSON.stringify(mapped, null, 2));
  writeFileSync(join(opts.outDir, 'events.csv'), eventsToCsv(mapped));
  writeFileSync(join(opts.outDir, 'combos.json'), JSON.stringify(comboMatches, null, 2));

  const low = mapped.filter((m) => m.confidence < 0.7).length;
  console.log(`事件 ${mapped.length} 条，段 ${mapping.segments.length} 个，冲突锚点 ${mapping.conflicts.length} 个`);
  console.log(`低置信度(<0.7)事件 ${low} 条；暂停 ${index.pauses.length} 处`);
  console.log(`输出目录: ${opts.outDir}/ (mapping.json, events.csv, events.json, combos.json)`);
}
