/** 扫描流水线：指标收尾 → 确定性分析 → 结果与剪辑清单落盘。 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { analyzeBundle } from '../shared/engine.ts';
import { exportAll } from '../shared/exporters.ts';
import type { AnalysisResult, MetricBundle } from '../shared/types.ts';
import { ScanStore, atomicWrite } from './store.ts';

export interface PipelineOutput {
  result: AnalysisResult;
  exportDir: string;
  files: string[];
}

export function analyzeFromStore(store: ScanStore, sha256: string): PipelineOutput {
  const bundle = store.loadBundle(sha256);
  const result = analyzeBundle(bundle, DEFAULT_CONFIG, new Date());
  store.saveResult(result);
  return writeExports(store, result);
}

export function analyzeBundleDirect(
  store: ScanStore,
  bundle: MetricBundle,
): PipelineOutput {
  const result = analyzeBundle(bundle, DEFAULT_CONFIG, new Date());
  store.saveResult(result);
  return writeExports(store, result);
}

export function writeExports(
  store: ScanStore,
  result: AnalysisResult,
): PipelineOutput {
  const exportDir = join(store.rootDir, 'exports', result.sha256);
  mkdirSync(exportDir, { recursive: true });
  const files = exportAll(result);
  const written: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(exportDir, name);
    atomicWrite(path, content);
    written.push(path);
  }
  return { result, exportDir, files: written };
}

/** 批量汇总所有已完成扫描的镜头分配总表。 */
export function exportMasterShotsCsv(store: ScanStore): string {
  const header = [
    'file',
    'sha256',
    'shot_id',
    'assignee',
    'start_tc',
    'end_tc',
    'duration_sec',
    'flags',
  ].join(',');
  const rows = store.listResults().flatMap((result) =>
    result.shots.map((shot) =>
      [
        result.fileName,
        result.sha256,
        shot.shotId,
        shot.assignee,
        shot.startTc,
        shot.endTc,
        shot.durationSec.toFixed(3),
        shot.flags.join('|'),
      ].join(','),
    ),
  );
  return [header, ...rows].join('\n') + '\n';
}
