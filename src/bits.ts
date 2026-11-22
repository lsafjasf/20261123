// 位级写入器：用于手工构造 H.264 (Exp-Golomb) 与 AAC 比特流。

export class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private nbits = 0;

  bit(b: number): void {
    this.cur = (this.cur << 1) | (b & 1);
    this.nbits += 1;
    if (this.nbits === 8) {
      this.bytes.push(this.cur);
      this.cur = 0;
      this.nbits = 0;
    }
  }

  bits(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) this.bit((value >>> i) & 1);
  }

  // 无符号 Exp-Golomb ue(v)
  ue(value: number): void {
    const v = value + 1;
    const len = 32 - Math.clz32(v);
    this.bits(0, len - 1);
    this.bits(v, len);
  }

  // 有符号 Exp-Golomb se(v)
  se(value: number): void {
    this.ue(value <= 0 ? -2 * value : 2 * value - 1);
  }

  byteAligned(): boolean {
    return this.nbits === 0;
  }

  alignZero(): void {
    while (this.nbits !== 0) this.bit(0);
  }

  // rbsp_trailing_bits: 一个 1 后补 0 到字节对齐
  rbspTrailing(): void {
    this.bit(1);
    this.alignZero();
  }

  appendBytes(data: Uint8Array): void {
    if (this.nbits !== 0) throw new Error("追加原始字节前必须字节对齐");
    for (const b of data) this.bytes.push(b);
  }

  toUint8Array(): Uint8Array {
    if (this.nbits !== 0) throw new Error("比特流未字节对齐");
    return Uint8Array.from(this.bytes);
  }
}

// RBSP -> EBSP：在 00 00 {00,01,02,03} 前插入 0x03 防竞争字节。
export function ebspFromRbsp(rbsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}
