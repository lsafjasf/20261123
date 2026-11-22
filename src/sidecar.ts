// Detects same-basename sidecar files that can leak the same privacy signals.
// Detection only: sidecars are never modified or deleted automatically.

import { readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { SidecarWarning } from './types.ts';

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.3gp', '.3g2', '.heic', '.jpg', '.jpeg',
]);

function classifySidecar(name: string, stem: string): SidecarWarning | null {
  const lower = name.toLowerCase();
  const ext = extname(lower);

  if (lower === `.${stem}.xmp` || lower === `${stem}.xmp`) {
    return {
      path: name, kind: 'xmp-sidecar', risk: 'high',
      note: 'XMP 旁路文件，通常含 GPS、设备、完整编辑历史',
    };
  }
  if (lower === `${stem}.json` || /\.[0-9a-f]{8,}\.json$/.test(lower) ||
      /^takeout.*\.json$/.test(lower)) {
    return {
      path: name, kind: 'google-takeout-json', risk: 'high',
      note: 'Google 相册/Takeout JSON，含 GPS 时间线、设备与专辑信息',
    };
  }
  if (lower.startsWith(`._${stem}`) || lower === `.ds_store`) {
    return {
      path: name, kind: 'appledouble', risk: 'medium',
      note: 'AppleDouble/资源叉文件，可能缓存缩略图与元数据',
    };
  }
  if (lower === `${stem}.aae` || lower.endsWith('.aae')) {
    return {
      path: name, kind: 'generic-metadata', risk: 'high',
      note: 'Apple 剪辑调整记录 (.aae)，记录旧剪辑参数',
    };
  }
  if (/\.(thm|thumbnail|jpeg|jpg|png|webp)$/.test(lower) &&
      (lower.startsWith(stem.toLowerCase()) || stem.toLowerCase().startsWith(lower.split('.')[0]!))) {
    return {
      path: name, kind: 'thumbnail-cache', risk: 'high',
      note: '同名缩略图/封面图，可能暴露画面内容与聊天预览',
    };
  }
  if (/\.(srt|vtt|csv|gpx|kml|log)$/.test(lower)) {
    return {
      path: name, kind: 'generic-metadata', risk: 'medium',
      note: '同名数据文件（字幕/轨迹/日志），可能含位置或对话信息',
    };
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return {
      path: name, kind: 'same-basename', risk: 'review',
      note: '同名媒体文件，发布前请单独检查其元数据',
    };
  }
  return null;
}

export async function scanSidecars(
  directory: string,
  videoFileName: string,
): Promise<SidecarWarning[]> {
  const stem = basename(videoFileName, extname(videoFileName));
  const warnings: SidecarWarning[] = [];
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return warnings;
  }
  for (const name of entries.sort()) {
    if (name === videoFileName) continue;
    const lowerName = name.toLowerCase();
    const lowerStem = stem.toLowerCase();
    const stemMatch = lowerName.includes(lowerStem) ||
      name.startsWith(`._${stem}`);
    if (!stemMatch) continue;
    const warning = classifySidecar(name, stem);
    if (warning) warnings.push({ ...warning, path: join(directory, name) });
  }
  return warnings;
}
