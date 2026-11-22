/**
 * 确定性随机数：mulberry32（32 位）+ mix32 哈希。
 * 纯整数运算（用 Math.imul / Uint32Array 保证无符号回绕），
 * 同一 seed 在任何平台上产生完全相同的序列。
 */

export class Rng {
  private state: Uint32Array;

  constructor(seed: number) {
    this.state = new Uint32Array(1);
    this.state[0] = seed >>> 0;
  }

  /** [0, 0xffffffff] 的整数 */
  nextU32(): number {
    let z = (this.state[0] = (this.state[0] + 0x6d2b79f5) >>> 0);
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return (z ^ (z >>> 14)) >>> 0;
  }

  /** [0, 1) 双精度浮点 */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** [min, max) */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** 整数 [min, max] */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
}

/** 32 位混合哈希，用于把 (seed, eventId, 通道名) 折叠成发声体私有种子 */
export function hash32(a: number, b: number, c = 0): number {
  let h = 0x9e3779b9 >>> 0;
  h = mix(h ^ (a >>> 0));
  h = mix(h ^ (b >>> 0));
  h = mix(h ^ (c >>> 0));
  h = mix(h);
  h ^= h >>> 16;
  return h >>> 0;
}

function mix(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 字符串 -> 32 位哈希（FNV-1a），用于把材质/总线名编入种子 */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
