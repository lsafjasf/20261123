import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { WavInfo } from "./types.ts";
import { fail } from "./errors.ts";

const RIFF_TAG = 0x46464952;
const RF64_TAG = 0x34364652;
const WAVE_TAG = 0x45564157;
const FMT_TAG = 0x20746d66;
const DATA_TAG = 0x61746164;
const DS64_TAG = 0x34367364;

const PCM = 0x0001;
const EXTENSIBLE = 0xfffe;

interface RiffChunk {
  id: number;
  size: number;
  dataOffset: number;
}

export async function readWavInfo(path: string): Promise<WavInfo> {
  const stats = await stat(path);
  const fileSize = stats.size;
  if (fileSize < 12) {
    fail("WAV_PARSE", `${path}: file is smaller than a RIFF container header (${fileSize} bytes).`);
  }
  const handle = await open(path, "r");
  try {
    const rootTag = await readUInt32(handle, path, 0);
    if (rootTag === 0x58464952) {
      fail("WAV_PARSE", `${path}: RIFX big-endian WAV is not supported; only little-endian RIFF/RF64 PCM.`);
    }
    if (rootTag !== RIFF_TAG && rootTag !== RF64_TAG) {
      fail("WAV_PARSE", `${path}: missing RIFF/RF64 signature.`);
    }
    const rf64 = rootTag === RF64_TAG;
    const waveTag = await readUInt32(handle, path, 8);
    if (waveTag !== WAVE_TAG) {
      fail("WAV_PARSE", `${path}: missing WAVE form type.`);
    }

    const chunks = await scanChunks(handle, path, fileSize, rf64);
    const fmtChunk = chunks.find((chunk) => chunk.id === FMT_TAG);
    if (!fmtChunk) {
      fail("WAV_PARSE", `${path}: fmt chunk not found.`);
    }
    if (fmtChunk.size < 16) {
      fail("WAV_PARSE", `${path}: fmt chunk is ${fmtChunk.size} bytes; PCM requires at least 16.`);
    }
    const dataChunk = chunks.find((chunk) => chunk.id === DATA_TAG);
    if (!dataChunk) {
      fail("WAV_PARSE", `${path}: data chunk not found.`);
    }

    let dataBytes = dataChunk.size;
    if (rf64) {
      const ds64 = chunks.find((chunk) => chunk.id === DS64_TAG);
      if (!ds64 || ds64.size < 28) {
        fail("WAV_PARSE", `${path}: RF64 file lacks a valid ds64 chunk.`);
      }
      dataBytes = Number(await readUInt64(handle, path, ds64.dataOffset + 24));
    }

    const fmt = await readFmt(handle, path, fmtChunk);
    validateFmt(path, fmt);

    const available = fileSize - dataChunk.dataOffset;
    if (BigInt(dataBytes) > BigInt(available)) {
      fail(
        "WAV_TRUNCATED",
        `${path}: data chunk declares ${dataBytes} bytes but only ${available} bytes follow the chunk header.`,
      );
    }
    if (dataBytes % fmt.blockAlign !== 0) {
      fail(
        "WAV_PARSE",
        `${path}: data length ${dataBytes} is not a multiple of block align ${fmt.blockAlign}; trailing partial frame.`,
      );
    }

    return {
      path,
      formatCode: fmt.formatCode,
      channels: fmt.channels,
      sampleRate: fmt.sampleRate,
      bytesPerSecond: fmt.bytesPerSecond,
      blockAlign: fmt.blockAlign,
      bitsPerSample: fmt.bitsPerSample,
      dataOffset: dataChunk.dataOffset,
      dataBytes,
      frameCount: dataBytes / fmt.blockAlign,
      frameBytes: fmt.blockAlign,
      rf64,
    };
  } finally {
    await handle.close();
  }
}

interface DecodedFmt {
  formatCode: number;
  channels: number;
  sampleRate: number;
  bytesPerSecond: number;
  blockAlign: number;
  bitsPerSample: number;
}

