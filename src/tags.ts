// Knowledge tables for metadata keys and XMP signal scanning.
// Only well-documented keys get 'confirmed'; anything uncertain stays 'review'.

import type { CategoryId, Confidence, Risk } from './types.ts';
import { indexOfBytes } from './io.ts';

export interface KeyRule {
  category: CategoryId;
  confidence: Confidence;
  risk: Risk;
  reason: string;
}

// Modern iTunes-style keys (moov/udta/meta/keys + ilst), including Apple locale keys.
const ILS_KEYS: Record<string, KeyRule> = {
  'com.apple.quicktime.location.ISO6709': {
    category: 'location', confidence: 'confirmed', risk: 'container-only',
    reason: 'QuickTime 标准定位坐标（ISO 6709）',
  },
  'com.apple.quicktime.location': {
    category: 'location', confidence: 'confirmed', risk: 'container-only',
    reason: 'QuickTime 位置信息',
  },
  'com.apple.quicktime.place': {
    category: 'location', confidence: 'confirmed', risk: 'container-only',
    reason: 'QuickTime 拍摄地点名称',
  },
  'com.apple.quicktime.make': {
    category: 'device', confidence: 'confirmed', risk: 'container-only',
    reason: '设备制造商',
  },
  'com.apple.quicktime.model': {
    category: 'device', confidence: 'confirmed', risk: 'container-only',
    reason: '设备型号',
  },
  'com.apple.quicktime.software': {
    category: 'device', confidence: 'confirmed', risk: 'container-only',
    reason: '操作系统/软件版本',
  },
  'com.apple.quicktime.creator': {
    category: 'device', confidence: 'review', risk: 'container-only',
    reason: '创建者应用，可能含设备或账号线索',
  },
  'com.apple.quicktime.artist': {
    category: 'device', confidence: 'review', risk: 'container-only',
    reason: '作者字段，可能含个人身份信息',
  },
  'com.apple.quicktime.content.identifier': {
    category: 'edit-history', confidence: 'review', risk: 'container-only',
    reason: '内容标识，可能关联剪辑/云端工程',
  },
  'com.apple.quicktime.author': {
    category: 'device', confidence: 'review', risk: 'container-only',
    reason: '作者字段，可能含个人身份信息',
  },
  covr: {
    category: 'chat-thumbnail', confidence: 'confirmed', risk: 'container-only',
    reason: '内嵌封面/缩略图（可能被聊天软件复用为预览图）',
  },
  'com.example.chat.preview': {
    category: 'chat-thumbnail', confidence: 'review', risk: 'container-only',
    reason: '疑似聊天软件写入的预览图，键名为厂商私有，建议人工确认',
  },
};

// Legacy 3GPP / QuickTime four-char user-data tags (moov/udta/*).
const UDTA_KEYS: Record<string, KeyRule> = {
  '\u00A9xyz': {
    category: 'location', confidence: 'confirmed', risk: 'container-only',
    reason: 'ISO 6709 GPS 坐标标签',
  },
  '\u00A9mak': {
    category: 'device', confidence: 'confirmed', risk: 'container-only',
    reason: '设备制造商',
  },
  make: {
    category: 'device', confidence: 'confirmed', risk: 'container-only',
    reason: '设备制造商（3GPP）',
  },
  '\u00A9mod': {
    category: 'device', confidence: 'confirmed', risk: 'container-only',
    reason: '设备型号',
  },
  modl: {
    category: 'device', confidence: 'confirmed', risk: 'container-only',
    reason: '设备型号（3GPP）',
  },
  '\u00A9swr': {
    category: 'device', confidence: 'confirmed', risk: 'container-only',
    reason: '软件/系统版本',
  },
  swrt: {
    category: 'device', confidence: 'confirmed', risk: 'container-only',
    reason: '软件/系统版本（3GPP）',
  },
  '\u00A9too': {
    category: 'device', confidence: 'review', risk: 'container-only',
    reason: '编码器/工具名，可能暴露设备与剪辑链路',
  },
  '\u00A9ART': {
    category: 'device', confidence: 'review', risk: 'container-only',
    reason: '艺术家字段，可能含个人身份信息',
  },
  '\u00A9aut': {
    category: 'device', confidence: 'review', risk: 'container-only',
    reason: '作者字段，可能含个人身份信息',
  },
  '\u00A9cmt': {
    category: 'edit-history', confidence: 'review', risk: 'container-only',
    reason: '注释字段，可能含旧剪辑备注',
  },
  cprt: {
    category: 'device', confidence: 'review', risk: 'container-only',
    reason: '版权字段，可能含个人或账号信息',
  },
  tvsn: {
    category: 'device', confidence: 'review', risk: 'container-only',
    reason: '厂商私有版本标签，建议人工确认',
  },
};

export function ruleForKey(key: string): KeyRule | undefined {
  return ILS_KEYS[key] ?? UDTA_KEYS[key];
}

export function isCoverArt(key: string): boolean {
  return key === 'covr';
}

// Adobe XMP packet inside a uuid box.
export const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';
// C2PA content credentials (JUMBF) uuid box.
export const C2PA_UUID = 'd8fec3d61b0e481c886093c89faae879';

interface XmpSignal {
  needle: string;
  category: CategoryId;
  confidence: Confidence;
  reason: string;
}

const XMP_SIGNALS: XmpSignal[] = [
  { needle: 'exif:GPS', category: 'location', confidence: 'confirmed', reason: 'XMP/EXIF GPS 定位字段' },
  { needle: 'photoshop:City', category: 'location', confidence: 'confirmed', reason: 'XMP 城市信息' },
  { needle: 'photoshop:Country', category: 'location', confidence: 'confirmed', reason: 'XMP 国家信息' },
  { needle: 'exif:Make', category: 'device', confidence: 'confirmed', reason: 'XMP 设备制造商' },
  { needle: 'exif:Model', category: 'device', confidence: 'confirmed', reason: 'XMP 设备型号' },
  { needle: 'xmp:CreatorTool', category: 'edit-history', confidence: 'confirmed', reason: '剪辑/创作工具记录' },
  { needle: 'xmpMM:History', category: 'edit-history', confidence: 'confirmed', reason: 'XMP 编辑历史 (ResourceEvent)' },
  { needle: 'stEvt:action', category: 'edit-history', confidence: 'confirmed', reason: 'XMP 编辑动作记录' },
  { needle: 'xmp:MetadataDate', category: 'edit-history', confidence: 'review', reason: '元数据修改时间' },
  { needle: 'dc:creator', category: 'device', confidence: 'review', reason: '作者字段，可能含身份信息' },
  { needle: 'Thumbnail', category: 'chat-thumbnail', confidence: 'review', reason: 'XMP 内嵌缩略图引用' },
];

export interface XmpScan {
  matched: { category: CategoryId; confidence: Confidence; reason: string }[];
  preview: string;
}

export function scanXmp(payload: Uint8Array): XmpScan {
  const matched: XmpScan['matched'] = [];
  const seen = new Set<string>();
  for (const signal of XMP_SIGNALS) {
    const needle = new TextEncoder().encode(signal.needle);
    if (indexOfBytes(payload, needle) >= 0 && !seen.has(signal.needle)) {
      seen.add(signal.needle);
      matched.push({
        category: signal.category,
        confidence: signal.confidence,
        reason: signal.reason,
      });
    }
  }
  const preview = new TextDecoder('utf-8', { fatal: false })
    .decode(payload.subarray(0, 300))
    .replace(/[<>\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { matched, preview: preview.slice(0, 240) };
}
