import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { decodeWav, encodeWavPcm16 } from "../shared/wav.ts";
import { analyzeTracks } from "../shared/analyze.ts";
import { renderCorrected } from "../shared/render.ts";
import { buildKeyframeCsv, buildProjectJson, buildSegmentCsv, buildSyncTableCsv, buildLabels } from "../shared/export.ts";
import { DEFAULT_PARAMS } from "../shared/types.ts";
import { fixtureWavBuffers, DEFAULT_SPEC } from "./fixtures.ts";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "fixtures") return writeFixtures(args[0] ?? ".");
  if (command === "analyze") return analyze(args);
  console.log("Usage: cli.ts analyze camera.wav recorder.wav [out-dir] | fixtures [out-dir]");
  process.exit(command ? 1 : 0);
}

async function analyze(args: string[]): Promise<void> {
  const [cameraPath, recorderPath, outDir = "."] = args;
  if (!cameraPath || !recorderPath) throw new Error("analyze requires camera.wav and recorder.wav");
  const [cameraBuffer, recorderBuffer] = await Promise.all([readFile(cameraPath), readFile(recorderPath)]);
  const camera = decodeWav(cameraBuffer.buffer.slice(cameraBuffer.byteOffset, cameraBuffer.byteOffset + cameraBuffer.byteLength), basename(cameraPath));
  const recorder = decodeWav(recorderBuffer.buffer.slice(recorderBuffer.byteOffset, recorderBuffer.byteOffset + recorderBuffer.byteLength), basename(recorderPath));
  const result = analyzeTracks(camera, recorder, { ...DEFAULT_PARAMS });
  const aligned = renderCorrected(recorder, result);
  await mkdir(outDir, { recursive: true });
  const outputs: Array<[string, string | ArrayBuffer]> = [
    ["sync-windows.csv", buildSyncTableCsv(result)],
    ["sync-keyframes.csv", buildKeyframeCsv(result)],
    ["sync-segments.csv", buildSegmentCsv(result)],
    ["sync-project.json", buildProjectJson(result, camera.name, recorder.name)],
    ["sync-labels.txt", buildLabels(result)],
    ["recorder-aligned.wav", encodeWavPcm16(aligned)],
  ];
  for (const [name, content] of outputs) {
    const target = resolve(outDir, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content instanceof ArrayBuffer ? Buffer.from(content) : content);
  }
  console.log(`anchors=${result.anchors.length} segments=${result.segments.length} -> ${resolve(outDir)}`);
}

async function writeFixtures(outDir: string): Promise<void> {
  const buffers = fixtureWavBuffers(DEFAULT_SPEC);
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, "camera.wav"), Buffer.from(buffers.camera));
  await writeFile(resolve(outDir, "recorder.wav"), Buffer.from(buffers.recorder));
  console.log(`fixtures written to ${resolve(outDir)}`);
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
