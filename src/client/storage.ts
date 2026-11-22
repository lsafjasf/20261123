import { normalizeManifest } from "../core/manifest.ts";
import type { BranchManifest } from "../core/types.ts";

const STORAGE_KEY = "firstaid.branch.manifest.v1";

export interface StoredManifest {
  manifest: BranchManifest;
  savedAt: string;
  revision: number;
  origin: "local" | "server" | "demo";
}

interface Envelope {
  schema: 1;
  savedAt: string;
  revision: number;
  manifest: BranchManifest;
}

export function saveLocalManifest(
  manifest: BranchManifest,
  revision: number,
): StoredManifest | null {
  const envelope: Envelope = {
    schema: 1,
    savedAt: new Date().toISOString(),
    revision,
    manifest,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    return {
      manifest,
      savedAt: envelope.savedAt,
      revision,
      origin: "local",
    };
  } catch {
    return null;
  }
}

export function readLocalManifest(): StoredManifest | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as Partial<Envelope>;
    if (!envelope.manifest) return null;
    const manifest = normalizeManifest(envelope.manifest);
    return {
      manifest,
      savedAt:
        typeof envelope.savedAt === "string"
          ? envelope.savedAt
          : new Date().toISOString(),
      revision:
        typeof envelope.revision === "number" ? envelope.revision : 1,
      origin: "local",
    };
  } catch {
    return null;
  }
}

export async function readServerManifest(): Promise<StoredManifest | null> {
  try {
    const response = await fetch("/api/manifest", { cache: "no-store" });
    if (!response.ok) return null;
    const manifest = normalizeManifest(await response.json());
    return {
      manifest,
      savedAt: manifest.updatedAt,
      revision: 1,
      origin: "server",
    };
  } catch {
    return null;
  }
}

export async function readDemoManifest(): Promise<StoredManifest> {
  const response = await fetch("/api/demo-manifest", { cache: "no-store" });
  if (!response.ok) throw new Error(`演示清单载入失败 (${response.status})`);
  const manifest = normalizeManifest(await response.json());
  return {
    manifest,
    savedAt: new Date().toISOString(),
    revision: 1,
    origin: "demo",
  };
}

export async function readBestManifest(): Promise<StoredManifest> {
  const local = readLocalManifest();
  if (local) return local;
  const server = await readServerManifest();
  if (server) return server;
  return readDemoManifest();
}

export async function saveServerManifest(
  manifest: BranchManifest,
): Promise<boolean> {
  try {
    const response = await fetch("/api/manifest", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function parseImportedManifest(text: string): BranchManifest {
  const parsed = JSON.parse(text) as unknown;
  const value =
    parsed &&
    typeof parsed === "object" &&
    "manifest" in parsed &&
    (parsed as { manifest?: unknown }).manifest
      ? (parsed as { manifest: unknown }).manifest
      : parsed;
  return normalizeManifest(value);
}

export function downloadManifest(manifest: BranchManifest): void {
  const blob = new Blob([JSON.stringify(manifest, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${slugify(manifest.title) || "branch-manifest"}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

export function touchManifest(manifest: BranchManifest): BranchManifest {
  return { ...manifest, updatedAt: new Date().toISOString() };
}

function slugify(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .slice(0, 48);
}
