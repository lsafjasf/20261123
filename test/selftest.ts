import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Buffer } from "node:buffer";
import { CdcueError } from "../src/cdcue/errors.ts";
import { writeWavHeader } from "../src/cdcue/writer.ts";
import { splitImage } from "../src/cdcue/splitter.ts";
import { verifyManifest } from "../src/cdcue/verifier.ts";
import { parseCueSheet } from "../src/cdcue/cue.ts";
import { buildPlan } from "../src/cdcue/planner.ts";
import { readWavInfo } from "../src/cdcue/wav.ts";
import type { Manifest } from "../src/cdcue/types.ts";

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BITS = 16;
const FRAME_BYTES = 4;

interface Fixture {
  root: string;
  wavPath: string;
  cuePath: string;
  totalFrames: number;
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cdcue-"));
}

async function createWav(filePath: string, frameCount: number, patternBase = 0): Promise<void> {
  const dataBytes = frameCount * FRAME_BYTES;
  const handle = await open(filePath, "w");
  try {
    const header = Buffer.alloc(44);
    writeWavHeader(
      header,
      {
        path: filePath,
        formatCode: 1,
        channels: CHANNELS,
        sampleRate: SAMPLE_RATE,
        bytesPerSecond: SAMPLE_RATE * FRAME_BYTES,
        blockAlign: FRAME_BYTES,
        bitsPerSample: BITS,
        dataOffset: 44,
        dataBytes,
        frameCount,
        frameBytes: FRAME_BYTES,
        rf64: false,
      },
      dataBytes,
    );
    await handle.write(header);
    const chunkFrames = 8192;
    let frame = 0;
    while (frame < frameCount) {
      const count = Math.min(chunkFrames, frameCount - frame);
      const buffer = Buffer.alloc(count * FRAME_BYTES);
      for (let index = 0; index < count; index += 1) {
        const absolute = patternBase + frame + index;
        buffer.writeInt16LE((absolute * 7) % 32767, index * 4);
        buffer.writeInt16LE((absolute * 13) % 32767, index * 4 + 2);
      }
      await handle.write(buffer);
      frame += count;
    }
  } finally {
    await handle.close();
  }
}

async function createFixture(cueBody: string, totalFrames: number): Promise<Fixture> {
  const root = await makeTempDir();
  const wavPath = path.join(root, "image.wav");
  const cuePath = path.join(root, "image.cue");
  await createWav(wavPath, totalFrames);
  await writeFile(cuePath, `FILE "image.wav" WAVE\n${cueBody}`);
  return { root, wavPath, cuePath, totalFrames };
}

async function assertRejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CdcueError, `expected CdcueError, got ${String(error)}`);
    assert.equal((error as CdcueError).code, code);
    return true;
  });
}

