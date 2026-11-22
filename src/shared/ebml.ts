const MAX_VINT_BYTES = 8;

export function unsignedVint(value: number | bigint, forceBytes?: number): Uint8Array {
  let remaining = typeof value === "bigint" ? value : BigInt(value);
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(remaining & 0xffn));
    remaining >>= 8n;
  } while (remaining > 0n);

  const fitsIn = (byteCount: number): boolean => {
    const payloadBits = byteCount * 7;
    if (payloadBits >= 64) {
      return true;
    }
    const maxValue = 2 ** payloadBits - 1;
    const numeric = typeof value === "bigint" ? value : BigInt(value);
    return numeric <= BigInt(maxValue);
  };
  const minBytes = forceBytes ?? (fitsIn(1) ? 1 : fitsIn(2) ? 2 : fitsIn(3) ? 3 : bytes.length + 1);
  const length = Math.max(bytes.length, minBytes);
  while (bytes.length < length) {
    bytes.unshift(0);
  }
  if (length > MAX_VINT_BYTES) {
    throw new Error("vint too large");
  }
  bytes[0] |= 1 << (8 - length);
  return Uint8Array.from(bytes);
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function encodeElement(id: Uint8Array, payload: Uint8Array): Uint8Array {
  return concatBytes([id, unsignedVint(payload.byteLength), payload]);
}

export function encodeUint(id: Uint8Array, value: number | bigint): Uint8Array {
  let remaining = typeof value === "bigint" ? value : BigInt(value);
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(remaining & 0xffn));
    remaining >>= 8n;
  } while (remaining > 0n);
  return encodeElement(id, Uint8Array.from(bytes));
}

export function encodeFloat(id: Uint8Array, value: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return encodeElement(id, new Uint8Array(buffer));
}

export function encodeString(id: Uint8Array, value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return encodeElement(id, bytes);
}

export function idBytes(id: number): Uint8Array {
  const hex = id.toString(16).padStart(2, "0");
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface ParsedElement {
  id: Uint8Array;
  dataOffset: number;
  dataSize: number;
  headerSize: number;
}

function readVint(view: DataView, offset: number): { value: number; length: number; unknown: boolean } {
  const first = view.getUint8(offset);
  let length = 0;
  while (length < MAX_VINT_BYTES && ((first >> (7 - length)) & 1) === 0) {
    length += 1;
  }
  length += 1;
  let value = first & (0xff >> length);
  let unknown = value === (0xff >> length);
  for (let i = 1; i < length; i += 1) {
    const byte = view.getUint8(offset + i);
    if (byte !== 0xff) {
      unknown = false;
    }
    value = value * 256 + byte;
  }
  return { value: unknown ? -1 : value, length, unknown };
}

export function parseElement(buffer: Uint8Array, offset = 0): ParsedElement | undefined {
  if (offset >= buffer.byteLength) {
    return undefined;
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const idStart = offset;
  const idVint = readVint(view, offset);
  const sizeVint = readVint(view, offset + idVint.length);
  const headerSize = idVint.length + sizeVint.length;
  return {
    id: buffer.slice(idStart, idStart + idVint.length),
    dataOffset: offset + headerSize,
    dataSize: sizeVint.value,
    headerSize,
  };
}

export function* walkElements(buffer: Uint8Array, start = 0, end?: number): Generator<ParsedElement> {
  let offset = start;
  const stop = end ?? buffer.byteLength;
  while (offset < stop) {
    const element = parseElement(buffer, offset);
    if (!element || element.dataSize < 0) {
      return;
    }
    yield element;
    offset = element.dataOffset + element.dataSize;
  }
}

export function sameId(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function readUint(buffer: Uint8Array, element: ParsedElement): number {
  let value = 0;
  for (let i = 0; i < element.dataSize; i += 1) {
    value = value * 256 + buffer[element.dataOffset + i];
  }
  return value;
}

export function readFloat(buffer: Uint8Array, element: ParsedElement): number {
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset + element.dataOffset,
    element.dataSize,
  );
  return view.getFloat64(0, false);
}
