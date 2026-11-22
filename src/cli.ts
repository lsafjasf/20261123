// 命令行：gen（构造测试素材）/ align（核查时间线）/ repair（确认后修复）。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { generate, weddingScenario } from "./gen.ts";
import { loadManifest, type Manifest } from "./model.ts";
import { buildTimeline, formatTimeline } from "./timeline.ts";
import { repair, rowsToCsv } from "./repair.ts";

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function readManifest(path: string): { manifest: Manifest; dir: string } {
  const manifest = loadManifest(readFileSync(path, "utf8"));
  return { manifest, dir: dirname(path) };
}

function cmdGen(args: string[]): void {
  const out = argValue(args, "out") ?? "demo";
  generate(weddingScenario(), out);
  console.log(`测试素材已生成到 ${out}/（含 manifest.json 与四机位片段）`);
}

function cmdAlign(args: string[]): void {
  const manifestPath = argValue(args, "manifest") ?? "demo/manifest.json";
  const { manifest, dir } = readManifest(manifestPath);
  const tl = buildTimeline(manifest, (p) => readFileSync(join(dir, p)));
  console.log(formatTimeline(tl));
  const jsonPath = argValue(args, "json");
  if (jsonPath) {
    writeFileSync(
      jsonPath,
      JSON.stringify(tl, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2),
    );
    console.log(`机读结果已写入 ${jsonPath}`);
  }
  console.log("\n确认无误后执行：node src/cli.ts repair --manifest " +
    `${manifestPath} --out <输出目录> --yes`);
}

function cmdRepair(args: string[]): void {
  const manifestPath = argValue(args, "manifest") ?? "demo/manifest.json";
  const out = argValue(args, "out") ?? "repaired";
  const yes = args.includes("--yes");
  const { manifest, dir } = readManifest(manifestPath);
  const result = repair(manifest, (p) => readFileSync(join(dir, p)));

  console.log("修复计划（每段一行）：");
  for (const s of result.summaries) {
    console.log(
      `  ${s.outFile}  <= ${s.sourceClip}  视频=${s.videoSamples} 音频=${s.audioSamples}` +
        ` 裁头=${s.trimmedHeadSamples} 非单调修复=${s.nonMonotonicFixed}` +
        ` 漂移修正=${s.driftRemovedTicks}tick 锚点舍入=${s.anchorRoundingError}`,
    );
  }
  if (!yes) {
    console.log("\n未执行。加 --yes 确认生成。");
    return;
  }
  for (const o of result.outputs) {
    const p = join(out, o.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, o.bytes);
  }
  writeFileSync(join(out, "report.csv"), rowsToCsv(result.rows));
  writeFileSync(
    join(out, "report.json"),
    JSON.stringify(
      { summaries: result.summaries, rows: result.rows },
      null,
      2,
    ),
  );
  console.log(
    `\n已生成 ${result.outputs.length} 个分片到 ${out}/，` +
      `对照表 report.csv（${result.rows.length} 行）与 report.json`,
  );
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case "gen":
    cmdGen(rest);
    break;
  case "align":
    cmdAlign(rest);
    break;
  case "repair":
    cmdRepair(rest);
    break;
  default:
    console.log(
      "用法：\n" +
        "  node src/cli.ts gen --out demo\n" +
        "  node src/cli.ts align --manifest demo/manifest.json [--json out.json]\n" +
        "  node src/cli.ts repair --manifest demo/manifest.json --out repaired [--yes]",
    );
    process.exitCode = cmd ? 1 : 0;
}
