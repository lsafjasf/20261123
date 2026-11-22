// Random-access reader abstraction plus big-endian binary helpers.
// The same interfaces are implemented over node:fs and over File in the browser.

export interface Reader {
  readonly size: number;
  /** Range read; end is exclusive. */
  read(start: number, end: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

export function fourcc(buf: Uint8Array, offset = 0): string {
  // Four-char codes are byte-oriented; decode as latin-1 so values like
  // 0xA9 ('©') survive instead of being replaced with '?'.
  return new TextDecoder('latin1').decode(buf.subarray(offset, offset + 4));
}

export function u8(buf: Uint8Array, offset: number): number {
  return buf[offset] ?? 0;
}

export function u32(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] ?? 0) * 0x1000000) +
    ((buf[offset + 1] ?? 0) << 16) +
    ((buf[offset + 2] ?? 0) << 8) +
    (buf[offset + 3] ?? 0)
  );
}

export function u64(buf: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value = (value << 8n) | BigInt(buf[offset + i] ?? 0);
  }
  return value;
}

export function bytesToHex(
  buf: Uint8Array,
  start = 0,
  length = buf.length,
): string {
  let hex = '';
  for (let i = start; i < start + length; i++) {
    hex += (buf[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}

/** Decode UTF-8 text, replacing non-printable control characters. */
export function decodeText(buf: Uint8Array, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(slice);
  let text = '';
  for (const ch of decoded) {
    const code = ch.codePointAt(0) ?? 0;
    const allowed = code === 9 || code === 10 || code === 13;
    text += code >= 0x20 || allowed ? ch : '\uFFFD';
  }
  return text.trim().slice(0, 400);
}

export function indexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  from = 0,
): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
