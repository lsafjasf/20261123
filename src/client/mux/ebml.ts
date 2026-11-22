/**
 * 极简 EBML 编码工具（WebM 容器所需子集）。
 * 参考 RFC 8794 / Matroska 规范，仅实现写入路径。
 */

/** 以无符号整数形式构造 EBML 元素 ID（调用方传入完整 ID 数值）。 */
export function vintEncode(value: number, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let rest = value;
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  out[0] |= 0x80 >>> (width - 1);
  return out;
}

/** 自动选择最小宽度编码 EBML VINT（含长度标记位）。 */
export function vintLength(value: number): number {
  if (value < 2 ** 7 - 2) {
    return 1;
  }
  if (value < 2 ** 14 - 2) {
    return 2;
  }
  if (value < 2 ** 21 - 2) {
    return 3;
  }
  if (value < 2 ** 28 - 2) {
    return 4;
  }
  if (value < 2 ** 35 - 2) {
    return 5;
  }
  if (value < 2 ** 42 - 2) {
    return 6;
  }
  if (value < 2 ** 49 - 2) {
    return 7;
  }
  return 8;
}

export function encodeVint(value: number): Uint8Array {
  return vintEncode(value, vintLength(value));
}

/** EBML 元素 ID 按其规范字节宽度原样输出。 */
export function encodeId(id: number, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let rest = id;
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  return out;
}

export function uintBytes(value: number): Uint8Array {
  if (value === 0) {
    return new Uint8Array(0);
  }
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Uint8Array.from(bytes);
}

export function float64Bytes(value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false);
  return new Uint8Array(buf);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

export interface EbmlElement {
  id: number;
  idWidth: number;
  body: Uint8Array;
}

export function element(
  id: number,
  idWidth: number,
  body: Uint8Array,
): EbmlElement {
  return { id, idWidth, body };
}

export function encodeElement(el: EbmlElement): Uint8Array {
  return concatBytes([
    encodeId(el.id, el.idWidth),
    encodeVint(el.body.length),
    el.body,
  ]);
}

export function uintElement(
  id: number,
  idWidth: number,
  value: number,
): EbmlElement {
  return element(id, idWidth, uintBytes(value));
}

export function floatElement(
  id: number,
  idWidth: number,
  value: number,
): EbmlElement {
  return element(id, idWidth, float64Bytes(value));
}

export function stringElement(
  id: number,
  idWidth: number,
  value: string,
): EbmlElement {
  return element(id, idWidth, new TextEncoder().encode(value));
}

export function masterElement(
  id: number,
  idWidth: number,
  children: EbmlElement[],
): EbmlElement {
  return element(
    id,
    idWidth,
    concatBytes(children.map(encodeElement)),
  );
}
