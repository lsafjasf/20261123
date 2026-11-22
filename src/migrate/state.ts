/**
 * Incremental migration state.
 *
 * `.migrate/state.json` maps each clip (sequence/track/clip key) to the
 * hash of its migration input (legacy clip + referenced media + project
 * grids + tolerance) and the resulting ClipV2. A clip whose input hash
 * is unchanged is reused verbatim — only new or edited clips are
 * re-converted, which makes re-runs cheap and safe to interrupt.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ClipV2 } from "../model/schema.ts";

export interface ClipStateEntry {
  readonly inputHash: string;
  readonly status: "migrated" | "quarantined";
  /** Present when status === "migrated"; reused on incremental runs. */
  readonly result?: ClipV2;
  readonly reason?: string;
  readonly runId: string;
}

export interface MigrationState {
  readonly version: 1;
  readonly projectId: string;
  clips: Record<string, ClipStateEntry>;
  lastRunId?: string;
}

export function emptyState(projectId: string): MigrationState {
  return { version: 1, projectId, clips: {} };
}

export async function loadState(dir: string, projectId: string): Promise<MigrationState> {
  try {
    const raw = await readFile(join(dir, "state.json"), "utf8");
    const parsed = JSON.parse(raw) as MigrationState;
    if (parsed.version !== 1 || parsed.projectId !== projectId) {
      return emptyState(projectId);
    }
    return parsed;
  } catch {
    return emptyState(projectId);
  }
}

/** Atomic write: temp file + rename, so a crash never corrupts state. */
export async function saveState(dir: string, state: MigrationState): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, "state.json");
  const tmp = join(dir, `state.json.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, target);
}

export function clipKey(sequenceId: string, trackId: string, clipId: string): string {
  return `${sequenceId}/${trackId}/${clipId}`;
}

export function stateDirFor(outDir: string): string {
  return join(dirname(outDir.replace(/[/\\]+$/, "") || "."), ".migrate");
}
