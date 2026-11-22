// Walks parsed boxes and produces categorized Findings.
// Anything that cannot be confidently mapped is emitted as 'review' and never
// silently deleted.

import { type Reader, fourcc, decodeText, u32 } from './io.ts';
import type { BoxNode, Finding, InspectReport } from './types.ts';
import {
  ruleForKey,
  scanXmp,
  XMP_UUID,
  C2PA_UUID,
} from './tags.ts';
import { findFirst, flatten } from './mp4.ts';

async function readUtf8Key(reader: Reader, node: BoxNode): Promise<string> {
  // 'keys' entry: u32 entry-size, u32 key-namespace, null-terminated key value
  const buf = await reader.read(node.contentStart, node.end);
  const valueStart = 8;
  const end = buf.indexOf(0, valueStart);
  return new TextDecoder('utf-8')
    .decode(buf.subarray(valueStart, end === -1 ? buf.length : end))
    .trim();
}

async function resolveIlstKeys(
  reader: Reader,
  root: BoxNode[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const keysBox = findFirst(root, (n) => n.type === 'keys');
  if (!keysBox?.children) return map;
  for (const entry of keysBox.children) {
    const key = await readUtf8Key(reader, entry);
    // keys entries and ilst items correspond 1:1 by ordinal index.
    map.set(String(keysBox.children.indexOf(entry)), key);
  }
  return map;
}

async function dataPreview(reader: Reader, node: BoxNode): Promise<string> {
  const data = flatten([node]).find((n) => n.type === 'data');
  if (!data) return '';
  // data box: u32 type flags, u32 locale, then value
  const head = await reader.read(data.contentStart, data.contentStart + 8);
  const valueStart = data.contentStart + 8;
  const typeCode = u32(head, 0);
  if (typeCode === 13 || typeCode === 14 || typeCoord(typeCode)) {
    // JPEG / PNG — never dump binary; GPS coordinates are safe to preview.
    if (typeCoord(typeCode)) {
      const raw = await reader.read(valueStart, Math.min(data.end, valueStart + 64));
      return decodeText(raw, 0, raw.length);
    }
    return `<binary cover art, ${data.end - valueStart} bytes>`;
  }
  const raw = await reader.read(valueStart, Math.min(data.end, valueStart + 200));
  return decodeText(raw, 0, raw.length);
}

function typeCoord(code: number): boolean {
  return code === 15 || code === 16 || code === 17 || code === 22;
}

async function classifyIlst(
  reader: Reader,
  root: BoxNode[],
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const keyByPath = await resolveIlstKeys(reader, root);
  const ilsts = flatten(root).filter((n) => n.type === 'ilst');

  for (const ilst of ilsts) {
    for (const item of ilst.children ?? []) {
      let key: string | undefined;
      // Prefer the modern keys-table namespace (1:1 ordinal); fall back to four-char code.
      const ordinal = (ilst.children ?? []).indexOf(item);
      key = keyByPath.get(String(ordinal));
      key ??= fourcc(await reader.read(item.start, item.start + 4), 0);
      const rule = ruleForKey(key);
      const preview = await dataPreview(reader, item);
      if (rule) {
        findings.push({
          path: item.path,
          boxType: item.type,
          key,
          start: item.start,
          end: item.end,
          size: item.size,
          category: rule.category,
          confidence: rule.confidence,
          risk: rule.risk,
          reason: rule.reason,
          preview,
        });
      } else if (key === 'covr' || preview.startsWith('<binary cover art')) {
        findings.push({
          path: item.path, boxType: item.type, key,
          start: item.start, end: item.end, size: item.size,
          category: 'chat-thumbnail', confidence: 'confirmed',
          risk: 'container-only', reason: '内嵌封面/缩略图', preview,
        });
      } else {
        findings.push({
          path: item.path, boxType: item.type, key,
          start: item.start, end: item.end, size: item.size,
          category: 'edit-history', confidence: 'review',
          risk: 'container-nonstandard',
          reason: '未知 ilst 条目，无法确认用途，保留并建议人工确认',
          preview,
        });
      }
    }
  }
  return findings;
}

async function classifyUdtaLegacy(
  reader: Reader,
  root: BoxNode[],
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const udtas = flatten(root).filter((n) => n.type === 'udta');
  for (const udta of udtas) {
    for (const child of udta.children ?? []) {
      if (child.type === 'meta') continue; // handled via ilst path
      const key = child.type;
      const rule = ruleForKey(key);
      const preview = await dataPreview(reader, child);
      if (rule) {
        findings.push({
          path: child.path, boxType: child.type, key,
          start: child.start, end: child.end, size: child.size,
          category: rule.category, confidence: rule.confidence,
          risk: rule.risk, reason: rule.reason, preview,
        });
      } else {
        findings.push({
          path: child.path, boxType: child.type, key,
          start: child.start, end: child.end, size: child.size,
          category: 'edit-history', confidence: 'review',
          risk: 'container-nonstandard',
          reason: '未知 udta 子盒，无法确认用途，保留并建议人工确认',
          preview,
        });
      }
    }
  }
  return findings;
}

async function classifyUuid(
  reader: Reader,
  root: BoxNode[],
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const node of flatten(root).filter((n) => n.type === 'uuid')) {
    const payload = await reader.read(node.contentStart, node.end);
    if (node.uuid === XMP_UUID) {
      const scan = scanXmp(payload);
      const categories = new Set(scan.matched.map((m) => m.category));
      const reason = scan.matched.map((m) => m.reason).join('；') ||
        'XMP 数据包，内容未命中已知隐私字段';
      for (const category of categories) {
        const confidence = scan.matched.some(
          (m) => m.category === category && m.confidence === 'confirmed',
        ) ? 'confirmed' : 'review';
        findings.push({
          path: node.path, boxType: 'uuid', key: node.uuid,
          start: node.start, end: node.end, size: node.size,
          category, confidence,
          risk: 'container-only', reason, preview: scan.preview,
        });
      }
      if (categories.size === 0) {
        findings.push({
          path: node.path, boxType: 'uuid', key: node.uuid,
          start: node.start, end: node.end, size: node.size,
          category: 'edit-history', confidence: 'review',
          risk: 'container-only',
          reason: 'XMP 数据包但未识别出隐私字段，建议人工确认',
          preview: scan.preview,
        });
      }
    } else if (node.uuid === C2PA_UUID) {
      findings.push({
        path: node.path, boxType: 'uuid', key: node.uuid,
        start: node.start, end: node.end, size: node.size,
        category: 'edit-history', confidence: 'review',
        risk: 'container-only',
        reason: 'C2PA 内容凭证（来源/编辑链证明），删除会丢失来源证明，需人工决定',
      });
    } else {
      findings.push({
        path: node.path, boxType: 'uuid', key: node.uuid,
        start: node.start, end: node.end, size: node.size,
        category: 'edit-history', confidence: 'review',
        risk: 'container-nonstandard',
        reason: '厂商私有 uuid 扩展盒，无法确认内容，保留并建议人工确认',
      });
    }
  }
  return findings;
}

function classifyElst(root: BoxNode[]): Finding[] {
  const findings: Finding[] = [];
  for (const node of flatten(root).filter((n) => n.type === 'elst')) {
    findings.push({
      path: node.path, boxType: 'elst',
      start: node.start, end: node.end, size: node.size,
      category: 'edit-history', confidence: 'review',
      risk: 'breaks-timing',
      reason: 'edit list 记录裁剪/时间轴改动，但删除会改变播放时序，禁止自动处理',
    });
  }
  return findings;
}

export async function classifyAll(
  reader: Reader,
  root: BoxNode[],
): Promise<Omit<InspectReport, 'file' | 'fileSize' | 'brand' | 'sidecars' | 'notes'>> {
  const findings = [
    ...await classifyIlst(reader, root),
    ...await classifyUdtaLegacy(reader, root),
    ...await classifyUuid(reader, root),
    ...classifyElst(root),
  ];
  findings.sort((a, b) => a.start - b.start || a.end - b.end);
  return { findings };
}
