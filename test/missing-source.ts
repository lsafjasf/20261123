import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Buffer } from "node:buffer";
import { writeWavHeader } from "../src/cdcue/writer.ts";
import { splitImage } from "../src/cdcue/splitter.ts";
import { verifyManifest } from "../src/cdcue/verifier.ts";
import type { Manifest } from "../src/cdcue/types.ts";

test("verify degrades to output-only check when source WAV is gone", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cdcue-missing-"));
  try {
    const sr = 44100;
    const frameBytes = 4;
    const frames = sr;
    const wavPath = path.join(dir, "image.wav");
    const header = Buffer.alloc(44);
    writeWavHeader(
      header,
      {
        path: wavPath, formatCode: 1, channels: 2, sampleRate: sr, bytesPerSecond: sr * frameBytes,
        blockAlign: frameBytes, bitsPerSample: 16, dataOffset: 44, dataBytes: frames * frameBytes,
        frameCount: frames, frameBytes, rf64: false,
      },
      frames * frameBytes,
    );
    const handle = await open(wavPath, "w");
    await handle.write(header);
    await handle.write(Buffer.alloc(frames * frameBytes));
    await handle.close();
    const cuePath = path.join(dir, "image.cue");
    await writeFile(cuePath, 'FILE "image.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:10\n');
    const outDir = path.join(dir, "out");
    const manifest = await splitImage({ cuePath, outDir, offsetSamples: 0, force: true });

    await rename(wavPath, path.join(dir, "moved.wav"));
    const reloaded = JSON.parse(await readFile(path.join(outDir, "cdcue-manifest.json"), "utf8")) as Manifest;
    const result = await verifyManifest(path.join(outDir, "cdcue-manifest.json"), reloaded);
    assert.equal(result.exact, true);
    assert.equal(result.sourceHash, manifest.source.dataSha256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
