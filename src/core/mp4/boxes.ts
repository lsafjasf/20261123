// ISO BMFF 基础读写原语（无第三方依赖）。

export interface Box {
  type: string;
  start: number; // box 头起始（绝对偏移）
  size: number; // 含头
  headerSize: number;
  end: number;
}

export class Reader {
  view: DataView;
  pos = 0;
  buf: Uint8Array;
  constructor(buf: Uint8Array, offset = 0, length?: number) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset + offset, length ?? buf.byteLength - offset);
  }
  get remaining(): number {
    return this.view.byteLength - this.pos;
  }
  u8(): number { return this.view.getUint8(this.pos++); }
  u16(): number { const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  i16(): number { const v = this.view.getInt16(this.pos); this.pos += 2; return v; }
  u24(): number { return (this.u8() << 16) | this.u16(); }
  u32(): number { const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  i32(): number { const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
  u64(): number { const hi = this.u32(), lo = this.u32(); return hi * 2 ** 32 + lo; }
  str(n: number): string {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  bytes(n: number): Uint8Array {
    const b = this.buf.subarray(this.abs(), this.abs() + n);
    this.pos += n;
    return b;
  }
  abs(): number {
    return this.view.byteOffset - this.buf.byteOffset + this.pos;
  }
  skip(n: number): void { this.pos += n; }
}

// 顺序读取子 box
export function* children(buf: Uint8Array, start: number, end: number): Generator<Box> {
  let pos = start;
  while (pos + 8 <= end) {
    const v = new DataView(buf.buffer, buf.byteOffset + pos);
    let size = v.getUint32(0);
    const type = String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7));
    let header = 8;
    if (size === 1) {
      size = v.getUint32(8) * 2 ** 32 + v.getUint32(12);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    yield { type, start: pos, size, headerSize: header, end: pos + size };
    pos += size;
  }
}

export function findChild(buf: Uint8Array, start: number, end: number, type: string): Box | null {
  for (const b of children(buf, start, end)) if (b.type === type) return b;
  return null;
}

// ---- 写入 ----
export class Writer {
  private parts: Uint8Array[] = [];
  private len = 0;
  u8(v: number): this { return this.push(Uint8Array.of(v & 0xff)); }
  u16(v: number): this { return this.push(Uint8Array.of((v >> 8) & 0xff, v & 0xff)); }
  u24(v: number): this { return this.push(Uint8Array.of((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)); }
  u32(v: number): this {
    return this.push(Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff));
  }
  i32(v: number): this { return this.u32(v >>> 0); }
  u64(v: number): this { return this.u32(Math.floor(v / 2 ** 32)).u32(v % 2 ** 32); }
  str(s: string): this {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return this.push(b);
  }
  bytes(b: Uint8Array): this { return this.push(b); }
  push(b: Uint8Array): this {
    this.parts.push(b);
    this.len += b.byteLength;
    return this;
  }
  get length(): number { return this.len; }
  concat(): Uint8Array {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.byteLength; }
    return out;
  }
}

// box(type, payload) 自动带 32 位长度头
export function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const w = new Writer();
  let size = 8;
  for (const p of payloads) size += p.byteLength;
  w.u32(size).str(type);
  for (const p of payloads) w.bytes(p);
  return w.concat();
}

export function fullBox(type: string, version: number, flags: number, ...payloads: Uint8Array[]): Uint8Array {
  const w = new Writer();
  w.u8(version).u24(flags);
  for (const p of payloads) w.bytes(p);
  return box(type, w.concat());
}
