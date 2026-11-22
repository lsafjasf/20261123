import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { probeMp4File, type MediaProbe } from "./media-probe.ts";

export const MEDIA_EXTENSIONS = new Set([
  ".mov", ".mp4", ".m4v", ".mxf", ".avi", ".mkv", ".webm", ".mts", ".m2ts",
  ".wav", ".aif", ".aiff", ".mp3", ".m4a", ".flac", ".aac", ".ogg",
  ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".exr", ".dpx", ".heic"
]);

export const PROJECT_EXTENSIONS = new Set([".fcpxml", ".xml", ".json", ".edl"]);
export const MAX_SCAN_FILES = 200_000;

export interface ScannedFile {
  path: string;
  relPath: string;
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
  media: MediaProbe | null;
}

export interface ScanResult {
  root: string;
  files: ScannedFile[];
  skipped: number;
  elapsedMs: number;
}

const ignoredDirectories = new Set([".git", "node_modules", "exports", ".cache", "$RECYCLE.BIN", "System Volume Information"]);
const hashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

function normalizeExtension(filePath: string): string {
  return extname(filePath).toLowerCase();
}

export function isMediaFile(filePath: string): boolean {
  return MEDIA_EXTENSIONS.has(normalizeExtension(filePath));
}

export function isProjectFile(filePath: string): boolean {
  return PROJECT_EXTENSIONS.has(normalizeExtension(filePath));
}

export function resolveUserPath(input: string, base = process.cwd()): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("路径不能为空");
  const expanded = trimmed.startsWith("~/")
    ? join(process.env.HOME ?? base, trimmed.slice(2))
    : trimmed;
  return resolve(base, expanded);
}

export async function resolveExistingPath(input: string): Promise<string> {
  const resolved = resolveUserPath(input);
  return realpath(resolved);
}

async function probeWav(filePath: string): Promise<MediaProbe | null> {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 44 || header.toString("latin1", 0, 4) !== "RIFF" || header.toString("latin1", 8, 12) !== "WAVE") {
      return null;
    }
    let cursor = 12;
    let channels: number | null = null;
    let sampleRate: number | null = null;
    let byteRate = 0;
    let bits = 0;
    let dataSize = 0;
    while (cursor + 8 <= bytesRead) {
      const id = header.toString("latin1", cursor, cursor + 4);
      const size = header.readUInt32LE(cursor + 4);
      if (id === "fmt " && cursor + 24 <= bytesRead) {
        channels = header.readUInt16LE(cursor + 10);
        sampleRate = header.readUInt32LE(cursor + 12);
        byteRate = header.readUInt32LE(cursor + 16);
        bits = header.readUInt16LE(cursor + 22);
      } else if (id === "data") {
        dataSize = size;
      }
      cursor += 8 + size + (size % 2);
    }
    return {
      container: "wav",
      duration: byteRate > 0 ? Number((dataSize / byteRate).toFixed(3)) : null,
      width: null,
      height: null,
      fps: null,
      videoCodec: null,
      audioCodec: bits === 24 ? "pcm_s24" : bits === 32 ? "pcm_s32" : bits === 16 ? "pcm_s16" : "pcm",
      audioChannels: channels,
      sampleRate
    };
  } finally {
    await handle.close();
  }
}

async function probeImage(filePath: string): Promise<MediaProbe | null> {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    let width: number | null = null;
    let height: number | null = null;
    let codec: string | null = null;
    if (bytesRead > 24 && header.readUInt32BE(0) === 0x89504e47) {
      width = header.readUInt32BE(16);
      height = header.readUInt32BE(20);
      codec = "png";
    } else if (bytesRead > 4 && header[0] === 0xff && header[1] === 0xd8) {
      codec = "jpeg";
      let cursor = 2;
      while (cursor + 9 < bytesRead) {
        if (header[cursor] !== 0xff) { cursor += 1; continue; }
        const marker = header[cursor + 1];
        if (marker >= 0xc0 && marker <= 0xc3 && cursor + 9 < bytesRead) {
          height = header.readUInt16BE(cursor + 5);
          width = header.readUInt16BE(cursor + 7);
          break;
        }
        const length = header.readUInt16BE(cursor + 2);
        if (length < 2) break;
        cursor += 2 + length;
      }
    }
    if (!width || !height) return null;
    return {
      container: "image",
      duration: null,
      width,
      height,
      fps: null,
      videoCodec: codec,
      audioCodec: null,
      audioChannels: null,
      sampleRate: null
    };
  } finally {
    await handle.close();
  }
}

export async function probeMediaFile(filePath: string): Promise<MediaProbe | null> {
  const ext = normalizeExtension(filePath);
  if ([".mp4", ".mov", ".m4v", ".m4a"].includes(ext)) return probeMp4File(filePath);
  if (ext === ".wav") return probeWav(filePath);
  if ([".png", ".jpg", ".jpeg"].includes(ext)) return probeImage(filePath);
  return null;
}

export async function scanMediaRoot(inputRoot: string): Promise<ScanResult> {
  const started = performance.now();
  const root = await resolveExistingPath(inputRoot);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error("素材根目录不是文件夹");
  const basicFiles: Array<Omit<ScannedFile, "media">> = [];
  let skipped = 0;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    for (const entry of entries) {
      if (basicFiles.length >= MAX_SCAN_FILES) { skipped += 1; continue; }
      if (entry.name.startsWith(".") || ignoredDirectories.has(entry.name)) { skipped += 1; continue; }
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !MEDIA_EXTENSIONS.has(normalizeExtension(entry.name))) {
        skipped += 1;
        continue;
      }
      try {
        const info = await stat(fullPath);
        basicFiles.push({
          path: fullPath,
          relPath: relative(root, fullPath).split(sep).join("/"),
          name: basename(fullPath),
          ext: normalizeExtension(fullPath),
          size: info.size,
          mtimeMs: Math.round(info.mtimeMs)
        });
      } catch {
        skipped += 1;
      }
    }
  }

  await walk(root);
  const files = new Array<ScannedFile>(basicFiles.length);
  let cursor = 0;
  async function probeWorker(): Promise<void> {
    while (cursor < basicFiles.length) {
      const index = cursor++;
      const file = basicFiles[index];
      files[index] = { ...file, media: await probeMediaFile(file.path) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, basicFiles.length) }, () => probeWorker()));
  return {
    root,
    files,
    skipped,
    elapsedMs: Math.round(performance.now() - started)
  };
}

export async function sha256File(filePath: string): Promise<string> {
  const info = await stat(filePath);
  const cached = hashCache.get(filePath);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.sha256;
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  const digest = hash.digest("hex");
  hashCache.set(filePath, { size: info.size, mtimeMs: Math.round(info.mtimeMs), sha256: digest });
  return digest;
}

export function mediaMimeType(filePath: string): string {
  const ext = normalizeExtension(filePath);
  const mimes: Record<string, string> = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".aif": "audio/aiff",
    ".aiff": "audio/aiff",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".aac": "audio/aac",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg"
  };
  return mimes[ext] ?? "application/octet-stream";
}
