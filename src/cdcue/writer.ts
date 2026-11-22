import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { WavInfo } from "./types.ts";
import { fail } from "./errors.ts";

const MAX_RIFF_DATA = 0xfffffffe;
const COPY_CHUNK_FRAMES = 4096;

export interface CopiedRange {
  byteLength: number;
  sha256: string;
}

export function writeWavHeader(buffer: Buffer, info: WavInfo, dataBytes: number): void {
  if (dataBytes > MAX_RIFF_DATA) {
    fail("IO_ERROR", `output WAV PCM data of ${dataBytes} bytes exceeds 4 GiB RIFF limit (${MAX_RIFF_DATA}).`);
  }
  buffer.writeUInt32LE(0x46464952, 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.writeUInt32LE(0x45564157, 8);
  buffer.writeUInt32LE(0x20746d66, 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(info.channels, 22);
  buffer.writeUInt32LE(info.sampleRate, 24);
  buffer.writeUInt32LE(info.bytesPerSecond, 28);
  buffer.writeUInt16LE(info.blockAlign, 32);
  buffer.writeUInt16LE(info.bitsPerSample, 34);
  buffer.writeUInt32LE(0x61746164, 36);
  buffer.writeUInt32LE(dataBytes, 40);
}

export async function copyRange(
  source: FileHandle,
  target: FileHandle,
  info: WavInfo,
  startSample: number,
  frameCount: number,
  sharedHash?: ReturnType<typeof createHash>,
): Promise<CopiedRange> {
  const byteLength = frameCount * info.frameBytes;
  if (startSample < 0 || startSample + frameCount > info.frameCount) {
    fail(
      "LENGTH_INSUFFICIENT",
      `requested samples [${startSample}, ${startSample + frameCount}) exceed source range [0, ${info.frameCount}).`,
    );
  }
  if (byteLength > MAX_RIFF_DATA) {
    fail("IO_ERROR", `region of ${byteLength} bytes exceeds 4 GiB RIFF limit.`);
  }

  const header = Buffer.alloc(44);
  writeWavHeader(header, info, byteLength);
  await writeAll(target, header);

  const hash = createHash("sha256");
  const scratch = Buffer.alloc(COPY_CHUNK_FRAMES * info.frameBytes);
  let remaining = frameCount;
  let cursorSample = startSample;

  while (remaining > 0) {
    const frames = Math.min(remaining, COPY_CHUNK_FRAMES);
    const bytes = frames * info.frameBytes;
    const readResult = await source.read(scratch, 0, bytes, info.dataOffset + cursorSample * info.frameBytes);
    if (readResult.bytesRead !== bytes) {
      fail("WAV_TRUNCATED", `short read at sample ${cursorSample}: wanted ${bytes} bytes, got ${readResult.bytesRead}.`);
    }
    const chunk = scratch.subarray(0, bytes);
    hash.update(chunk);
    sharedHash?.update(chunk);
    await writeAll(target, chunk);
    cursorSample += frames;
    remaining -= frames;
  }

  return { byteLength, sha256: hash.digest("hex") };
}

export async function hashDataRange(path: string, dataOffset: number, dataBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const scratch = Buffer.alloc(1024 * 1024);
    let remaining = dataBytes;
    let cursor = dataOffset;
    while (remaining > 0) {
      const bytes = Math.min(remaining, scratch.length);
      const result = await handle.read(scratch, 0, bytes, cursor);
      if (result.bytesRead !== bytes) {
        fail("WAV_TRUNCATED", `hash read truncated at byte ${cursor}: wanted ${bytes}, got ${result.bytesRead}.`);
      }
      hash.update(scratch.subarray(0, bytes));
      cursor += bytes;
      remaining -= bytes;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset);
    if (result.bytesWritten <= 0) {
      fail("IO_ERROR", "file write made no progress.");
    }
    offset += result.bytesWritten;
  }
}
