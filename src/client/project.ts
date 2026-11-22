import type { AudioFingerprint, MediaRef, ParsedProject, TimelineRef } from "./types.js";

const mediaPattern = /\.(mov|mp4|m4v|mxf|avi|mkv|webm|mts|m2ts|wav|aif|aiff|mp3|m4a|flac|aac|ogg|png|jpe?g|tiff?|exr|dpx|heic)$/i;

function elements(parent: ParentNode): Element[] {
  return Array.from(parent.querySelectorAll("*"));
}

function localName(element: Element): string {
  return element.localName.toLowerCase();
}

function directChildren(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter((child) => localName(child) === name);
}

function directChild(parent: Element, name: string): Element | null {
  return directChildren(parent, name)[0] ?? null;
}

function descendant(parent: Element, name: string): Element | null {
  return elements(parent).find((child) => localName(child) === name) ?? null;
}

function attrAny(element: Element, names: string[]): string | null {
  for (const name of names) {
    const value = element.getAttribute(name);
    if (value?.trim()) return value.trim();
  }
  return null;
}

function textOf(parent: Element, name: string): string | null {
  const found = directChild(parent, name) ?? descendant(parent, name);
  const text = found?.textContent?.trim();
  return text || null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseDuration(value: string | null | undefined, fpsHint?: number | null): number | null {
  if (!value) return null;
  const text = value.trim();
  const rational = /^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)s?$/.exec(text);
  if (rational) {
    const denominator = Number(rational[2]);
    return denominator ? Number((Number(rational[1]) / denominator).toFixed(3)) : null;
  }
  const seconds = /^(-?\d+(?:\.\d+)?)s$/.exec(text);
  if (seconds) return Number(Number(seconds[1]).toFixed(3));
  const timecode = /^(\d+):(\d{2}):(\d{2})[:;](\d{2})$/.exec(text);
  if (timecode) {
    const fps = fpsHint && fpsHint > 0 ? fpsHint : 25;
    return Number((
      Number(timecode[1]) * 3600
      + Number(timecode[2]) * 60
      + Number(timecode[3])
      + Number(timecode[4]) / fps
    ).toFixed(3));
  }
  const plain = Number(text);
  return Number.isFinite(plain) ? plain : null;
}

export function fpsFromFrameDuration(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)s?$/.exec(value.trim());
  if (!match) {
    const seconds = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
    const frameSeconds = seconds ? Number(seconds[1]) : NaN;
    return frameSeconds > 0 ? Number((1 / frameSeconds).toFixed(3)) : null;
  }
  const numerator = Number(match[1]);
  if (!numerator) return null;
  return Number((Number(match[2]) / numerator).toFixed(3));
}