test("splits tracks, preserves pregap/index 00 and hidden lead-in, then reconstructs exactly", async () => {
  const fixture = await createFixture(
    [
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:02:00",
      "  TRACK 02 AUDIO",
      "    INDEX 00 00:04:00",
      "    INDEX 01 00:05:00",
      "  TRACK 03 AUDIO",
      "    INDEX 00 00:08:00",
      "    INDEX 01 00:08:30",
      "    INDEX 02 00:09:00",
    ].join("\n"),
    SAMPLE_RATE * 12,
  );

  try {
    const outDir = path.join(fixture.root, "out");
    const manifest = await splitImage({ cuePath: fixture.cuePath, outDir, offsetSamples: 0, force: true });
    assert.equal(manifest.outputs.length, 4);
    assert.equal(manifest.outputs[0]!.kind, "hidden");
    assert.equal(manifest.outputs[0]!.frameCount, SAMPLE_RATE * 2);
    assert.equal(manifest.outputs[1]!.frameCount, SAMPLE_RATE * 2);
    assert.equal(manifest.outputs[2]!.frameCount, SAMPLE_RATE * 4);
    assert.equal(manifest.outputs[3]!.frameCount, SAMPLE_RATE * 4);

    const sourcePcm = (await readFile(fixture.wavPath)).subarray(44);
    const rebuilt = await concatOutputs(outDir, manifest);
    assert.ok(rebuilt.equals(sourcePcm), "reconstructed PCM must equal source byte-for-byte");

    const verifyResult = await verifyManifest(path.join(outDir, "cdcue-manifest.json"), manifest);
    assert.equal(verifyResult.exact, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("applies sample offset while keeping full reconstruction byte-exact", async () => {
  const fixture = await createFixture(
    [
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:02:00",
      "  TRACK 02 AUDIO",
      "    INDEX 00 00:03:00",
      "    INDEX 01 00:04:00",
    ].join("\n"),
    SAMPLE_RATE * 8,
  );

  try {
    const outDir = path.join(fixture.root, "out");
    const manifest = await splitImage({ cuePath: fixture.cuePath, outDir, offsetSamples: -588, force: true });
    assert.equal(manifest.offset.samples, -588);
    const sourcePcm = (await readFile(fixture.wavPath)).subarray(44);
    const rebuilt = await concatOutputs(outDir, manifest);
    assert.ok(rebuilt.equals(sourcePcm));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("errors clearly when an index points past the end of the WAV", async () => {
  const fixture = await createFixture(
    ["  TRACK 01 AUDIO", "    INDEX 01 00:01:00"].join("\n"),
    Math.floor(SAMPLE_RATE / 2),
  );
  try {
    await assertRejectsCode(
      splitImage({ cuePath: fixture.cuePath, outDir: path.join(fixture.root, "x"), offsetSamples: 0, force: true }),
      "LENGTH_INSUFFICIENT",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("errors when offset pushes a boundary beyond available samples", async () => {
  const fixture = await createFixture(
    [
      "  TRACK 01 AUDIO",
      "      INDEX 01 00:00:30",
      "  TRACK 02 AUDIO",
      "      INDEX 01 00:01:00",
    ].join("\n"),
    SAMPLE_RATE * 2,
  );
  try {
    await assertRejectsCode(
      splitImage({ cuePath: fixture.cuePath, outDir: path.join(fixture.root, "x"), offsetSamples: SAMPLE_RATE * 3, force: true }),
      "LENGTH_INSUFFICIENT",
    );
    await assertRejectsCode(
      splitImage({ cuePath: fixture.cuePath, outDir: path.join(fixture.root, "y"), offsetSamples: -SAMPLE_RATE, force: true }),
      "OFFSET_INVALID",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects malformed and unsupported CUE constructs", async () => {
  const root = await makeTempDir();
  try {
    await writeFile(path.join(root, "pregap.cue"), 'FILE "a.wav" WAVE\n  TRACK 01 AUDIO\n    PREGAP 00:02:00\n    INDEX 01 00:03:00\n');
    await assertRejectsCode(
      Promise.resolve().then(() => parseCueSheet('FILE "a.wav" WAVE\n  TRACK 01 AUDIO\n    PREGAP 00:02:00\n    INDEX 01 00:03:00\n', "pregap.cue")),
      "CUE_UNSUPPORTED",
    );

    await assertRejectsCode(
      Promise.resolve().then(() => parseCueSheet('FILE "a.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 02 00:01:00\n', "bad.cue")),
      "CUE_INDEX_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects truncated WAV data chunks", async () => {
  const root = await makeTempDir();
  const wavPath = path.join(root, "truncated.wav");
  await createWav(wavPath, 10);
  const handle = await open(wavPath, "r+");
  try {
    await handle.truncate(44 + 12);
  } finally {
    await handle.close();
  }
  try {
    await assertRejectsCode(readWavInfo(wavPath), "WAV_TRUNCATED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planner covers every sample exactly once, including a true hidden lead-in", async () => {
  const fixture = await createFixture(
    ["  TRACK 01 AUDIO", "    INDEX 01 00:03:00"].join("\n"),
    SAMPLE_RATE * 5,
  );
  try {
    const cue = parseCueSheet(await readFile(fixture.cuePath, "utf8"), fixture.cuePath);
    const wav = await readWavInfo(fixture.wavPath);
    const plan = buildPlan(cue, wav, 0);
    assert.equal(plan.regions[0]!.kind, "hidden");
    assert.equal(plan.regions[0]!.frameCount, SAMPLE_RATE * 3);
    assert.equal(plan.regions.reduce((sum, region) => sum + region.frameCount, 0), fixture.totalFrames);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects sample rates where CD frames do not align to whole samples", async () => {
  const root = await makeTempDir();
  try {
    const wavPath = path.join(root, "odd.wav");
    const frameBytes = 4;
    const frames = 44101;
    const handle = await open(wavPath, "w");
    const header = Buffer.alloc(44);
    writeWavHeader(
      header,
      {
        path: wavPath, formatCode: 1, channels: 2, sampleRate: 44101, bytesPerSecond: 44101 * frameBytes,
        blockAlign: frameBytes, bitsPerSample: 16, dataOffset: 44, dataBytes: frames * frameBytes,
        frameCount: frames, frameBytes, rf64: false,
      },
      frames * frameBytes,
    );
    await handle.write(header);
    await handle.write(Buffer.alloc(frames * frameBytes));
    await handle.close();
    await writeFile(path.join(root, "odd.cue"), 'FILE "odd.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:01\n');
    await assertRejectsCode(
      splitImage({ cuePath: path.join(root, "odd.cue"), outDir: path.join(root, "out"), offsetSamples: 0, force: true }),
      "CUE_INDEX_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("24-bit mono with negative offset still reconstructs byte-for-byte", async () => {
  const root = await makeTempDir();
  try {
    const channels = 1;
    const bits = 24;
    const frameBytes = 3;
    const frames = SAMPLE_RATE * 4;
    const wavPath = path.join(root, "mono24.wav");
    const handle = await open(wavPath, "w");
    const header = Buffer.alloc(44);
    writeWavHeader(
      header,
      {
        path: wavPath, formatCode: 1, channels, sampleRate: SAMPLE_RATE,
        bytesPerSecond: SAMPLE_RATE * frameBytes, blockAlign: frameBytes, bitsPerSample: bits,
        dataOffset: 44, dataBytes: frames * frameBytes, frameCount: frames, frameBytes, rf64: false,
      },
      frames * frameBytes,
    );
    await handle.write(header);
    const pcm = Buffer.alloc(frames * frameBytes);
    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] = (index * 31 + 7) & 0xff;
    }
    await handle.write(pcm);
    await handle.close();

    await writeFile(
      path.join(root, "mono24.cue"),
      ['FILE "mono24.wav" WAVE', "  TRACK 01 AUDIO", "    INDEX 01 00:02:00", "  TRACK 02 AUDIO", "    INDEX 01 00:03:00", ""].join("\n"),
    );
    const outDir = path.join(root, "out");
    const manifest = await splitImage({
      cuePath: path.join(root, "mono24.cue"),
      outDir,
      offsetSamples: -100,
      force: true,
    });
    const rebuilt = await concatOutputs(outDir, manifest);
    assert.ok(rebuilt.equals(pcm), "24-bit mono PCM must reconstruct exactly under negative offset");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function concatOutputs(outDir: string, manifest: Manifest): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const record of manifest.outputs) {
    const info = await readWavInfo(path.join(outDir, record.file));
    parts.push((await readFile(path.join(outDir, record.file))).subarray(info.dataOffset, info.dataOffset + info.dataBytes));
  }
  return Buffer.concat(parts);
}
