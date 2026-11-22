/**
 * 剪辑清单导出：全部为纯字符串拼接、固定列序，输出对相同 AnalysisResult 字节稳定。
 * - labels.csv   文件级标签（黑场/静止/抖动 + 严重度 + 覆盖率）
 * - segments.csv 黑场/静止/抖动时间码清单
 * - shots.csv    镜头切分与同事分配
 * - timeline.edl CMX 3600 EDL，可直接进剪辑软件
 */
import type { AnalysisResult, Segment, ShotSegment } from './types.ts';

function csvCell(value: string | number): string {
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvLine(values: Array<string | number>): string {
  return values.map(csvCell).join(',');
}

export function exportLabelsCsv(result: AnalysisResult): string {
  const header = csvLine([
    'file',
    'sha256',
    'label',
    'severity',
    'coverage',
    'occurrences',
    'duration_sec',
  ]);
  const rows = result.labels.map((label) =>
    csvLine([
      result.fileName,
      result.sha256,
      label.label,
      label.severity,
      label.coverage.toFixed(4),
      label.occurrences,
      result.durationSec.toFixed(3),
    ]),
  );
  return [header, ...rows].join('\n') + '\n';
}

const KIND_CN: Record<Segment['kind'], string> = {
  black: '黑场',
  freeze: '静止',
  shake: '抖动',
  shot: '镜头',
  gap: '空隙',
};

export function exportSegmentsCsv(result: AnalysisResult): string {
  const header = csvLine([
    'file',
    'sha256',
    'kind',
    'kind_cn',
    'start_tc',
    'end_tc',
    'start_frame',
    'end_frame',
    'start_pts',
    'end_pts',
    'duration_sec',
    'severity',
  ]);
  const segments = [...result.black, ...result.freeze, ...result.shake].sort(
    (a, b) => a.startFrame - b.startFrame || a.kind.localeCompare(b.kind),
  );
  const rows = segments.map((segment) =>
    csvLine([
      result.fileName,
      result.sha256,
      segment.kind,
      KIND_CN[segment.kind],
      segment.startTc,
      segment.endTc,
      segment.startFrame,
      segment.endFrame,
      segment.startPts.toFixed(3),
      segment.endPts.toFixed(3),
      segment.durationSec.toFixed(3),
      segment.severity.toFixed(4),
    ]),
  );
  return [header, ...rows].join('\n') + '\n';
}

export function exportShotsCsv(result: AnalysisResult): string {
  const header = csvLine([
    'file',
    'sha256',
    'shot_id',
    'assignee',
    'start_tc',
    'end_tc',
    'start_frame',
    'end_frame',
    'duration_sec',
    'flags',
  ]);
  const rows = result.shots.map((shot: ShotSegment) =>
    csvLine([
      result.fileName,
      result.sha256,
      shot.shotId,
      shot.assignee,
      shot.startTc,
      shot.endTc,
      shot.startFrame,
      shot.endFrame,
      shot.durationSec.toFixed(3),
      shot.flags.join('|'),
    ]),
  );
  return [header, ...rows].join('\n') + '\n';
}

/** 生成合法的 8 字符磁带名（CMX 要求大写字母数字）。 */
function reelName(sha256: string): string {
  return `V${sha256.slice(0, 7).toUpperCase()}`;
}

/** CMX 3600 EDL：每个镜头一个事件，Record In/Out 从 01:00:00:00 起排。 */
export function exportEdl(result: AnalysisResult): string {
  const lines: string[] = [
    `TITLE: ${result.fileName}`,
    `FCM: NON-DROP FRAME`,
  ];
  const reel = reelName(result.sha256);
  let recordFrames = result.frameRate * 3600;
  result.shots.forEach((shot, index) => {
    const eventNo = String(index + 1).padStart(3, '0');
    const recordStart = recordFrames;
    const length = Math.max(1, shot.endFrame - shot.startFrame + 1);
    const recordEnd = recordStart + length;
    lines.push('');
    lines.push(
      `${eventNo}  ${reel}  V     C        ${shot.startTc} ${shot.endTc} ${tcFromFrame(recordStart, result.frameRate)} ${tcFromFrame(recordEnd, result.frameRate)}`,
    );
    lines.push(`* FROM CLIP NAME: SHOT_${String(shot.shotId).padStart(3, '0')} ASSIGNEE: ${shot.assignee} FLAGS: ${shot.flags.join('|') || 'NONE'}`);
    recordFrames = recordEnd;
  });
  return lines.join('\n') + '\n';
}

function tcFromFrame(frame: number, frameRate: number): string {
  const fps = Math.round(frameRate);
  const f = ((frame % (fps * 3600 * 24)) + fps * 3600 * 24) % (fps * 3600 * 24);
  const hours = Math.floor(f / (fps * 3600));
  const minutes = Math.floor((f % (fps * 3600)) / (fps * 60));
  const seconds = Math.floor((f % (fps * 60)) / fps);
  const framesPart = f % fps;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(framesPart)}`;
}

export interface ExportBundle {
  'labels.csv': string;
  'segments.csv': string;
  'shots.csv': string;
  'timeline.edl': string;
  'analysis.json': string;
}

export function exportAll(result: AnalysisResult): ExportBundle {
  return {
    'labels.csv': exportLabelsCsv(result),
    'segments.csv': exportSegmentsCsv(result),
    'shots.csv': exportShotsCsv(result),
    'timeline.edl': exportEdl(result),
    'analysis.json': `${JSON.stringify(result, null, 2)}\n`,
  };
}
