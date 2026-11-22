/**
 * Rollback support.
 *
 * Every migrate run that is about to overwrite existing outputs first
 * copies them into `.migrate/backups/<runId>/` and appends an entry to
 * `.migrate/journal.jsonl`. `rollback` restores the most recent backup
 * and records the restore in the same journal, so the full history of
 * migrations and rollbacks stays auditable.
 */

import { copyFile, mkdir, readFile, appendFile, readdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

export const OUTPUT_PROJECT = "project.v2.json";
export const OUTPUT_REPORT = "report.json";

export interface JournalEntry {
  readonly at: string;
  readonly runId: string;
  readonly action: "migrate" | "rollback";
  readonly detail: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function appendJournal(stateDir: string, entry: JournalEntry): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await appendFile(join(stateDir, "journal.jsonl"), JSON.stringify(entry) + "\n", "utf8");
}

/** Backs up current outputs (if any) before a run overwrites them. */
export async function backupOutputs(
  outDir: string,
  stateDir: string,
  runId: string,
): Promise<boolean> {
  const projectPath = join(outDir, OUTPUT_PROJECT);
  if (!(await exists(projectPath))) return false;
  const backupDir = join(stateDir, "backups", runId);
  await mkdir(backupDir, { recursive: true });
  await copyFile(projectPath, join(backupDir, OUTPUT_PROJECT));
  const reportPath = join(outDir, OUTPUT_REPORT);
  if (await exists(reportPath)) {
    await copyFile(reportPath, join(backupDir, OUTPUT_REPORT));
  }
  await appendJournal(stateDir, {
    at: new Date().toISOString(),
    runId,
    action: "migrate",
    detail: `backed up previous outputs to ${backupDir}`,
  });
  return true;
}

export interface BackupInfo {
  readonly runId: string;
  readonly dir: string;
}

export async function listBackups(stateDir: string): Promise<BackupInfo[]> {
  const dir = join(stateDir, "backups");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const infos: BackupInfo[] = [];
  for (const name of names.sort()) {
    if (await exists(join(dir, name, OUTPUT_PROJECT))) {
      infos.push({ runId: name, dir: join(dir, name) });
    }
  }
  return infos;
}

/**
 * Restores the most recent backup (or a specific runId). The current
 * outputs are first moved aside into `backups/<runId>.pre-rollback/`
 * so the rollback itself is also reversible.
 */
export async function rollback(
  outDir: string,
  stateDir: string,
  runId?: string,
): Promise<BackupInfo> {
  const backups = await listBackups(stateDir);
  const target = runId ? backups.find((b) => b.runId === runId) : backups[backups.length - 1];
  if (!target) {
    throw new Error(runId ? `no backup with runId "${runId}"` : "no backups to roll back to");
  }
  const stamp = `${target.runId}.pre-rollback`;
  const currentProject = join(outDir, OUTPUT_PROJECT);
  if (await exists(currentProject)) {
    const aside = join(stateDir, "backups", stamp);
    await mkdir(aside, { recursive: true });
    await rename(currentProject, join(aside, OUTPUT_PROJECT));
    const currentReport = join(outDir, OUTPUT_REPORT);
    if (await exists(currentReport)) {
      await rename(currentReport, join(aside, OUTPUT_REPORT));
    }
  }
  await mkdir(outDir, { recursive: true });
  await copyFile(join(target.dir, OUTPUT_PROJECT), join(outDir, OUTPUT_PROJECT));
  if (await exists(join(target.dir, OUTPUT_REPORT))) {
    await copyFile(join(target.dir, OUTPUT_REPORT), join(outDir, OUTPUT_REPORT));
  }
  await appendJournal(stateDir, {
    at: new Date().toISOString(),
    runId: target.runId,
    action: "rollback",
    detail: `restored ${target.dir} into ${outDir}`,
  });
  return target;
}

/** Atomic JSON writer shared by engine and CLI. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}
