export const CODE_BITS = 96;
export const TILE_COLS = 12;
export const TILE_ROWS = 8;
export const SYNC_WORD = 0x5ac3;
export const VERSION = 1;
const HAMMING_OFFSET = 16;
const CRC_OFFSET = 72;

const WHITEN_SEED = 0x9e3779b9;

function splitmix32(seed: number): number {
  let value = (seed + 0x9e3779b9) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97) >>> 0;
  return (value ^ (value >>> 15)) >>> 0;
}

export const WHITEN_MASK: Uint8Array = (() => {
  const mask = new Uint8Array(CODE_BITS);
  let state = WHITEN_SEED;
  for (let index = 0; index < CODE_BITS; index += 1) {
    state = splitmix32(state);
    mask[index] = (state >>> 31) & 1;
  }
  return mask;
})();

export function crc24(bytes: Uint8Array): number {
  let crc = 0xb704ce;
  for (const byte of bytes) {
    crc ^= byte << 16;
    for (let bit = 0; bit < 8; bit += 1) {
      crc <<= 1;
      if ((crc & 0x1000000) !== 0) crc ^= 0x864cfb;
      crc &= 0xffffff;
    }
  }
  return crc & 0xffffff;
}

export function creatorIdToBytes(creatorId: number): Uint8Array {
  const value = creatorId >>> 0;
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ]);
}

function writeBits(target: Uint8Array, offset: number, value: number, count: number): void {
  for (let bit = 0; bit < count; bit += 1) {
    const shift = count - 1 - bit;
    target[offset + bit] = (value >>> shift) & 1;
  }
}

function readBits(source: Uint8Array, offset: number, count: number): number {
  let value = 0;
  for (let bit = 0; bit < count; bit += 1) {
    value = (value << 1) | (source[offset + bit] & 1);
  }
  return value >>> 0;
}

export function validateCreatorId(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) {
    throw new RangeError("Creator ID must be an integer from 1 to 4294967295.");
  }
  return value >>> 0;
}

export function hamming74Encode(nibble: number): number {
  const d1 = (nibble >>> 3) & 1;
  const d2 = (nibble >>> 2) & 1;
  const d3 = (nibble >>> 1) & 1;
  const d4 = nibble & 1;
  const p1 = d1 ^ d2 ^ d4;
  const p2 = d1 ^ d3 ^ d4;
  const p4 = d2 ^ d3 ^ d4;
  return (p1 << 6) | (p2 << 5) | (d1 << 4) | (p4 << 3) | (d2 << 2) | (d3 << 1) | d4;
}

export function hamming74Decode(codeword: number): {
  nibble: number;
  corrected: boolean;
  syndrome: number;
} {
  let p1 = (codeword >>> 6) & 1;
  let p2 = (codeword >>> 5) & 1;
  let d1 = (codeword >>> 4) & 1;
  let p4 = (codeword >>> 3) & 1;
  let d2 = (codeword >>> 2) & 1;
  let d3 = (codeword >>> 1) & 1;
  let d4 = codeword & 1;
  const syndrome = (p1 ^ d1 ^ d2 ^ d4) | ((p2 ^ d1 ^ d3 ^ d4) << 1) | ((p4 ^ d2 ^ d3 ^ d4) << 2);
  if (syndrome >= 1 && syndrome <= 7) {
    const bit = 1 << (7 - syndrome);
    codeword ^= bit;
    p1 = (codeword >>> 6) & 1;
    p2 = (codeword >>> 5) & 1;
    d1 = (codeword >>> 4) & 1;
    p4 = (codeword >>> 3) & 1;
    d2 = (codeword >>> 2) & 1;
    d3 = (codeword >>> 1) & 1;
    d4 = codeword & 1;
  }
  return {
    nibble: (d1 << 3) | (d2 << 2) | (d3 << 1) | d4,
    corrected: syndrome >= 1 && syndrome <= 7,
    syndrome
  };
}

export interface PayloadCode {
  creatorId: number;
  crc: number;
  symbols: Uint8Array;
  raw: Uint8Array;
}

export function buildPayload(creatorId: number): PayloadCode {
  const id = validateCreatorId(creatorId);
  const raw = new Uint8Array(CODE_BITS);
  writeBits(raw, 0, SYNC_WORD, 16);
  for (let index = 0; index < 8; index += 1) {
    const nibble = (id >>> (28 - index * 4)) & 0xf;
    writeBits(raw, HAMMING_OFFSET + index * 7, hamming74Encode(nibble), 7);
  }

  const crcInput = new Uint8Array(5);
  crcInput[0] = VERSION;
  crcInput.set(creatorIdToBytes(id), 1);
  const crc = crc24(crcInput);
  writeBits(raw, CRC_OFFSET, crc, 24);

  const symbols = new Uint8Array(CODE_BITS);
  for (let index = 0; index < CODE_BITS; index += 1) {
    symbols[index] = raw[index] ^ WHITEN_MASK[index];
  }
  return { creatorId: id, crc, symbols, raw };
}

export interface DecodedPayload {
  creatorId: number;
  syncMatches: number;
  syncValid: boolean;
  crcValid: boolean;
  crcObserved: number;
  crcExpected: number;
  crcDistance: number;
  correctedIdBits: number;
  rawBits: Uint8Array;
}

export function decodeSymbols(symbolBits: Uint8Array): DecodedPayload {
  if (symbolBits.length !== CODE_BITS) {
    throw new RangeError("A watermark payload must contain exactly 96 bits.");
  }
  const raw = new Uint8Array(CODE_BITS);
  for (let index = 0; index < CODE_BITS; index += 1) {
    raw[index] = (symbolBits[index] & 1) ^ WHITEN_MASK[index];
  }

  const syncObserved = readBits(raw, 0, 16);
  let syncMatches = 0;
  for (let bit = 0; bit < 16; bit += 1) {
    const expected = (SYNC_WORD >>> (15 - bit)) & 1;
    if ((raw[bit] & 1) === expected) syncMatches += 1;
  }

  let creatorId = 0;
  let correctedIdBits = 0;
  for (let index = 0; index < 8; index += 1) {
    const decoded = hamming74Decode(readBits(raw, HAMMING_OFFSET + index * 7, 7));
    creatorId = ((creatorId << 4) | decoded.nibble) >>> 0;
    if (decoded.corrected) correctedIdBits += 1;
  }

  const crcObserved = readBits(raw, CRC_OFFSET, 24);
  const crcInput = new Uint8Array(5);
  crcInput[0] = VERSION;
  crcInput.set(creatorIdToBytes(creatorId), 1);
  const crcExpected = crc24(crcInput);
  let crcDifference = (crcObserved ^ crcExpected) >>> 0;
  let crcDistance = 0;
  while (crcDifference !== 0) {
    crcDistance += crcDifference & 1;
    crcDifference >>>= 1;
  }

  return {
    creatorId,
    syncMatches,
    syncValid: syncObserved === SYNC_WORD,
    crcValid: crcDistance === 0,
    crcObserved,
    crcExpected,
    crcDistance,
    correctedIdBits,
    rawBits: raw
  };
}

export function formatCreatorId(creatorId: number): string {
  return `#${creatorId.toString(10).padStart(6, "0")}`;
}