export function filenameFromPath(path: string): string {
  const cleaned = path.split("?")[0].replaceAll("\\", "/");
  const name = cleaned.slice(cleaned.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function decodeMediaPath(value: string): string {
  const text = value.trim();
  if (!/^file:/i.test(text)) {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  }
  try {
    const url = new URL(text);
    let path = decodeURIComponent(url.pathname);
    if (processPlatformWindowsPath(path)) path = path.slice(1);
    return path;
  } catch {
    return text.replace(/^file:\/\//i, "").replace(/^localhost/i, "");
  }
}

function processPlatformWindowsPath(path: string): boolean {
  return /^\/[a-zA-Z]:\//.test(path);
}

function sourcePathFromElement(element: Element): string | null {
  for (const child of elements(element)) {
    if (["media-rep", "pathurl", "path", "src", "url"].includes(localName(child))) {
      const value = attrAny(child, ["src", "pathurl", "path", "url"]) ?? child.textContent?.trim();
      if (value && (mediaPattern.test(value) || /^file:/i.test(value))) return decodeMediaPath(value);
    }
  }
  const direct = attrAny(element, ["src", "pathurl", "path", "url"]);
  if (direct && (mediaPattern.test(direct) || /^file:/i.test(direct))) return decodeMediaPath(direct);
  return null;
}

function audioTechnical(element: Element): { channels: number | null; sampleRate: number | null } {
  let channels: number | null = null;
  let sampleRate: number | null = null;
  for (const node of [element, ...elements(element)]) {
    channels ??= toNumber(attrAny(node, ["audioChannels", "channelCount", "channels", "channelcount"]));
    sampleRate ??= toNumber(attrAny(node, ["sampleRate", "samplerate", "audioSampleRate"]));
  }
  const channelNodes = elements(element).filter((node) => localName(node) === "channel");
  channels ??= channelNodes.length || null;
  return { channels, sampleRate };
}

function timelineRefs(document: Document, assetId: string): TimelineRef[] {
  if (!assetId) return [];
  return elements(document)
    .filter((element) => attrAny(element, ["ref", "idref"]) === assetId)
    .filter((element) => !["asset", "file", "format"].includes(localName(element)))
    .slice(0, 500)
    .map((element, index) => ({
      id: element.getAttribute("id") || `${assetId}-clip-${index + 1}`,
      kind: localName(element),
      offset: attrAny(element, ["offset"]),
      start: attrAny(element, ["start"]),
      duration: attrAny(element, ["duration"])
    }));
}

function projectName(document: Document, fallback: string): string {
  const project = elements(document).find((element) => localName(element) === "project");
  return attrAny(project ?? document.documentElement, ["name", "id"]) ?? fallback;
}

function dedupeRefs(refs: MediaRef[], warnings: string[]): MediaRef[] {
  const result: MediaRef[] = [];
  const byKey = new Map<string, MediaRef>();
  for (const ref of refs) {
    const key = `${ref.assetId}|${ref.sourcePath}|${ref.filename}`.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      const seen = new Set(existing.timelineRefs.map((item) => item.id));
      for (const item of ref.timelineRefs) if (!seen.has(item.id)) existing.timelineRefs.push(item);
      continue;
    }
    byKey.set(key, ref);
    result.push(ref);
  }
  if (result.length === 0) warnings.push("工程中没有识别到带文件路径的素材引用。");
  return result;
}

function parseFcpxml(document: Document, fallbackName: string, warnings: string[]): MediaRef[] {
  const formats = new Map<string, { width: number | null; height: number | null; fps: number | null }>();
  for (const format of elements(document).filter((element) => localName(element) === "format")) {
    const id = format.getAttribute("id");
    if (!id) continue;
    formats.set(id, {
      width: toNumber(format.getAttribute("width")),
      height: toNumber(format.getAttribute("height")),
      fps: fpsFromFrameDuration(format.getAttribute("frameDuration"))
    });
  }
  const refs: MediaRef[] = [];
  for (const asset of elements(document).filter((element) => localName(element) === "asset")) {
    const sourcePath = sourcePathFromElement(asset);
    if (!sourcePath) continue;
    const assetId = asset.getAttribute("id") ?? "";
    const formatId = asset.getAttribute("format") ?? "";
    const format = formats.get(formatId);
    const audio = audioTechnical(asset);
    const refsForAsset = timelineRefs(document, assetId);
    refs.push({
      key: assetId || sourcePath,
      assetId: assetId || filenameFromPath(sourcePath),
      name: asset.getAttribute("name") || filenameFromPath(sourcePath),
      filename: filenameFromPath(sourcePath),
      sourcePath,
      duration: parseDuration(asset.getAttribute("duration"), format?.fps),
      width: format?.width ?? null,
      height: format?.height ?? null,
      fps: format?.fps ?? null,
      videoCodec: null,
      audioCodec: null,
      audioChannels: audio.channels,
      sampleRate: audio.sampleRate,
      timelineRefs: refsForAsset
    });
  }
  if (refs.length === 0) {
    for (const mediaRep of elements(document).filter((element) => localName(element) === "media-rep")) {
      const sourcePath = attrAny(mediaRep, ["src", "pathurl"]);
      if (!sourcePath) continue;
      const decoded = decodeMediaPath(sourcePath);
      refs.push({
        key: decoded,
        assetId: filenameFromPath(decoded),
        name: filenameFromPath(decoded),
        filename: filenameFromPath(decoded),
        sourcePath: decoded,
        duration: null,
        width: null,
        height: null,
        fps: null,
        videoCodec: null,
        audioCodec: null,
        audioChannels: null,
        sampleRate: null,
        timelineRefs: [{ id: filenameFromPath(decoded), kind: "media-rep", offset: null, start: null, duration: null }]
      });
    }
  }
  if (refs.some((ref) => ref.timelineRefs.length === 0)) {
    warnings.push("部分素材资产未在时间线中找到引用，仍保留在映射候选中。");
  }
  return dedupeRefs(refs, warnings);
}

function parseXmeml(document: Document, warnings: string[]): MediaRef[] {
  const files = elements(document).filter((element) => localName(element) === "file");
  const byId = new Map<string, Element>();
  for (const file of files) {
    const id = file.getAttribute("id") ?? sourcePathFromElement(file) ?? "";
    if (!id || byId.has(id)) continue;
    if (sourcePathFromElement(file)) byId.set(id, file);
  }
  const clipItems = elements(document).filter((element) => localName(element) === "clipitem");
  const refs: MediaRef[] = [];
  for (const [fileKey, file] of byId) {
    const sourcePath = sourcePathFromElement(file);
    if (!sourcePath) continue;
    const fileId = file.getAttribute("id");
    const timebase = toNumber(textOf(file, "timebase"));
    const ntsc = /true/i.test(textOf(file, "ntsc") ?? "");
    const fps = timebase ? Number((timebase * (ntsc ? 1000 / 1001 : 1)).toFixed(3)) : null;
    const frameDuration = toNumber(textOf(file, "duration"));
    const width = toNumber(textOf(file, "width"));
    const height = toNumber(textOf(file, "height"));
    const audio = audioTechnical(file);
    const relatedClips = clipItems.filter((item) => {
      const nested = directChild(item, "file");
      if (nested) {
        if (fileId && nested.getAttribute("id") === fileId) return true;
        const nestedPath = sourcePathFromElement(nested);
        if (nestedPath === sourcePath) return true;
      }
      return false;
    });
    refs.push({
      key: fileId || fileKey,
      assetId: fileId || filenameFromPath(sourcePath),
      name: textOf(file, "name") || filenameFromPath(sourcePath),
      filename: filenameFromPath(sourcePath),
      sourcePath,
      duration: frameDuration != null && fps ? Number((frameDuration / fps).toFixed(3)) : null,
      width,
      height,
      fps,
      videoCodec: null,
      audioCodec: null,
      audioChannels: audio.channels,
      sampleRate: audio.sampleRate,
      timelineRefs: relatedClips.slice(0, 500).map((item, index) => ({
        id: item.getAttribute("id") || `${fileId ?? "clip"}-${index + 1}`,
        kind: localName(item),
        offset: textOf(item, "start"),
        start: textOf(item, "in"),
        duration: textOf(item, "duration")
      }))
    });
  }
  return dedupeRefs(refs, warnings);
}

function fingerprintFrom(value: unknown): AudioFingerprint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const fp = value as Record<string, unknown>;
  if (typeof fp.data !== "string") return undefined;
  return {
    v: 1,
    sr: toNumber(fp.sr) ?? 48000,
    bands: toNumber(fp.bands) ?? 8,
    frames: toNumber(fp.frames) ?? 16,
    data: fp.data
  };
}

function parseManifest(text: string, fallbackName: string, warnings: string[]): ParsedProject {
  const value = JSON.parse(text) as Record<string, unknown>;
  const list = [value.media, value.assets, value.refs, value.clips]
    .find((candidate) => Array.isArray(candidate)) as unknown[] | undefined;
  if (!list) throw new Error("JSON 清单需要 media / assets / refs / clips 数组");
  const refs: MediaRef[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const technical = (item.technical && typeof item.technical === "object" ? item.technical : item) as Record<string, unknown>;
    const sourcePathRaw = String(item.sourcePath ?? item.path ?? item.src ?? item.oldPath ?? item.mediaPath ?? "");
    if (!sourcePathRaw) continue;
    const sourcePath = decodeMediaPath(sourcePathRaw);
    const filename = filenameFromPath(sourcePath);
    const timelineRaw = Array.isArray(item.timelineRefs) ? item.timelineRefs : [];
    refs.push({
      key: String(item.id ?? item.assetId ?? sourcePath),
      assetId: String(item.assetId ?? item.id ?? filename),
      name: String(item.name ?? filename),
      filename,
      sourcePath,
      duration: toNumber(technical.duration),
      width: toNumber(technical.width),
      height: toNumber(technical.height),
      fps: toNumber(technical.fps),
      videoCodec: technical.videoCodec ? String(technical.videoCodec) : null,
      audioCodec: technical.audioCodec ? String(technical.audioCodec) : null,
      audioChannels: toNumber(technical.audioChannels),
      sampleRate: toNumber(technical.sampleRate),
      timelineRefs: timelineRaw.map((entry, index) => {
        if (typeof entry === "string") return { id: entry, kind: "clip", offset: null, start: null, duration: null };
        const ref = (entry ?? {}) as Record<string, unknown>;
        return {
          id: String(ref.id ?? `${filename}-${index + 1}`),
          kind: String(ref.kind ?? "clip"),
          offset: ref.offset == null ? null : String(ref.offset),
          start: ref.start == null ? null : String(ref.start),
          duration: ref.duration == null ? null : String(ref.duration)
        };
      }),
      sha256: typeof item.sha256 === "string" ? item.sha256 : typeof item.hash === "string" ? item.hash : undefined,
      visualHash: typeof item.visualHash === "string" ? item.visualHash : undefined,
      audioFingerprint: fingerprintFrom(item.audioFingerprint)
    });
  }
  return {
    name: String(value.name ?? fallbackName),
    path: "",
    format: "manifest",
    refs: dedupeRefs(refs, warnings),
    warnings
  };
}

export function parseProject(text: string, filePath: string): ParsedProject {
  const fileName = filenameFromPath(filePath);
  const stem = fileName.replace(/\.[^.]+$/, "");
  const warnings: string[] = [];
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = parseManifest(trimmed, stem, warnings);
    return { ...parsed, path: filePath };
  }
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("XML 工程解析失败，请确认文件未损坏");
  const rootName = localName(document.documentElement);
  if (rootName === "edl") {
    throw new Error("EDL 只记录卷名，不包含素材路径；请改用 FCPXML 或 Premiere XML。");
  }
  const format = rootName === "fcpxml" ? "fcpxml" : rootName === "xmeml" ? "xmeml" : "generic";
  const refs = format === "fcpxml"
    ? parseFcpxml(document, stem, warnings)
    : format === "xmeml"
      ? parseXmeml(document, warnings)
      : parseFcpxml(document, stem, warnings);
  return {
    name: projectName(document, stem),
    path: filePath,
    format,
    refs,
    warnings
  };
}
