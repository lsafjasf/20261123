#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { CdcueError } from "./errors.ts";
import { parseCueSheet, frameToMsf } from "./cue.ts";
import { readWavInfo } from "./wav.ts";
import { buildPlan } from "./planner.ts";
import { splitImage } from "./splitter.ts";
import { verifyManifest } from "./verifier.ts";
import type { Manifest } from "./types.ts";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return command ? 0 : 2;
  }

  switch (command) {
    case "split":
      return runSplit(rest);
    case "verify":
      return runVerify(rest);
    case "inspect":
      return runInspect(rest);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      printUsage();
      return 2;
  }
}

async function runSplit(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cue: { type: "string" },
      out: { type: "string" },
      offset: { type: "string", default: "0" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help || !values.cue) {
    printSplitUsage();
    return values.help ? 0 : 2;
  }
  const cuePathForSplit = path.resolve(values.cue);
  const preCue = parseCueSheet(await readFile(cuePathForSplit, "utf8"), cuePathForSplit);
  const preWav = await readWavInfo(path.resolve(path.dirname(cuePathForSplit), preCue.filePath));
  const offsetSamples = resolveOffset(values.offset ?? "0", preWav.sampleRate);
  const manifest = await splitImage({
    cuePath: cuePathForSplit,
    outDir: path.resolve(values.out ?? "./cdcue-out"),
    offsetSamples,
    force: values.force ?? false,
  });
  process.stdout.write(`Wrote ${manifest.outputs.length} WAV files to ${path.resolve(values.out ?? "./cdcue-out")}\n`);
  for (const output of manifest.outputs) {
    process.stdout.write(
      `  ${output.file.padEnd(20)} ${String(output.frameCount).padStart(10)} frames  sha256=${output.sha256.slice(0, 16)}…\n`,
    );
  }
  process.stdout.write(`Reconstruction hash matches source: ${manifest.reconstructed.sha256 === manifest.source.dataSha256}\n`);
  return 0;
}

async function runVerify(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      manifest: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help || !values.manifest) {
    process.stdout.write("Usage: cdcue verify --manifest <path/cdcue-manifest.json>\n");
    return values.help ? 0 : 2;
  }
  const manifestPath = path.resolve(values.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  const result = await verifyManifest(manifestPath, manifest);
  process.stdout.write(
    `Checked ${result.outputsChecked} files, ${result.reconstructedBytes} PCM bytes, byte-exact=${result.exact}\n`,
  );
  process.stdout.write(`sha256=${result.reconstructedHash}\n`);
  return result.exact ? 0 : 1;
}

async function runInspect(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cue: { type: "string" },
      offset: { type: "string", default: "0" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help || !values.cue) {
    process.stdout.write("Usage: cdcue inspect --cue <sheet.cue> [--offset <samples|+Nf|Nmsf>]\n");
    return values.help ? 0 : 2;
  }
  const cuePath = path.resolve(values.cue);
  const cue = parseCueSheet(await readFile(cuePath, "utf8"), cuePath);
  const wavPath = path.resolve(path.dirname(cuePath), cue.filePath);
  const wav = await readWavInfo(wavPath);
  const offsetSamples = resolveOffset(values.offset ?? "0", wav.sampleRate);
  const plan = buildPlan(cue, wav, offsetSamples);
  process.stdout.write(`Source: ${wavPath}\n`);
  process.stdout.write(`${wav.channels}ch ${wav.bitsPerSample}bit ${wav.sampleRate}Hz, ${wav.frameCount} frames, rf64=${wav.rf64}\n`);
  for (const region of plan.regions) {
    process.stdout.write(
      `${region.id.padEnd(16)} [${region.startSample}, ${region.endSample}) ${region.frameCount} frames\n`,
    );
    for (const marker of region.markers) {
      process.stdout.write(`                 ${describe(marker)}\n`);
    }
  }
  return 0;
}

function resolveOffset(token: string, sampleRate: number): number {
  if (!/^[+-]?\d+(?:\.\d+)?(?:f|msf)?$/.test(token)) {
    throw new CdcueError("OFFSET_INVALID", `offset "${token}" must be integer samples, e.g. -120, +588f, or 100msf.`);
  }
  if (token.endsWith("f") || token.endsWith("msf")) {
    const suffixLength = token.endsWith("msf") ? 3 : 1;
    const frames = Number(token.slice(0, -suffixLength));
    if (!Number.isInteger(frames)) {
      throw new CdcueError("OFFSET_INVALID", `CD-frame offset must be an integer: "${token}".`);
    }
    const numerator = frames * sampleRate;
    if (numerator % 75 !== 0) {
      throw new CdcueError("OFFSET_INVALID", `offset ${frames} CD frames is not a whole sample count at ${sampleRate} Hz.`);
    }
    return numerator / 75;
  }
  const samples = Number(token);
  if (!Number.isInteger(samples)) {
    throw new CdcueError("OFFSET_INVALID", `sample offset must be an integer: "${token}".`);
  }
  return samples;
}

function describe(marker: { kind: string; trackNumber?: number; indexNumber?: number; msf?: string; sample: number; originalSample: number }): string {
  if (marker.kind === "hidden-start") return `hidden-start sample=${marker.sample}`;
  if (marker.kind === "source-end") return `source-end sample=${marker.sample}`;
  return `INDEX ${String(marker.indexNumber).padStart(2, "0")} ${marker.msf ?? frameToMsf(0)} -> sample ${marker.sample} (was ${marker.originalSample})`;
}

function printUsage(): void {
  process.stdout.write(
    [
      "cdcue — byte-exact CUE/WAV splitter",
      "",
      "Commands:",
      "  split    --cue <sheet.cue> [--out <dir>] [--offset <n>] [--force]",
      "  verify   --manifest <dir/cdcue-manifest.json>",
      "  inspect  --cue <sheet.cue> [--offset <n>]",
      "",
      "Offset formats: integer samples (-120), CD frames (+588f or +100msf where 1 frame = 588 samples at 44.1kHz).",
      "",
    ].join("\n"),
  );
}

function printSplitUsage(): void {
  process.stdout.write(
    "Usage: cdcue split --cue <sheet.cue> [--out <dir>] [--offset <samples|Nf>] [--force]\n",
  );
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof CdcueError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    if (error instanceof TypeError && error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      process.stderr.write(`[OFFSET_INVALID] ${error.message} Use --offset=-123 (equals form) for negative values.\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`[IO_ERROR] ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  },
);
