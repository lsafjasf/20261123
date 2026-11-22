/**
 * frame-safe CLI — offline archival scan restoration.
 *
 *   node src/node/cli.ts --in frames/ --out out/ --name RIVER_ASH_R2_04 \
 *     [--fps 24] [--strength 0.78] [--grain 0.96] \
 *     [--disable 12,40-45] [--manual-dir manual/]
 *
 * Input:  directory of PNG frames (sorted by filename).
 * Output: <out>/sequence/ repaired PNGs, <out>/masks/ repair masks,
 *         <out>/mask-manifest.json, <out>/manual-frames/, <out>/README.txt
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { decodePng, encodePng } from "./png.ts";
import { runPipeline } from "../core/pipeline.ts";
import type { Frame, Manifest } from "../core/types.ts";

interface Args {
  inDir: string; outDir: string; name: string;
  fps: number; strength: number; grain: number;
  disable: Set<number>; manualDir: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | null => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : null;
  };
  const inDir = get("in"), outDir = get("out");
  if (!inDir || !outDir) {
    console.error("usage: node src/node/cli.ts --in DIR --out DIR [--name N] [--fps 24] [--strength 0.78] [--grain 0.96] [--disable 1,4-7] [--manual-dir DIR]");
    process.exit(2);
  }
  const disable = new Set<number>();
  const spec = get("disable");
  if (spec) {
    for (const part of spec.split(",")) {
      const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
      if (!m) continue;
      const a = Number(m[1]), b = Number(m[2] ?? m[1]);
      for (let f = a; f <= b; f++) disable.add(f);
    }
  }
  return {
    inDir, outDir,
    name: get("name") ?? basename(inDir),
    fps: Number(get("fps") ?? 24),
    strength: Number(get("strength") ?? 0.78),
    grain: Number(get("grain") ?? 0.96),
    disable,
    manualDir: get("manual-dir"),
  };
}

function frameNumber(name: string): number | null {
  const m = name.match(/(\d+)(?=\.png$)/i);
  return m ? Number(m[1]) : null;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const files = readdirSync(args.inDir)
    .filter((f) => f.toLowerCase().endsWith(".png"))
    .sort();
  if (!files.length) {
    console.error(`no PNG frames in ${args.inDir}`);
    process.exit(1);
  }
  const frames: Frame[] = files.map((f, i) => {
    const img = decodePng(readFileSync(join(args.inDir, f)));
    return { index: frameNumber(f) ?? i, width: img.width, height: img.height, rgba: img.rgba };
  });
  console.log(`loaded ${frames.length} frames ${frames[0].width}x${frames[0].height}`);

  const { frames: repaired, manifest, masks } = runPipeline(frames, args.name, {
    fps: args.fps,
    repairStrength: args.strength,
    grainPreservation: args.grain,
    disabledFrames: args.disable,
  });

  // Human-edited frames override pipeline output and are logged.
  const manualLog: { frame: number; file: string }[] = [];
  if (args.manualDir) {
    for (const f of readdirSync(args.manualDir).sort()) {
      if (!f.toLowerCase().endsWith(".png")) continue;
      const num = frameNumber(f);
      const slot = repaired.findIndex((fr) => fr.index === num);
      if (num === null || slot < 0) continue;
      const img = decodePng(readFileSync(join(args.manualDir, f)));
      repaired[slot] = { index: num, width: img.width, height: img.height, rgba: img.rgba };
      manifest.frames[slot].manualEdit = true;
      manifest.manualFrames.push(num);
      manualLog.push({ frame: num, file: f });
    }
    manifest.summary.manualEdits = manualLog.length;
  }

  const seqDir = join(args.outDir, "sequence");
  const maskDir = join(args.outDir, "masks");
  const manDir = join(args.outDir, "manual-frames");
  mkdirSync(seqDir, { recursive: true });
  mkdirSync(maskDir, { recursive: true });
  const first = repaired[0].index, last = repaired[repaired.length - 1].index;
  const pad = (v: number): string => String(v).padStart(4, "0");
  for (const fr of repaired) {
    const png = encodePng({ width: fr.width, height: fr.height, rgba: fr.rgba });
    writeFileSync(join(seqDir, `${args.name}_repaired_F${pad(fr.index)}.png`), png);
  }
  for (const [idx, mask] of masks) {
    const rgba = new Uint8ClampedArray(mask.length * 4);
    for (let i = 0; i < mask.length; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = mask[i] * 255;
      rgba[i * 4 + 3] = 255;
    }
    writeFileSync(join(maskDir, `F${pad(idx)}_mask.png`),
      encodePng({ width: repaired[0].width, height: repaired[0].height, rgba }));
  }
  if (manualLog.length) {
    mkdirSync(manDir, { recursive: true });
    for (const m of manualLog) {
      const fr = repaired.find((f) => f.index === m.frame);
      if (!fr) continue;
      writeFileSync(join(manDir, `F${pad(m.frame)}_manual.png`),
        encodePng({ width: fr.width, height: fr.height, rgba: fr.rgba }));
    }
    writeFileSync(join(manDir, "edit-log.json"), JSON.stringify(manualLog, null, 2));
  }
  writeFileSync(join(args.outDir, "mask-manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(args.outDir, "README.txt"), deliveryNote(args, manifest, first, last));
  console.log(`repaired masks: ${manifest.summary.repairedMasks}, ` +
    `locked: ${manifest.summary.lockedMasks}, ` +
    `motion-skipped: ${manifest.summary.skippedMotion}, ` +
    `disabled: ${manifest.summary.disabledFrames}, ` +
    `manual: ${manifest.summary.manualEdits}`);
  console.log(`written to ${args.outDir}`);
}

function deliveryNote(
  args: Args, m: Manifest, first: number, last: number,
): string {
  const tc = (f: number): string => {
    const r = m.frames.find((x) => x.frame === f);
    return r ? r.timecode : "?";
  };
  return [
    `FRAME/SAFE · ${args.name} · DELIVERY`,
    ``,
    `Generated: ${m.generated}`,
    `Source: ${args.name} / ${m.source.width}x${m.source.height} / ${m.source.fps} fps / ${m.source.frameCount} frames`,
    `Temporal repair segment: F ${String(first).padStart(4, "0")}—${String(last).padStart(4, "0")} (${tc(first)}—${tc(last)})`,
    `Human-edited frames: ${m.summary.manualEdits}`,
    `Repair strength: ${Math.round(m.options.repairStrength * 100)}%`,
    `Grain preservation: ${Math.round(m.options.grainPreservation * 100)}%`,
    ``,
    `Contents`,
    `- sequence/ : repaired frame sequence`,
    `- masks/ : per-frame repair masks (white = repaired pixels)`,
    `- mask-manifest.json : every frame, mask, confidence and temporal decision`,
    `- manual-frames/ : human-edited frames and edit log`,
    ``,
    `Uncertain vertical lines are locked as picture content and never entered the repair set.`,
    `No whole-frame denoise or blur is applied. Grain is redistributed only inside repaired masks.`,
    ``,
  ].join("\n");
}

main();
