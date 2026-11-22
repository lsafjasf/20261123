import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";
import { writeWavHeader } from "../src/cdcue/writer.ts";

const run = promisify(execFile);
const cliPath = path.join(import.meta.dirname, "..", "src", "cdcue", "cli.ts");

test("CLI split + verify round trip and tamper detection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cdcue-e2e-"));
  try {
    const sr = 44100;
    const frameBytes = 4;
    const frames = sr * 6;
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
    await handle.write(Buffer.alloc(frames * frameBytes, 0x5a));
    await handle.close();

    const cuePath = path.join(dir, "image.cue");
    await writeFile(
      cuePath,
      ['FILE "image.wav" WAVE', "  TRACK 01 AUDIO", "    INDEX 01 00:01:00", "  TRACK 02 AUDIO", "    INDEX 00 00:03:00", "    INDEX 01 00:04:00", ""].join("\n"),
    );

    const split = await run(process.execPath, [cliPath, "split", "--cue", cuePath, "--out", path.join(dir, "out"), "--force"]);
    assert.match(split.stdout, /byte-exact|matches source/);

    const verify = await run(process.execPath, [cliPath, "verify", "--manifest", path.join(dir, "out", "cdcue-manifest.json")]);
    assert.match(verify.stdout, /byte-exact=true/);

    const trackOne = path.join(dir, "out", "01.wav");
    const tampered = await open(trackOne, "r+");
    await tampered.write(Buffer.from([0x01]), 0, 1, 100);
    await tampered.close();
    const verifyError = await run(process.execPath, [cliPath, "verify", "--manifest", path.join(dir, "out", "cdcue-manifest.json")]).then(
      () => null,
      (error: unknown) => error as { stderr: string; code: number },
    );
    assert.ok(verifyError, "tampered verify must reject");
    assert.equal(verifyError.code, 1);
    assert.match(verifyError.stderr, /SHA-256/);

    const badCue = path.join(dir, "bad.cue");
    await writeFile(badCue, 'FILE "image.wav" WAVE\n  TRACK 01 AUDIO\n    POSTGAP 00:01:00\n    INDEX 01 00:02:00\n');
    const cueError = await run(process.execPath, [cliPath, "inspect", "--cue", badCue]).then(
      () => null,
      (error: unknown) => error as { stderr: string; code: number },
    );
    assert.ok(cueError, "bad cue must reject");
    assert.match(cueError.stderr, /CUE_UNSUPPORTED/);

    const manifest = JSON.parse(await readFile(path.join(dir, "out", "cdcue-manifest.json"), "utf8"));
    assert.equal(manifest.source.totalSamples, frames);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
