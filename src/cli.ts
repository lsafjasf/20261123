#!/usr/bin/env node
/**
 * CLI entry: ingest EDL/FCPXML files, normalize onto one project frame grid,
 * analyze (speed/transitions/missing media), export EDL with a loss report,
 * and emit a self-contained HTML visual comparison.
 *
 * Usage:
 *   node src/cli.ts normalize <files...> [--project-rate 25] [--rate 25]
 *       [--media-dir DIR] [--out DIR]
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parseEdl } from "./parse/edl.ts";
import { edlToIngest } from "./parse/edl-ingest.ts";
import { parseFcpxml } from "./parse/fcpxml.ts";
import type { IngestResult } from "./core/ingest.ts";
import { pickProjectRate, normalizeOne, combineTimelines } from "./core/normalize.ts";
import { rateFromNumber, RATE_2997_DF } from "./core/timecode.ts";
import type { FrameRate } from "./core/timecode.ts";
import { analyzeTimeline } from "./analyze/analyze.ts";
import { exportEdl } from "./export/edl.ts";
import type { Timeline } from "./core/model.ts";
import { buildReportHtml } from "./report.ts";

interface CliOptions {
  readonly files: string[];
  readonly projectRate: FrameRate | null;
  readonly edlRate: FrameRate | null;
  readonly mediaDir: string | null;
  readonly outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const files: string[] = [];
  let projectRate: FrameRate | null = null;
  let edlRate: FrameRate | null = null;
  let mediaDir: string | null = null;
  let outDir = "report";
  const rateOf = (s: string): FrameRate => {
    if (/df$/i.test(s)) {
      const n = Number(s.slice(0, -2));
      if (Math.abs(n - 29.97) < 0.01) return RATE_2997_DF;
      return rateFromNumber(n, true);
    }
    return rateFromNumber(Number(s));
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project-rate") projectRate = rateOf(argv[++i]);
    else if (a === "--rate") edlRate = rateOf(argv[++i]);
    else if (a === "--media-dir") mediaDir = argv[++i];
    else if (a === "--out") outDir = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else files.push(a);
  }
  return { files, projectRate, edlRate, mediaDir, outDir };
}

function ingestFile(path: string, edlRate: FrameRate | null): IngestResult {
  const text = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  if (ext === ".fcpxml" || ext === ".xml" || text.trimStart().startsWith("<")) {
    return parseFcpxml(text, basename(path));
  }
  const doc = parseEdl(text);
  // FCM DROP forces 29.97 DF; otherwise the CLI --rate (if any) applies,
  // since FCM alone cannot distinguish 23.976/25/29.97 NDF.
  return edlToIngest(doc, basename(path), doc.dropFrame ? null : edlRate);
}

function resolveMedia(timeline: Timeline, mediaDir: string | null): void {
  if (!mediaDir) return;
  let files: string[] = [];
  try {
    files = readdirSync(mediaDir);
  } catch {
    return;
  }
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.mediaPath) continue;
      const stem = (clip.name || clip.reel).toLowerCase().replace(/\.[^.]+$/, "");
      const hit = files.find((f) => f.toLowerCase().replace(/\.[^.]+$/, "") === stem);
      if (hit) clip.mediaPath = join(mediaDir, hit);
    }
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "normalize" || rest.length === 0) {
    console.error("usage: node src/cli.ts normalize <edl|fcpxml...> [--project-rate R] [--rate R] [--media-dir DIR] [--out DIR]");
    process.exit(command ? 1 : 0);
  }
  const opts = parseArgs(rest);
  const inputs = opts.files.map((f) => ingestFile(f, opts.edlRate));
  for (const input of inputs) {
    for (const w of input.warnings) console.warn(`warning [${input.sourceFile}]: ${w}`);
  }

  const projectRate = pickProjectRate(inputs, opts.projectRate);
  const timelines = inputs.map((i) => normalizeOne(i, projectRate));
  for (const tl of timelines) resolveMedia(tl, opts.mediaDir);
  const combined = combineTimelines(timelines, projectRate);

  const analyses = timelines.map((tl) => analyzeTimeline(tl));
  const exports = timelines.map((tl) => ({ name: tl.name, ...exportEdl(tl) }));

  mkdirSync(opts.outDir, { recursive: true });
  const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x), 2);
  writeFileSync(join(opts.outDir, "normalized.json"), json({ projectRate: projectRate.label, timelines, combined }));
  writeFileSync(join(opts.outDir, "analysis.json"), json(analyses));
  const allLosses = exports.flatMap((e) => e.losses.map((l) => ({ timeline: e.name, ...l })));
  writeFileSync(join(opts.outDir, "losses.json"), JSON.stringify(allLosses, null, 2));
  for (const e of exports) {
    writeFileSync(join(opts.outDir, `${e.name.replace(/[^\w.-]+/g, "_")}.edl`), e.edl);
  }
  const html = buildReportHtml({ projectRate: projectRate.label, timelines, combined, analyses, exports });
  writeFileSync(join(opts.outDir, "report.html"), html);

  console.log(`project rate: ${projectRate.label}`);
  for (const tl of timelines) {
    const clips = tl.tracks.reduce((n, t) => n + t.clips.length, 0);
    console.log(`  ${tl.name}: ${tl.tracks.length} tracks, ${clips} clips`);
  }
  for (const a of analyses) {
    console.log(
      `  analysis[${a.timeline}]: speed=${a.speed.length} transitions=${a.transitions.length} missing=${a.missingMedia.length} conforms=${a.conforms.length}`,
    );
  }
  console.log(`  losses: ${allLosses.length} entries -> ${join(opts.outDir, "losses.json")}`);
  console.log(`  visual report: ${resolve(join(opts.outDir, "report.html"))}`);
}

main();
