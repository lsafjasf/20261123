/**
 * Minimal PNG codec on top of node:zlib only.
 * Decode: 8-bit grey / RGB / RGBA, non-interlaced, all 5 scanline filters.
 * Encode: 8-bit RGBA, filter 0.
 */
import { inflateSync, deflateSync } from "node:zlib";
import { crc32 } from "../core/zip.ts";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf: Buffer): PngImage {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIG[i]) throw new Error("not a PNG file");
  }
  let pos = 8;
  let width = 0, height = 0, colorType = 6, interlace = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      colorType = data[9];
      interlace = data[12];
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
      if (![0, 2, 6].includes(colorType)) {
        throw new Error(`unsupported color type ${colorType}`);
      }
      if (interlace !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * ch;
  const rgba = new Uint8ClampedArray(width * height * 4);
  let prev = new Uint8Array(stride);
  let off = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[off++];
    const line = raw.subarray(off, off + stride);
    off += stride;
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = x * ch, d = row + x * 4;
      if (ch === 4) {
        rgba[d] = cur[s]; rgba[d + 1] = cur[s + 1];
        rgba[d + 2] = cur[s + 2]; rgba[d + 3] = cur[s + 3];
      } else if (ch === 3) {
        rgba[d] = cur[s]; rgba[d + 1] = cur[s + 1];
        rgba[d + 2] = cur[s + 2]; rgba[d + 3] = 255;
      } else {
        rgba[d] = rgba[d + 1] = rgba[d + 2] = cur[s];
        rgba[d + 3] = 255;
      }
    }
    prev = cur;
  }
  return { width, height, rgba };
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  const crc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data]));
  out.writeUInt32BE(crc >>> 0, 8 + data.length);
  return out;
}

export function encodePng(img: PngImage): Buffer {
  const { width, height, rgba } = img;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from(SIG),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
