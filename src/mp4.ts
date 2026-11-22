// Minimal ISO-BMFF / QuickTime MOV box parser.
// Parses structure only; sample payloads are never decoded or re-encoded.

import { type Reader, fourcc, u32, u64, bytesToHex } from './io.ts';
import type { BoxNode } from './types.ts';

const CONTAINER_TYPES = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta',
  'meta', 'ilst', 'keys', 'moof', 'traf', 'mvex', 'meco', 'mere',
]);

const FULL_BOX_TYPES = new Set([
  // Only boxes whose payload genuinely starts with version(1)+flags(3).
  // Sample-table boxes (stsz/stco/stsc/...) begin directly with entry_count.
  'meta', 'keys', 'ilst', 'hdlr', 'mvhd', 'tkhd', 'mdhd', 'elst',
]);

const HEADER_MIN = 8;
const HEADER_UUID = 8 + 16;
const HEADER_LARGE = 16;

export interface BoxHeader {
  type: string;
  start: number;
  headerSize: number;
  contentStart: number;
  end: number;
  size: number;
  uuid?: string;
  fullBox: boolean;
}

export async function readHeaderAt(
  reader: Reader,
  start: number,
): Promise<BoxHeader | null> {
  if (start + HEADER_MIN > reader.size) return null;
  const head = await reader.read(start, Math.min(start + HEADER_UUID, reader.size));
  let size = u32(head, 0);
  const type = fourcc(head, 4);
  let headerSize = HEADER_MIN;
  let uuid: string | undefined;

  if (type === 'uuid') {
    if (head.length < HEADER_UUID) return null;
    uuid = bytesToHex(head, 8, 16);
    headerSize = HEADER_UUID;
  }
  if (size === 1) {
    if (start + HEADER_LARGE > reader.size) return null;
    const large = u64(head, type === 'uuid' ? HEADER_UUID : HEADER_MIN);
    size = Number(large);
    headerSize = type === 'uuid' ? HEADER_UUID : HEADER_LARGE;
  } else if (size === 0) {
    size = reader.size - start; // box extends to EOF
  }
  if (size < headerSize || start + size > reader.size) return null;

  return {
    type,
    start,
    headerSize,
    contentStart: start + headerSize,
    end: start + size,
    size,
    uuid,
    fullBox: FULL_BOX_TYPES.has(type),
  };
}

function childContentStart(header: BoxHeader): number {
  // meta/keys/ilst carry a 4-byte version+flags prefix before children.
  return header.fullBox ? header.contentStart + 4 : header.contentStart;
}

async function parseChildren(
  reader: Reader,
  parent: BoxNode,
  from: number,
  until: number,
): Promise<BoxNode[]> {
  const children: BoxNode[] = [];
  const counters = new Map<string, number>();
  let cursor = from;
  while (cursor + HEADER_MIN <= until) {
    const header = await readHeaderAt(reader, cursor);
    if (!header) break;
    const index = counters.get(header.type) ?? 0;
    counters.set(header.type, index + 1);
    const node: BoxNode = {
      ...header,
      path: `${parent.path}/${header.type}[${index}]`,
    };
    if (header.fullBox) {
      const vf = await reader.read(header.contentStart, header.contentStart + 4);
      node.version = vf[0];
      node.flags = u32(vf, 0) & 0x00ffffff;
    }
    if (CONTAINER_TYPES.has(header.type) && header.end > childContentStart(header)) {
      node.children = await parseChildren(
        reader,
        node,
        childContentStart(header),
        header.end,
      );
    }
    children.push(node);
    cursor = header.end;
  }
  return children;
}

export async function parseFile(reader: Reader): Promise<BoxNode[]> {
  const root: BoxNode = {
    type: '<root>',
    start: 0,
    headerSize: 0,
    contentStart: 0,
    end: reader.size,
    size: reader.size,
    fullBox: false,
    path: '',
  };
  return parseChildren(reader, root, 0, reader.size);
}

export function flatten(nodes: BoxNode[]): BoxNode[] {
  const out: BoxNode[] = [];
  const walk = (list: BoxNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

export function findBoxes(nodes: BoxNode[], predicate: (n: BoxNode) => boolean): BoxNode[] {
  return flatten(nodes).filter(predicate);
}

export function findFirst(
  nodes: BoxNode[],
  predicate: (n: BoxNode) => boolean,
): BoxNode | undefined {
  return flatten(nodes).find(predicate);
}
