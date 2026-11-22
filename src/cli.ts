/**
 * Command-line interface.
 *
 *   node src/cli.ts migrate <legacy.json> [--out dir] [--exact]
 *                           [--tolerance-ms N] [--no-incremental]
 *   node src/cli.ts verify  <legacy.json> [--out dir]
 *   node src/cli.ts rollback [--out dir] [--run-id id]
 *   node src/cli.ts status  [--out dir]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LegacyProject } from "./legacy/schema.ts";
import type { ProjectV2 } from "./model/schema.ts";
import type { MigrationReport } from "./migrate/report.ts";
import { migrateProject } from "./migrate/engine.ts";
import { verifyMigration } from "./migrate/verify.ts";
import {
  loadState,
  saveState,
  stateDirFor,
  emptyState,
} from "./migrate/state.ts";
import {
  backupOutputs,
  rollback,
  listBackups,
  writeJsonAtomic,
  OUTPUT_PROJECT,
  OUTPUT_REPORT,
} from "./migrate/rollback.ts";

interface Args {
  command: string;
  positional: string[];
  out: string;
  exact: boolean;
  toleranceMs?: number;
  incremental: boolean;
  runId?: string;
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const args: Args = {
    command,
    positional: [],
    out: "out",
    exact: false,
    incremental: true,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") args.out = rest[++i];
    else if (a === "--exact") args.exact = true;
    else if (a === "--tolerance-ms") args.toleranceMs = Number(rest[++i]);
    else if (a === "--no-incremental") args.incremental = false;
    else if (a === "--run-id") args.runId = rest[++i];
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else args.positional.push(a);
  }
  return args;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function cmdMigrate(args: Args): Promise<number> {
  const legacyPath = args.positional[0];
  if (!legacyPath) throw new Error("usage: migrate <legacy.json> [--out dir]");
  const legacy = (await readJson(legacyPath)) as LegacyProject;
  const stateDir = stateDirFor(args.out);
  const state = args.incremental
    ? await loadState(stateDir, legacy.id)
    : emptyState(legacy.id);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = args.runId ?? `${stamp}-${randomUUID().slice(0, 8)}`;
  const result = migrateProject(legacy, state, {
    runId,
    now: new Date().toISOString(),
    incremental: args.incremental,
    tolerance: {
      requireExactCuts: args.exact,
      ...(args.toleranceMs !== undefined
        ? { maxDurationDriftMs: args.toleranceMs }
        : {}),
    },
  });
  await backupOutputs(args.out, stateDir, runId);
  await writeJsonAtomic(join(args.out, OUTPUT_PROJECT), result.project);
  await writeJsonAtomic(join(args.out, OUTPUT_REPORT), result.report);
  await saveState(stateDir, result.state);

  const t = result.report.totals;
  console.log(`run ${runId}`);
  console.log(
    `migrated ${t.clipsMigrated}, reused ${t.clipsReusedFromCache}, ` +
      `approximate ${t.clipsApproximate}, quarantined ${t.clipsQuarantined}`,
  );
  for (const check of result.report.durationChecks) {
    const mark = check.withinTolerance ? "ok" : "DRIFT";
    console.log(
      `  [${mark}] ${check.sequenceId}: legacy ${check.legacyDurationMs.toFixed(3)}ms ` +
        `-> ${check.migratedDurationMs.toFixed(3)}ms ` +
        `(drift ${check.driftMs.toFixed(6)}ms, tol ${check.toleranceMs.toFixed(6)}ms)`,
    );
  }
  for (const q of result.report.quarantined) {
    console.log(`  [quarantined] ${q.sequenceId}/${q.trackId}/${q.clipId}: ${q.reason}`);
  }
  const failed = result.report.durationChecks.some((c) => !c.withinTolerance);
  return failed ? 2 : 0;
}

async function cmdVerify(args: Args): Promise<number> {
  const legacyPath = args.positional[0];
  if (!legacyPath) throw new Error("usage: verify <legacy.json> [--out dir]");
  const legacy = (await readJson(legacyPath)) as LegacyProject;
  const project = (await readJson(join(args.out, OUTPUT_PROJECT))) as ProjectV2;
  const report = (await readJson(join(args.out, OUTPUT_REPORT))) as MigrationReport;
  const result = verifyMigration(legacy, project, report);
  if (result.ok) {
    console.log("verification passed");
    return 0;
  }
  for (const issue of result.issues) {
    console.log(`  [fail] ${issue.scope}: ${issue.message}`);
  }
  return 1;
}

async function cmdRollback(args: Args): Promise<number> {
  const restored = await rollback(args.out, stateDirFor(args.out), args.runId);
  console.log(`restored backup ${restored.runId} into ${args.out}`);
  return 0;
}

async function cmdStatus(args: Args): Promise<number> {
  const stateDir = stateDirFor(args.out);
  const backups = await listBackups(stateDir);
  console.log(`output dir: ${args.out}`);
  console.log(`state dir:  ${stateDir}`);
  console.log(`backups:    ${backups.length}`);
  for (const b of backups) console.log(`  ${b.runId}`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "migrate":
      return cmdMigrate(args);
    case "verify":
      return cmdVerify(args);
    case "rollback":
      return cmdRollback(args);
    case "status":
      return cmdStatus(args);
    default:
      console.log("commands: migrate | verify | rollback | status");
      return args.command === "help" ? 0 : 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
