import path from "node:path";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { Manifest } from "./types.ts";
import { hashDataRange } from "./writer.ts";
import { readWavInfo } from "./wav.ts";
import { fail } from "./errors.ts";

export interface VerifyResult {
  outputsChecked: number;
  reconstructedBytes: number;
  sourceHash: string;
  reconstructedHash: string;
  exact: boolean;
}

export async function verifyManifest(manifestPath: string, manifest: Manifest): Promise<VerifyResult> {
  const baseDir = path.dirname(manifestPath);
  const concatHash = createHash("sha256");
  let reconstructedBytes = 0;

  for (const record of manifest.outputs) {
    const outputPath = path.join(baseDir, record.file);
    const info = await readWavInfo(outputPath);
    assertFormatMatches(manifest, info, record.file);
    if (info.frameCount !== record.frameCount) {
      fail(
        "WAV_PARSE",
        `${record.file}: manifest expects ${record.frameCount} frames but WAV contains ${info.frameCount}.`,
      );
    }
    if (info.dataBytes !== record.byteLength) {
      fail("WAV_PARSE", `${record.file}: data size ${info.dataBytes} != manifest ${record.byteLength}.`);
    }
    const actualHash = await hashDataRange(outputPath, info.dataOffset, info.dataBytes);
    if (actualHash !== record.sha256) {
      fail("WAV_TRUNCATED", `${record.file}: SHA-256 ${actualHash} != manifest ${record.sha256}.`);
    }
    await appendDataBytes(outputPath, info.dataOffset, info.dataBytes, concatHash);
    reconstructedBytes += info.dataBytes;
  }

  const reconstructedHash = concatHash.digest("hex");
  if (reconstructedBytes !== manifest.source.totalSamples * manifest.source.frameBytes) {
    fail(
      "LENGTH_INSUFFICIENT",
      `reconstructed ${reconstructedBytes} bytes != source ${manifest.source.totalSamples * manifest.source.frameBytes} bytes.`,
    );
  }
  if (reconstructedHash !== manifest.reconstructed.sha256) {
    fail("LENGTH_INSUFFICIENT", "recomputed reconstruction hash differs from manifest; outputs changed after splitting.");
  }

  let sourceHash = manifest.source.dataSha256;
  try {
    const source = await readWavInfo(manifest.source.file);
    sourceHash = await hashDataRange(manifest.source.file, source.dataOffset, source.dataBytes);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return {
        outputsChecked: manifest.outputs.length,
        reconstructedBytes,
        sourceHash: manifest.source.dataSha256,
        reconstructedHash,
        exact: reconstructedHash === manifest.source.dataSha256,
      };
    }
    throw error;
  }

  const exact = reconstructedHash === sourceHash;
  if (!exact) {
    fail("LENGTH_INSUFFICIENT", `reconstruction hash ${reconstructedHash} != current source hash ${sourceHash}.`);
  }
  return { outputsChecked: manifest.outputs.length, reconstructedBytes, sourceHash, reconstructedHash, exact };
}

async function appendDataBytes(path: string, offset: number, bytes: number, hash: ReturnType<typeof createHash>): Promise<void> {
  const handle = await open(path, "r");
  try {
    const scratch = Buffer.alloc(1024 * 1024);
    let remaining = bytes;
    let cursor = offset;
    while (remaining > 0) {
      const length = Math.min(remaining, scratch.length);
      const result = await handle.read(scratch, 0, length, cursor);
      if (result.bytesRead !== length) {
        fail("WAV_TRUNCATED", `${path}: short read while reconstructing at byte ${cursor}.`);
      }
      hash.update(scratch.subarray(0, length));
      cursor += length;
      remaining -= length;
    }
  } finally {
    await handle.close();
  }
}

function assertFormatMatches(manifest: Manifest, info: Awaited<ReturnType<typeof readWavInfo>>, file: string): void {
  if (
    info.sampleRate !== manifest.source.sampleRate ||
    info.channels !== manifest.source.channels ||
    info.bitsPerSample !== manifest.source.bitsPerSample ||
    info.frameBytes !== manifest.source.frameBytes
  ) {
    fail("WAV_PARSE", `${file}: PCM format does not match manifest source format.`);
  }
}