async function readFmt(handle: FileHandle, path: string, chunk: RiffChunk): Promise<DecodedFmt> {
  const buffer = Buffer.alloc(Math.min(chunk.size, 40));
  await readExact(handle, path, buffer, 0, buffer.length, chunk.dataOffset);
  const wordFormat = buffer.readUInt16LE(0);
  const subFormat = chunk.size >= 40 ? buffer.readUInt16LE(24) : wordFormat;
  return {
    formatCode: wordFormat === EXTENSIBLE ? subFormat : wordFormat,
    channels: buffer.readUInt16LE(2),
    sampleRate: buffer.readUInt32LE(4),
    bytesPerSecond: buffer.readUInt32LE(8),
    blockAlign: buffer.readUInt16LE(12),
    bitsPerSample: buffer.readUInt16LE(14),
  };
}

function validateFmt(path: string, fmt: DecodedFmt): void {
  if (fmt.formatCode !== PCM) {
    fail("WAV_PARSE", `${path}: unsupported format code 0x${fmt.formatCode.toString(16).padStart(4, "0")}; only uncompressed PCM.`);
  }
  if (fmt.channels < 1 || fmt.channels > 8) {
    fail("WAV_PARSE", `${path}: invalid channel count ${fmt.channels}.`);
  }
  if (fmt.sampleRate === 0 || fmt.bytesPerSecond !== fmt.sampleRate * fmt.blockAlign) {
    fail("WAV_PARSE", `${path}: inconsistent fmt byte rate ${fmt.bytesPerSecond}.`);
  }
  if (fmt.blockAlign !== (fmt.bitsPerSample / 8) * fmt.channels) {
    fail("WAV_PARSE", `${path}: block align ${fmt.blockAlign} does not match ${fmt.channels}ch x ${fmt.bitsPerSample}bit.`);
  }
  if (![8, 16, 24, 32].includes(fmt.bitsPerSample)) {
    fail("WAV_PARSE", `${path}: unsupported PCM bit depth ${fmt.bitsPerSample}.`);
  }
}

async function scanChunks(handle: FileHandle, path: string, fileSize: number, rf64: boolean): Promise<RiffChunk[]> {
  const chunks: RiffChunk[] = [];
  let offset = 12;
  while (offset + 8 <= fileSize) {
    const id = await readUInt32(handle, path, offset);
    const sizeField = await readUInt32(handle, path, offset + 4);
    const size = rf64 && sizeField === 0xffffffff ? Number.POSITIVE_INFINITY : sizeField;
    const dataOffset = offset + 8;
    if (Number.isFinite(size) && dataOffset + (size as number) > fileSize) {
      fail("WAV_TRUNCATED", `${path}: chunk "${tag(id)}" extends past end of file.`);
    }
    chunks.push({ id, size: Number.isFinite(size) ? (size as number) : Number.MAX_SAFE_INTEGER, dataOffset });
    if (!Number.isFinite(size)) {
      break;
    }
    offset = dataOffset + (size as number) + ((size as number) % 2);
  }
  return chunks;
}

async function readUInt32(handle: FileHandle, path: string, offset: number): Promise<number> {
  const buffer = Buffer.alloc(4);
  await readExact(handle, path, buffer, 0, 4, offset);
  return buffer.readUInt32LE(0);
}

async function readUInt64(handle: FileHandle, path: string, offset: number): Promise<bigint> {
  const buffer = Buffer.alloc(8);
  await readExact(handle, path, buffer, 0, 8, offset);
  return buffer.readBigUInt64LE(0);
}

async function readExact(
  handle: FileHandle,
  path: string,
  buffer: Buffer,
  targetOffset: number,
  length: number,
  fileOffset: number,
): Promise<void> {
  const result = await handle.read(buffer, targetOffset, length, fileOffset);
  if (result.bytesRead !== length) {
    fail("WAV_TRUNCATED", `${path}: expected ${length} bytes at offset ${fileOffset}, read ${result.bytesRead}.`);
  }
}

function tag(value: number): string {
  return Buffer.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]).toString("latin1");
}
